// netlify/functions/reject-post.ts
// US-SMM-2.2.2: Structured post rejection with optional Content Rules Library entry.
//
// Rejecting is not just a delete: both callers (the voice-feedback panel and the tuning session's
// "Revise post") tell the user a corrected draft is coming. So this endpoint (a) marks the post
// rejected, (b) optionally saves the feedback as a Content Rule and recompiles the blueprint so the
// rule reaches generation, and (c) enqueues a regeneration job whose draft lands back in the Review
// Queue as pending_approval, badged "Revised". (c) is best-effort — the rejection always stands.
//
// Compare request-post-changes.ts, which is the same pipeline for a post the user wants rewritten
// WITHOUT recording it as rejected (it cancels the original instead).
//
// POST /.netlify/functions/reject-post
//   Body: {
//     postId: number,
//     feedbackText: string,           // required — what is wrong with this post
//     applyAsRule: boolean,           // save feedback as a rule for all future drafts
//     platform?: string               // scope the rule to one platform (null = all)
//     voiceFeedback?: boolean         // came from the voice panel — send the "revising…" notice
//   }
//   Returns: { success, revisionJobId?, revisionQueued, revisionSkippedReason?, ruleId?, ruleText? }
//   Auth: aura_session

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, desc, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { getDb } from '../../db/client';
import { scheduledPosts, contentRules, users, aiAssistants, aiBlueprints, contentGenerationJobs } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { assembleBlueprint } from '../../src/utils/blueprint';
import { releasePostMedia } from '../../src/utils/release-post-media';
import { triggerContentDrain } from '../../src/utils/trigger-drain';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Cap on the feedback we paste into the regeneration prompt (mirrors request-post-changes.ts). */
const MAX_CONTEXT = 500;

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    let orgId: number | undefined;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; organisationId?: number };
        userId = decoded.userId;
        orgId = decoded.organisationId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    let body: { postId?: number; feedbackText?: string; applyAsRule?: boolean; platform?: string; voiceFeedback?: boolean };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { postId, feedbackText, applyAsRule = false, platform, voiceFeedback = false } = body;

    if (!postId || typeof postId !== 'number') {
        return { statusCode: 400, body: JSON.stringify({ error: 'postId is required.' }) };
    }
    if (!feedbackText || feedbackText.trim().length === 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'feedbackText is required.' }) };
    }

    const db = getDb();

    // Load the post and verify ownership
    const [post] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId));
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };
    if (post.organisationId !== orgId && post.userId !== userId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Access denied.' }) };
    }
    if (post.status === 'rejected' || post.status === 'published' || post.status === 'cancelled') {
        return { statusCode: 409, body: JSON.stringify({ error: `Cannot reject a post with status '${post.status}'.` }) };
    }

    const now = new Date();

    // What the reviewer said. Used three times: as the post's rejection reason, optionally as a
    // Content Rule, and as the context the regeneration is redrafted against.
    const feedback = feedbackText.trim();

    // Mark the post as rejected
    await db.update(scheduledPosts)
        .set({ status: 'rejected', rejectionReason: feedback, rejectedAt: now, updatedAt: now })
        .where(eq(scheduledPosts.id, postId));

    // Optionally save feedback as a Content Rule
    let ruleId: number | undefined;
    if (applyAsRule && post.assistantId && post.organisationId) {
        const assistantId = post.assistantId;
        const [rule] = await db.insert(contentRules).values({
            assistantId,
            workspaceId: post.organisationId,
            ruleText: feedback,
            platform: platform || null,
            createdByUserId: userId,
            isActive: true,
            origin: 'rejection_feedback',
            originPostId: postId,
        }).returning({ id: contentRules.id });
        ruleId = rule?.id;

        // Recompile the blueprint so the rule actually reaches generation. process-content-jobs reads
        // the COMPILED blueprint snapshot, not live content_rules — without this, rejection feedback
        // sits dormant until some unrelated recompile happens. Best-effort (data-assembly, no LLM); a
        // failure must never fail the rejection.
        try {
            await assembleBlueprint(assistantId, `user-${userId}`, 'rejection_feedback_rule');
        } catch (e) {
            console.warn('[reject-post] blueprint recompile after rule save failed (rule still saved):', e instanceof Error ? e.message : e);
        }
    }

    // ── Queue the revision ───────────────────────────────────────────────────────────────────────
    //
    // Both callers of this endpoint promise the user a rewrite: voice feedback says "I'm rewriting
    // the post with your feedback", and the tuning session's Revise button toasts "Revised draft on
    // the way — check your Review". The rule compiled into the blueprint just above exists for the
    // same reason: to steer the redraft that follows.
    //
    // This used to INSERT a clone of the rejected post at status 'draft', commented "for AI
    // regeneration". No AI ever saw it. Nothing consumed `is_revised`/`revised_from_post_id` beyond
    // two badges, no surface reads 'draft' (the Review Queue's columns are pending_approval /
    // approved / scheduled / published / rejected, matched on exact status equality; the Calendar
    // excludes it via SCHEDULE_INACTIVE_STATUSES), and archive-cleanup only hard-deletes 'rejected'.
    // So every rejection silently accumulated an unreadable row holding the very caption the user
    // had just rejected, and the promised revision never happened.
    //
    // Instead: enqueue a real generation job on the same contentGenerationJobs + process-content-jobs
    // pipeline request-post-changes.ts uses. The redraft is produced against the current blueprint
    // (including any rule this rejection just compiled into it) plus the feedback as context, and
    // lands in the Review Queue as pending_approval, stamped isRevised via the job's
    // revised_from_post_id (db/reject-regeneration.sql).
    //
    // Best-effort by construction: the rejection itself is already committed and must stand even if
    // nothing can be regenerated (no assistant, no blueprint, queue full). The response says which
    // happened rather than pretending.
    let revisionJobId: string | undefined;
    let revisionSkipped: string | undefined;

    if (!post.assistantId || !post.organisationId) {
        revisionSkipped = 'no_assistant';
    } else {
        try {
            // Prefer the blueprint this draft was built from, else the assistant's latest.
            let blueprintId = post.blueprintId ?? null;
            if (!blueprintId) {
                const [bp] = await db
                    .select({ id: aiBlueprints.id })
                    .from(aiBlueprints)
                    .where(and(
                        eq(aiBlueprints.assistantId, post.assistantId),
                        eq(aiBlueprints.organisationId, post.organisationId),
                    ))
                    .orderBy(desc(aiBlueprints.compiledAt))
                    .limit(1);
                blueprintId = bp?.id ?? null;
            }

            if (!blueprintId) {
                revisionSkipped = 'no_blueprint';
            } else {
                // Per-org concurrency guard (mirrors generate-post.ts / request-post-changes.ts).
                const [{ jobCount }] = await db.execute<{ jobCount: number }>(
                    `SELECT COUNT(*)::int AS "jobCount" FROM content_generation_jobs
                     WHERE organisation_id = ${post.organisationId} AND status IN ('queued','processing')`
                );
                if (jobCount >= 50) {
                    revisionSkipped = 'queue_full';
                } else {
                    const jobId = randomUUID();
                    await db.insert(contentGenerationJobs).values({
                        jobId,
                        blueprintId,
                        assistantId: post.assistantId,
                        organisationId: post.organisationId,
                        userId,
                        status: 'queued',
                        attempt: 0,
                        maxAttempts: 3,
                        contextPrompt:
                            `Rewrite the previous ${post.platform} post, which was rejected. Do not repeat what was wrong with it: ${feedback}`
                                .slice(0, MAX_CONTEXT),
                        triggerType: 'on_demand',
                        platform: post.platform,
                        // Aim the redraft at the slot the rejected post was holding.
                        targetPublishDate: post.publishDate,
                        revisedFromPostId: postId,
                    });
                    revisionJobId = jobId;
                }
            }
        } catch (e) {
            // The rejection stands regardless — this only costs the user the automatic redraft.
            console.error('[reject-post] revision enqueue failed (rejection still stands):', e instanceof Error ? e.message : e);
            revisionSkipped = 'enqueue_failed';
        }
    }

    // The user is watching a modal that just told them a rewrite is coming; without this the queue
    // sits idle for up to ten minutes waiting on the cron. Awaited deliberately — see trigger-drain.
    if (revisionJobId) {
        await triggerContentDrain(event.headers as Record<string, string | undefined>, revisionJobId, 'reject-post');
    }

    // AC11 STOR-1.1.2: release this post's media to the content-retention pipeline.
    //
    // This used to be a near-permanent no-op: the clone created above carried the SAME
    // contentAssetIds, so the media was always still "in use" by a row nobody could see, and nothing
    // was ever reclaimed. Now that the redraft is a generation job rather than a clone — and the job
    // attaches its own media when it runs — the rejected post is genuinely the last holder, and the
    // release does the job it was written to do.
    //
    // This previously soft-deleted `workspace_assets` using `content_assets` ids filtered on
    // asset_type='social_image' — a different table with its own id sequence, so it reclaimed nothing
    // and could soft-delete an unrelated upload on an id collision. See
    // src/utils/release-post-media.ts before touching this.
    void (async () => {
        try {
            await releasePostMedia(db, [postId]);
        } catch (err) {
            console.error('[reject-post] media release failed (rejection still stands):', err);
        }
    })();

    // US-SMM-2.5.1: tell the user the revision is under way. This used to send 'post_revised' —
    // "your revised post is ready to review" — the instant the rejection was recorded, before any
    // revision existed (and, as it turned out, when none ever would). The *ready* half is now sent
    // by process-content-jobs when the redraft actually lands in the queue; this is the queued half.
    if (voiceFeedback && revisionJobId) {
        void (async () => {
            try {
                await createNotification(db, 'post_revision_queued', {
                    userId,
                    metadata: { jobId: revisionJobId, originalPostId: postId, assistantId: post.assistantId },
                });
            } catch { /* non-blocking */ }
        })();
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            success: true,
            // The revised post does not exist yet — it is generated asynchronously. Callers that
            // want to follow it should watch the Review Queue (or the notification), not an id.
            revisionJobId,
            revisionQueued: !!revisionJobId,
            revisionSkippedReason: revisionSkipped,
            ruleId,
            ruleText: ruleId ? feedback : undefined,
        }),
    };
});
