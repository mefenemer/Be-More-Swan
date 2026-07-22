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
import { aiAssistants, auditLogs, contentRules, postIdeaSuggestions, scheduledPosts, systemConnections } from '../../db/schema';
import { recordPostedAssets } from '../../src/utils/pexels';
import { resolvePostImage } from '../../src/utils/social-publish';
import { resolvePostingSchedule, computeScheduleSlots, intervalHoursFor } from '../../src/config/posting-cadence';
import { readCachedReview, openWarnings } from '../../src/utils/post-quality-review';
import { withLambda } from '@netlify/aws-lambda-compat';

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
    const horizonDays = assistant.draftHorizonDays ?? 7;

    // Look BEYOND the draft horizon when hunting for a free slot. The horizon governs how far ahead
    // the assistant pre-drafts; it must not cap where an approved post may land, or a full horizon
    // leaves nowhere to put this post. computeScheduleSlots caps horizon at 30 days internally.
    const searchDays = Math.min(30, Math.max(horizonDays, horizonDays * 3, 14));
    const slots = computeScheduleSlots({ schedule, horizonDays: searchDays, now });
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
    // A cross-post group legitimately shares one instant, so "taken" means "has at least one active
    // post on it" — we only need to know whether the slot is free, not how many sit there.
    const takenMs = new Set(taken.map(r => new Date(r.publishDate).getTime()));
    const free = slots.find(s => !takenMs.has(s.getTime()));
    if (free) return free;

    // Every slot in the search window is occupied. Returning slots[0] here (the old behaviour) piled
    // every approval onto the same instant — approving a batch against a full calendar stacked five
    // posts on one 09:00. Extend past the last slot by the cadence interval instead, so a busy
    // calendar pushes work forward in cadence rather than collapsing it onto the front.
    const stepHours = intervalHoursFor(schedule.frequency) ?? 24;
    let candidate = new Date(slots[slots.length - 1].getTime() + stepHours * 3600 * 1000);
    // Don't land on top of something already out past the window.
    for (let guard = 0; guard < 60 && takenMs.has(candidate.getTime()); guard++) {
        candidate = new Date(candidate.getTime() + stepHours * 3600 * 1000);
    }
    return candidate;
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

export default withLambda(async (event) => {
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

    // acknowledgeWarnings: the user has SEEN the compliance warnings and chosen to proceed. Set by
    // the confirm step the 409 below drives; never defaulted true.
    const { postId, action = 'approve', rescheduleAt, rejectionReason, acknowledgeWarnings = false } = body;
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
        // The rejection reason becomes part of the assistant's memory: save it as a Content Rule so
        // future drafts (see src/utils/blueprint.ts) avoid the same mistake. Best-effort, never blocks.
        if (rejected.assistantId && rejected.organisationId) {
            await db.insert(contentRules).values({
                assistantId: rejected.assistantId,
                workspaceId: rejected.organisationId,
                ruleText: rejectionReason.trim(),
                platform: rejected.platform || null,
                createdByUserId: userId,
                isActive: true,
                origin: 'rejection_feedback',
                originPostId: postId,
            }).catch(() => {});
        }
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

    // Approving/scheduling commits the post to the publisher, which needs a live connection for the
    // post's platform. Setup no longer requires connecting accounts, so this is THE gate: without a
    // healthy connection the publish would just fail later, so refuse now with a code the client
    // turns into a "connect this platform" prompt. (Publisher matches serviceName === platform.)
    if (post.platform) {
        const connScope = post.organisationId
            ? eq(systemConnections.organisationId, post.organisationId)
            : eq(systemConnections.userId, userId);
        const [conn] = await db.select({ id: systemConnections.id }).from(systemConnections)
            .where(and(
                connScope,
                eq(systemConnections.serviceName, post.platform),
                eq(systemConnections.isActive, true),
                eq(systemConnections.status, 'active'),
            ))
            .limit(1);
        if (!conn) {
            const label = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X' }[post.platform] || post.platform;
            return {
                statusCode: 422,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: `Connect your ${label} account before this post can be scheduled or published.`,
                    code: 'PLATFORM_NOT_CONNECTED',
                    platform: post.platform,
                }),
            };
        }
    }

    // ── Compliance gate ────────────────────────────────────────────────────────
    // The "Approval blocked — resolve compliance warnings before publishing" banner used to be
    // client-side ONLY, and only in calendar.js (it disabled #btn-panel-approve). Nothing enforced
    // it here, so the very same post could be approved in one click from the Review Queue — the
    // primary approval surface, which did not even run the review. The gate is now real.
    //
    // Deliberately an ACKNOWLEDGEMENT, not a hard block. The warnings come from an LLM and are
    // frequently things only a human can settle ("verify this price is the current lowest tier"),
    // so a hard block with no override would strand legitimate posts on a false positive. The user
    // must see the warnings and consciously accept them; the acceptance is recorded in the audit
    // log below, which is what makes this defensible after the fact.
    //
    // Gates on OPEN warnings only. A warning the approver already settled individually — a citation
    // supplied, or a written reason it doesn't apply (resolve-compliance-warning.ts) — has been
    // answered on the record and must not re-prompt. Blanket acknowledgement is the last resort for
    // the ones nobody could settle, not the only door out.
    const review = readCachedReview((post as any).qualityReview, post.caption);
    const unresolved = openWarnings(review);
    if (unresolved.length > 0 && !acknowledgeWarnings) {
        return {
            statusCode: 409,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                complianceBlocked: true,
                code: 'COMPLIANCE_WARNINGS',
                warnings: unresolved,
                message: 'This post has unresolved compliance warnings. Review them, then confirm you want to approve anyway.',
            }),
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
            // Record WHICH warnings were overridden, not just that an override happened. If a claim
            // later turns out to be a problem, this is the evidence of what the approver was shown
            // and accepted. Absent on a clean approval.
            //
            // Only the warnings that were still OPEN count as an override — the individually
            // settled ones already have their own audit entries carrying the citation or the
            // reason, and folding them in here would misreport a sourced claim as a click-through.
            ...(unresolved.length > 0 ? {
                complianceOverride: true,
                acknowledgedWarnings: unresolved,
                resolvedWarnings: review?.dispositions ?? undefined,
                brandVoiceScore: review!.brandVoiceScore,
            } : {}),
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
});
