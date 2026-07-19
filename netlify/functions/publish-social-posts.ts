// netlify/functions/publish-social-posts.ts
// Publish due LinkedIn & X (Twitter) posts every minute — the non-Instagram half of the
// social publisher. Mirrors publish-instagram's orchestration (claim FOR UPDATE SKIP
// LOCKED → 'publishing' → API call → 'published' | retry/backoff | 'failed'), minus the
// Meta media-container flow. Posts the attached image when present (best-effort; falls
// back to text-only if media upload fails). Refreshes expired X tokens on 401 and retries.
//
// The per-platform publish drivers live in src/utils/social-publish.ts so the self-test harness
// (social-publish-selftest.ts) runs the exact same code. Facebook is excluded here: it has its own
// publisher (publish-facebook.ts) sharing the same driver module.

import { Handler } from '@netlify/functions';
import { inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, rateLimitStates, publishCronLog } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { resolvePostImage, resolveSocialCredentials, publishX, publishLinkedIn, type DriverResult } from '../../src/utils/social-publish';
import { recordPostedAssets } from '../../src/utils/pexels';
import { fireOrchestrations } from '../../src/utils/orchestration';
import { withLambda } from '@netlify/aws-lambda-compat';

const BATCH = 100;
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
const LABEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X (Twitter)' };
// A row left in 'publishing' longer than this was orphaned by a timed-out tick — reclaim it.
const STALE_PUBLISHING_MINS = 10;

type FailureReason = { httpStatus: number | null; errorMessage: string; isRetryable: boolean };
type PostRow = {
    id: number; user_id: number; organisation_id: number; caption: string | null;
    hashtags: string | null; connection_id: number | null; attempt_count: number;
    publish_date: string; platform: string; content_asset_ids: unknown;
    assistant_id: number | null;
};

const isRetryable = (s: number | null) => s === 429 || (s != null && s >= 500);
const esc = (s: string) => s.replace(/'/g, "''");

export default withLambda(async () => {
    const db = getDb();
    const tickStart = Date.now();
    const now = new Date();
    let processed = 0, succeeded = 0, failed = 0;

    // Self-heal: reclaim posts stranded in 'publishing' by an earlier timed-out tick so they
    // are retried instead of sitting un-published forever (nothing else re-selects 'publishing').
    await db.execute(
        `UPDATE scheduled_posts SET status = 'scheduled', retry_at = NULL, updated_at = now()
         WHERE status = 'publishing' AND platform IN ('linkedin','x')
           AND updated_at < now() - interval '${STALE_PUBLISHING_MINS} minutes'`
    );

    const posts = await db.execute<PostRow>(
        `SELECT id, user_id, organisation_id, caption, hashtags, connection_id,
                attempt_count, publish_date, platform, content_asset_ids, assistant_id
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform IN ('linkedin','x')
           AND publish_date <= now()
           AND (retry_at IS NULL OR retry_at <= now())
         ORDER BY publish_date
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`
    );

    if (!posts.length) {
        await db.insert(publishCronLog).values({ postsProcessed: 0, postsSucceeded: 0, postsFailed: 0, durationMs: Date.now() - tickStart });
        return { statusCode: 200, body: 'no posts due' };
    }

    await db.update(scheduledPosts).set({ status: 'publishing', updatedAt: new Date() })
        .where(inArray(scheduledPosts.id, posts.map(p => p.id)));
    processed = posts.length;

    await Promise.allSettled(posts.map(async post => {
        try {
            // Resolve credentials — by connection id, else the org's active connection for the
            // platform. Reads from whichever store backs this platform (see resolveSocialCredentials).
            const creds = await resolveSocialCredentials(db, {
                organisationId: post.organisation_id,
                platform: post.platform,
                connectionId: post.connection_id,
            });
            let token = creds.token;

            const text = [post.caption, post.hashtags].filter(Boolean).join('\n\n').trim();
            if (!text) throw new Error('Post has no text to publish.');

            // Attached image (best-effort — text-only if absent/unresolvable).
            const image = await resolvePostImage(db, post.content_asset_ids).catch(() => null);

            let result: DriverResult;
            if (post.platform === 'x') {
                result = await publishX(text, token, image);
                // Token expired → refresh once and retry.
                if (!result.ok && result.status === 401 && creds.refresh) {
                    const fresh = await creds.refresh();
                    if (fresh) { token = fresh; result = await publishX(text, token, image); }
                }
            } else {
                result = await publishLinkedIn(text, token, creds.externalUserId, image);
            }

            if (!result.ok) {
                await handleFailure(db, post, { httpStatus: result.status, errorMessage: result.error, isRetryable: isRetryable(result.status) }, now);
                if (!isRetryable(result.status)) failed++;
                return;
            }

            await db.execute(
                `UPDATE scheduled_posts SET status = 'published', platform_post_id = '${esc(result.id)}', published_at = now(), updated_at = now() WHERE id = ${post.id}`
            );
            // US2 AC2.5: burn any Pexels asset on this post so it is never reused (idempotent;
            // covers autonomous posts that bypass manual approval). Never blocks publish success.
            await recordPostedAssets(db, { orgId: post.organisation_id, userId: post.user_id, scheduledPostId: post.id })
                .catch(e => console.warn(`[publish-social-posts] recordPostedAssets failed for post ${post.id}:`, e?.message || e));
            await createNotification(db, 'post_published', {
                userId: post.user_id,
                context: { platform: { label: LABEL[post.platform] } },
                metadata: { postId: post.id, platform: post.platform, platformPostId: result.id, assistantId: post.assistant_id },
            });
            // Orchestration (Phase 5): this assistant just published — hand off to any linked
            // assistants. Best-effort; never throws. Each downstream draft still needs approval.
            if (post.assistant_id) {
                await fireOrchestrations(db, {
                    sourceAssistantId: post.assistant_id,
                    orgId: post.organisation_id,
                    userId: post.user_id,
                    event: 'publishes_a_post',
                    sourcePostId: post.id,
                    sourceCaption: post.caption ?? null,
                });
            }
            succeeded++;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-social-posts] post ${post.id} error:`, msg);
            await handleFailure(db, post, { httpStatus: null, errorMessage: msg, isRetryable: true }, now);
        }
    }));

    const durationMs = Date.now() - tickStart;
    await db.insert(publishCronLog).values({ postsProcessed: processed, postsSucceeded: succeeded, postsFailed: failed, durationMs });
    return { statusCode: 200, body: JSON.stringify({ processed, succeeded, failed, durationMs }) };
});

// ── Failure handling (rate-limit defer / retry backoff / permanent fail) ──────
async function handleFailure(db: ReturnType<typeof getDb>, post: PostRow, reason: FailureReason, now: Date) {
    const attempt = post.attempt_count + 1;

    if (reason.httpStatus === 429) {
        const until = new Date(now.getTime() + 60 * 60 * 1000);
        await db.execute(
            `INSERT INTO rate_limit_states (organisation_id, platform, rate_limited_until, updated_at)
             VALUES (${post.organisation_id}, '${post.platform}', '${until.toISOString()}', now())
             ON CONFLICT (organisation_id, platform) DO UPDATE SET rate_limited_until = EXCLUDED.rate_limited_until, updated_at = now()`
        );
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${until.toISOString()}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        return;
    }

    if (!reason.isRetryable || attempt >= MAX_ATTEMPTS) {
        await db.execute(
            `UPDATE scheduled_posts SET status = 'failed', failure_reason = '${esc(JSON.stringify(reason))}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        await createNotification(db, 'post_publish_failed', {
            userId: post.user_id,
            context: { platform: { label: LABEL[post.platform] }, failure: { reason: reason.errorMessage } },
            metadata: { postId: post.id, platform: post.platform, reason, assistantId: post.assistant_id },
        });
    } else {
        const retryAt = new Date(now.getTime() + (BACKOFF_MINS[attempt - 1] ?? 30) * 60 * 1000).toISOString();
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${retryAt}', attempt_count = ${attempt}, failure_reason = '${esc(JSON.stringify(reason))}', updated_at = now() WHERE id = ${post.id}`
        );
    }
}
