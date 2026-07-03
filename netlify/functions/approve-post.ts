// netlify/functions/approve-post.ts
// US-SMM-2.2.1: One-click post approval with past-schedule detection and audit logging.
//
// POST /.netlify/functions/approve-post
//   Auth: aura_session cookie
//   Body: { postId: number, action?: 'approve' | 'publish_now' | 'reschedule', rescheduleAt?: string }
//
// Returns:
//   200 { approved: true, post, confirmation }         — success
//   409 { pastSchedule: true, scheduledFor, platform } — scheduled time in past, awaiting user action

import { Handler } from '@netlify/functions';
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { aiAssistants, auditLogs, postIdeaSuggestions, scheduledPosts } from '../../db/schema';
import { recordPostedAssets } from '../../src/utils/pexels';
import { resolvePostImage } from '../../src/utils/social-publish';
import { resolvePostingSchedule, computeScheduleSlots } from '../../src/config/posting-cadence';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

/**
 * Optimal-slot scheduling on approval: the assistant "picks the task up and schedules it" into the
 * next free slot of its posting cadence rather than reusing the draft's (possibly stale/past) date.
 * Mirrors the slot maths in src/utils/schedule-gap-fill.ts. Returns null for on-demand cadences
 * (no slots) so the caller can fall back to the draft's own publishDate.
 */
async function pickOptimalSlot(
    db: ReturnType<typeof getDb>,
    assistant: { id: number; onboardingContext: unknown; draftHorizonDays: number | null },
    postId: number,
    now: Date,
): Promise<Date | null> {
    const ctx = (assistant.onboardingContext as Record<string, unknown>) ?? {};
    const schedule = resolvePostingSchedule(ctx);
    const slots = computeScheduleSlots({ schedule, horizonDays: assistant.draftHorizonDays ?? 7, now });
    if (!slots.length) return null;

    const windowEnd = slots[slots.length - 1];
    const taken = await db
        .select({ publishDate: scheduledPosts.publishDate })
        .from(scheduledPosts)
        .where(and(
            eq(scheduledPosts.assistantId, assistant.id),
            ne(scheduledPosts.id, postId),
            gte(scheduledPosts.publishDate, now),
            lte(scheduledPosts.publishDate, windowEnd),
            sql`status IN ('draft','pending_approval','in_review','approved','scheduled')`,
        ));
    const takenMs = new Set(taken.map(r => new Date(r.publishDate).getTime()));
    // Earliest slot not already occupied by another active post; if every slot is taken, use the first.
    return slots.find(s => !takenMs.has(s.getTime())) ?? slots[0];
}

function getUserId(event: any): number | null {
    try {
        const cookie = event.headers.cookie || '';
        const match  = cookie.match(/aura_session=([^;]+)/);
        if (!match) return null;
        const payload: any = jwt.verify(match[1], JWT_SECRET);
        return payload.userId ?? null;
    } catch {
        return null;
    }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    const userId = getUserId(event);
    if (!userId) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorised.' }) };
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { postId, action = 'approve', rescheduleAt, rejectionReason } = body;
    if (!postId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    }

    const db  = getDb();
    const now = new Date();

    // ── Reject ─────────────────────────────────────────────────────────────────
    if (action === 'reject') {
        if (!rejectionReason?.trim()) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rejectionReason is required when rejecting.' }) };
        }
        const [rejected] = await db.update(scheduledPosts)
            .set({ status: 'rejected', rejectedAt: now, rejectionReason: rejectionReason.trim(), updatedAt: now })
            .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
            .returning();
        if (!rejected) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
        // If this draft was built from a user-suggested idea, the idea has NOT been delivered —
        // return it to the pool so it can be woven into a fresh draft (best-effort, never blocks).
        await db.update(postIdeaSuggestions)
            .set({ status: 'pending', usedPostId: null, usedAt: null })
            .where(and(eq(postIdeaSuggestions.usedPostId, postId), eq(postIdeaSuggestions.status, 'in_review')))
            .catch(() => {});
        await db.insert(auditLogs).values({
            userId,
            actionType: 'POST_REJECTED',
            resourceType: 'scheduled_posts',
            resourceId: String(postId),
            newState: { rejectionReason: rejectionReason.trim(), rejectedAt: now.toISOString() },
        }).catch(() => {});
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rejected: true, post: rejected }),
        };
    }

    // Load post and verify ownership (via userId on the post)
    const [post] = await db
        .select()
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
        .limit(1);

    if (!post) {
        return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
    }

    if (!['draft', 'in_review', 'pending_approval'].includes(post.status)) {
        return {
            statusCode: 409,
            body: JSON.stringify({ error: `Post is already in '${post.status}' state and cannot be approved.` }),
        };
    }

    // Instagram cannot publish a text-only post — an image is mandatory. Enforce server-side so a draft
    // can't be approved/scheduled/published for Instagram without one (the client guards this too).
    if (post.platform === 'instagram') {
        const image = await resolvePostImage(db, post.contentAssetIds).catch(() => null);
        if (!image) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Instagram requires an image. Add one to this post before approving.' }) };
        }
    }

    const scheduledFor = new Date(post.publishDate);

    // ── Determine new publish date ─────────────────────────────────────────────
    let newPublishDate = scheduledFor;
    let assistantName: string | null = null;

    if (action === 'publish_now') {
        newPublishDate = now;
    } else if (action === 'reschedule') {
        if (!rescheduleAt) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rescheduleAt is required for the reschedule action.' }) };
        }
        const parsed = new Date(rescheduleAt);
        if (isNaN(parsed.getTime())) {
            return { statusCode: 400, body: JSON.stringify({ error: 'rescheduleAt is not a valid date.' }) };
        }
        if (parsed <= now) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Rescheduled time must be in the future.' }) };
        }
        newPublishDate = parsed;
    } else if (action === 'approve') {
        // The assistant "picks the task up and schedules it": land the post in the next free slot of
        // its posting cadence. Falls back to the draft's own future date for on-demand assistants.
        let optimal: Date | null = null;
        if (post.assistantId) {
            const [assistant] = await db
                .select({
                    id:                aiAssistants.id,
                    name:              aiAssistants.name,
                    onboardingContext: aiAssistants.onboardingContext,
                    draftHorizonDays:  aiAssistants.draftHorizonDays,
                })
                .from(aiAssistants)
                .where(eq(aiAssistants.id, post.assistantId))
                .limit(1);
            if (assistant) {
                assistantName = assistant.name;
                optimal = await pickOptimalSlot(db, assistant, postId, now).catch(() => null);
            }
        }
        if (optimal) {
            newPublishDate = optimal;
        } else if (scheduledFor <= now) {
            // No cadence slots (on-demand) and the draft's own time has passed — ask the user.
            return {
                statusCode: 409,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pastSchedule: true,
                    scheduledFor: scheduledFor.toISOString(),
                    platform: post.platform,
                    message: `The scheduled time for this post (${scheduledFor.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}) has passed. Would you like to reschedule or publish now?`,
                }),
            };
        }
        // else: keep the draft's future date
    }

    // ── Approve ────────────────────────────────────────────────────────────────
    // Approval lands the post directly in the publisher's state machine as 'scheduled'
    // — the publish-queue index + cron consume status='scheduled' AND publish_date <= now()
    // (schema.ts: scheduled_posts_publish_queue_idx). For publish_now the date is already
    // set to now; a future date schedules it. (Approver attribution is in the audit log.)
    const [updated] = await db.update(scheduledPosts)
        .set({
            status:      'scheduled',
            publishDate: newPublishDate,
            updatedAt:   now,
        })
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.userId, userId)))
        .returning();

    // US2 AC2.5: a scheduled post commits its chosen Pexels image — burn the asset ID so it
    // can never be reused across the workspace. Idempotent; best-effort (never blocks approval).
    if (post.organisationId) {
        await recordPostedAssets(db, { orgId: post.organisationId, userId, scheduledPostId: postId })
            .catch(err => console.warn(`[approve-post] recordPostedAssets failed for post ${postId}:`, err?.message || err));
    }

    // Close the loop on a user-suggested idea: approving the draft it produced marks the idea
    // 'delivered' (with delivered_at), keeping the link to the post. Surfaced in the Review Queue
    // Ideas tab so the suggester sees their idea went live. Best-effort — never blocks approval.
    await db.update(postIdeaSuggestions)
        .set({ status: 'delivered', deliveredAt: now })
        .where(and(eq(postIdeaSuggestions.usedPostId, postId), sql`status IN ('in_review','used')`))
        .catch(() => {});

    // ── Audit log: userId, postId, approvedAt, scheduledFor ───────────────────
    await db.insert(auditLogs).values({
        userId,
        actionType:   'POST_APPROVED',
        resourceType: 'scheduled_posts',
        resourceId:   String(postId),
        newState: {
            action,
            approvedAt:   now.toISOString(),
            scheduledFor: newPublishDate.toISOString(),
            platform:     post.platform,
        },
    }).catch(() => {});

    // ── Build confirmation message ─────────────────────────────────────────────
    const dateLabel = newPublishDate.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const scheduler = assistantName || 'Your assistant';
    const confirmation = action === 'publish_now'
        ? `Post approved and queued to publish now on ${post.platform}.`
        : `Post approved — ${scheduler} scheduled it for ${dateLabel} on ${post.platform}.`;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true, post: updated, confirmation }),
    };
};
