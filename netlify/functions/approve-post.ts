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
import { aiAssistants, auditLogs, contentAssets, contentRules, postIdeaSuggestions, scheduledPosts, scheduledPostAssets, systemConnections } from '../../db/schema';
import { isBakedFor, renderableOverlays } from '../../src/lib/post-render';
import { recordPostedAssets } from '../../src/utils/pexels';
import { resolvePostImage, resolvePostVideo } from '../../src/utils/social-publish';
import { resolvePostingSchedule, computeScheduleSlots, intervalHoursFor } from '../../src/config/posting-cadence';
import { formatBlockedReason, postFormatSpec } from '../../src/config/post-formats';
import { loadAssetMetrics, validateAgainstFormat } from '../../src/utils/format-router';
import { platformFormat } from '../../src/config/platform-formats';
import { needsVideoRender, renderableAudio } from '../../src/lib/audio-overlays';
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

    // A format we cannot actually publish must never enter the queue. The picker deliberately shows
    // every format the platform offers — including ones we haven't built and ones that can never be
    // a scheduled post (a Space, a Live, a DM broadcast) — so this is the gate that stops an
    // approved post from failing later. Legacy posts carry no format_key and are never blocked.
    const formatBlock = formatBlockedReason((post as any).formatKey);
    if (formatBlock) {
        return {
            statusCode: 422,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: formatBlock,
                code: 'FORMAT_NOT_SCHEDULABLE',
                formatKey: (post as any).formatKey,
            }),
        };
    }

    // Slide-count bounds for the chosen format. A carousel needs at least two slides to BE a
    // carousel, and every platform caps how many it takes — both are publish-time rejections, so
    // catching them here keeps a half-built carousel out of the queue rather than letting it fail
    // against the API with a message written for developers.
    const fmtSpec = postFormatSpec((post as any).formatKey);
    if (fmtSpec) {
        const slideCount = Array.isArray(post.contentAssetIds) ? (post.contentAssetIds as number[]).length : 0;
        if (slideCount < fmtSpec.minItems) {
            return {
                statusCode: 422,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: `${fmtSpec.label} needs at least ${fmtSpec.minItems} ${fmtSpec.minItems === 1 ? 'item' : 'items'} — this post has ${slideCount}.`,
                    code: 'TOO_FEW_ITEMS',
                }),
            };
        }
        if (slideCount > fmtSpec.maxItems) {
            return {
                statusCode: 422,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: `${fmtSpec.label} takes at most ${fmtSpec.maxItems} — this post has ${slideCount}.`,
                    code: 'TOO_MANY_ITEMS',
                }),
            };
        }
    }

    // Length. The gates above check WHICH format and HOW MANY items; none of them could ever check
    // how LONG the video is, because until content_assets.duration_s existed there was nothing to
    // check against. YouTube refuses a Short over three minutes outright, so this is the difference
    // between a refusal here with a way out, and an upload that fails at 09:00 on Monday.
    //
    // Ratio is deliberately NOT gated: platforms crop, and blocking an approval over a shape the
    // network would happily letterbox would refuse work that publishes perfectly well.
    //
    // Silent on unknown durations — a legacy asset must never be refused for failing a check that
    // could not be run. Best-effort: a failure to read the metrics leaves the post approvable.
    const routableAssets = await loadAssetMetrics(db, post.contentAssetIds).catch(() => []);
    const tooLong = validateAgainstFormat((post as any).formatKey, routableAssets);
    if (tooLong) {
        return {
            statusCode: 422,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: tooLong.reason,
                code: tooLong.code,
                formatKey: (post as any).formatKey,
                ...(tooLong.suggestion ? { suggestedFormatKey: tooLong.suggestion.key } : {}),
            }),
        };
    }

    // Will this post go out as a VIDEO, and can this platform's driver actually send one?
    //
    // Sound makes this reachable in a way it never was before: audio on a photo is rendered into an
    // mp4 at approval (needsVideoRender), so a post that looked like a picture publishes as a video.
    // publishFacebook/publishX/publishLinkedIn/publishThreads all take an image or nothing, and
    // resolvePostImage skips a video asset — so the post went out as a bare caption with the media
    // silently dropped and no failure recorded anywhere. Refusing here is the difference between
    // "we can't do that yet" and a post the user thinks succeeded.
    const willBeVideo = needsVideoRender({
        hasVideo: (await resolvePostVideo(db, post.contentAssetIds).catch(() => null)) !== null,
        textOverlays: 0,   // text alone never CHANGES the media kind — it burns into what is there
        audioOverlays: renderableAudio((post as any).audioOverlays).length,
    });
    if (willBeVideo && post.platform && !platformFormat(post.platform).canPublishVideo) {
        const label = platformFormat(post.platform).label;
        return {
            statusCode: 422,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: `This post will publish as a video (sound has to be rendered in), and we can’t send video to ${label} yet. Remove the sound, or send this one to Instagram or YouTube.`,
                code: 'VIDEO_NOT_PUBLISHABLE',
                platform: post.platform,
            }),
        };
    }

    // Instagram cannot publish a text-only post — it needs MEDIA. Enforce server-side so a draft
    // can't be approved/scheduled/published for Instagram without any (the client guards this too).
    //
    // Video counts. publish-instagram has always built a REELS container from a video post
    // (media_type REELS + video_url), so demanding an image specifically rejected posts the
    // publisher was perfectly capable of sending — which is what blocked approving any Instagram
    // video, including the Phase 4 text-overlay renders.
    if (post.platform === 'instagram') {
        const media = await resolvePostImage(db, post.contentAssetIds).catch(() => null)
            ?? await resolvePostVideo(db, post.contentAssetIds).catch(() => null);
        if (!media) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Instagram requires an image or a video. Add media to this post before approving.' }) };
        }
    }

    // ── The reviewer's text must actually be ON the picture ─────────────────────────────────────
    // A photo's overlays are burned in by the BROWSER (trigger-post-render.ts explains why: the
    // canvas has the fonts). That made the guarantee "an un-overlaid image never publishes" a purely
    // client-side one — nothing here checked it, and the publishers only gate on render_status, which
    // is the video path. A client that skipped the bake for any reason published the bare photo, with
    // the reviewer's words missing and nothing recorded anywhere.
    //
    // Video is exempt: its overlays are rendered on Lambda and gated by render_status instead.
    //
    // This is a 409 with a code rather than a flat refusal because the client can FIX it — it bakes
    // and retries, so in the normal case nobody ever sees this. It only becomes a visible error when
    // the bake itself genuinely fails, which is worth telling someone about.
    if (!willBeVideo && renderableOverlays(post.imageOverlays).length > 0) {
        // The attached asset, junction table first with the deprecated array as the migration
        // fallback — the same resolution order as get-post-image and resolveOverlayVideoBase.
        const [joined] = await db
            .select({ id: contentAssets.id, renderParams: contentAssets.renderParams })
            .from(scheduledPostAssets)
            .innerJoin(contentAssets, eq(contentAssets.id, scheduledPostAssets.contentAssetId))
            .where(eq(scheduledPostAssets.scheduledPostId, postId))
            .orderBy(scheduledPostAssets.position)
            .limit(1);
        let attached = joined ?? null;
        if (!attached) {
            const legacy = (post.contentAssetIds as number[] | null)?.[0];
            if (legacy) {
                const [row] = await db
                    .select({ id: contentAssets.id, renderParams: contentAssets.renderParams })
                    .from(contentAssets).where(eq(contentAssets.id, legacy)).limit(1);
                attached = row ?? null;
            }
        }
        if (!attached || !isBakedFor(attached.renderParams, postId, post.imageOverlays)) {
            return {
                statusCode: 409,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'The text on this image has not been applied yet.',
                    code: 'OVERLAYS_NOT_BAKED',
                }),
            };
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
