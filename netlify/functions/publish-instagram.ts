// netlify/functions/publish-instagram.ts
// US-SMM-3.3.1 + US-SMM-3.3.2: Publish due Instagram posts every minute.
// Handles: two-step Graph API publish, video polling, retry + exponential backoff,
// rate-limit state table, permanent-error classification, push notifications, cron log.

import { Handler } from '@netlify/functions';
import { and, eq, lte, or, isNull, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    scheduledPosts, systemConnections, rateLimitStates, publishCronLog,
    users, auditLogs,
} from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { getSecret } from '../../src/utils/vault';
import { recordPostedAssets } from '../../src/utils/pexels';
import { resolvePostMediaList } from '../../src/utils/social-publish';
import { composePostText } from '../../src/utils/post-link';
import { withLambda } from '@netlify/aws-lambda-compat';

const BATCH = 100;
// Backoff in minutes: attempt 1→2m, 2→8m, 3→30m
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
// Overrun threshold
const OVERRUN_MS = 55_000;
const GRAPH_VERSION = 'v19.0';
// A row left in 'publishing' longer than this was orphaned by a timed-out tick — reclaim it.
// Comfortably beyond the 120s video-processing poll so we never reclaim a live in-progress post.
const STALE_PUBLISHING_MINS = 10;

type FailureReason = { errorCode: number | null; errorMessage: string; errorSubcode?: number; isRetryable: boolean };

function isRetryable(code: number): boolean {
    // 429 rate limit, 5xx server errors, and Meta's transient error code 2
    return code === 429 || code >= 500 || code === 2;
}

function userMessage(reason: FailureReason): string {
    const c = reason.errorCode ?? 0;
    if (c === 190) return 'Instagram connection needs to be reconnected.';
    if (reason.errorMessage.toLowerCase().includes('content policy') || reason.errorSubcode === 2207026)
        return "This post was rejected by Instagram's content policy. Please edit and resubmit.";
    if (reason.errorMessage.toLowerCase().includes('format') || reason.errorSubcode === 352)
        return 'The image or video format is not supported by Instagram. Accepted formats: JPEG, PNG for images; MP4 for video.';
    if (c === 368 || reason.errorMessage.toLowerCase().includes('suspended'))
        return 'Your Instagram account has been restricted. Please resolve this in the Instagram app.';
    return `Publishing failed: ${reason.errorMessage}`;
}

export default withLambda(async () => {
    const db = getDb();
    const tickStart = Date.now();
    const now = new Date();
    let processed = 0, succeeded = 0, failed = 0;

    // Self-heal: reclaim posts stranded in 'publishing' by an earlier timed-out tick (e.g. a
    // slow video poll) so they are retried instead of sitting un-published forever.
    await db.execute(
        `UPDATE scheduled_posts SET status = 'scheduled', retry_at = NULL, updated_at = now()
         WHERE status = 'publishing' AND platform = 'instagram'
           AND updated_at < now() - interval '${STALE_PUBLISHING_MINS} minutes'`
    );

    // Claim due posts — SKIP LOCKED prevents concurrent tick double-processing
    const posts = await db.execute<{
        id: number; user_id: number; organisation_id: number; caption: string | null;
        hashtags: string | null; platform_post_id: string | null; connection_id: number | null;
        attempt_count: number; publish_date: string; post_format: string; assistant_id: number | null;
        content_asset_ids: unknown; link_url: string | null; cta_text: string | null;
    }>(
        `SELECT id, user_id, organisation_id, caption, hashtags, platform_post_id,
                connection_id, attempt_count, publish_date, post_format, assistant_id,
                content_asset_ids, link_url, cta_text
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform = 'instagram'
           AND publish_date <= now()
           AND (retry_at IS NULL OR retry_at <= now())
           -- Video text-overlay render gate (Phase 4) — see publish-social-posts for the rationale.
           AND (render_status IS NULL OR render_status = 'done')
         ORDER BY publish_date
         LIMIT ${BATCH}
         FOR UPDATE SKIP LOCKED`
    );

    if (!posts.length) {
        await db.insert(publishCronLog).values({ postsProcessed: 0, postsSucceeded: 0, postsFailed: 0, durationMs: Date.now() - tickStart });
        return { statusCode: 200, body: 'no posts due' };
    }

    // Set all claimed posts to 'publishing' atomically
    const postIds = posts.map(p => p.id);
    await db.update(scheduledPosts).set({ status: 'publishing', updatedAt: new Date() }).where(inArray(scheduledPosts.id, postIds));

    processed = posts.length;

    await Promise.allSettled(posts.map(async post => {
        try {
            // Check rate limit state for this org
            const [rl] = await db
                .select({ rateLimitedUntil: rateLimitStates.rateLimitedUntil })
                .from(rateLimitStates)
                .where(and(eq(rateLimitStates.organisationId, post.organisation_id), eq(rateLimitStates.platform, 'instagram')))
                .limit(1);

            if (rl && new Date(rl.rateLimitedUntil) > now) {
                // Defer — revert to scheduled, set retryAt to rate limit expiry
                await db.execute(
                    `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${rl.rateLimitedUntil.toISOString()}', updated_at = now() WHERE id = ${post.id}`
                );
                return;
            }

            // Resolve connection — by id, else the org's active Instagram connection.
            const connWhere = post.connection_id
                ? eq(systemConnections.id, post.connection_id)
                : and(
                    eq(systemConnections.organisationId, post.organisation_id),
                    eq(systemConnections.serviceName, 'instagram'),
                    eq(systemConnections.isActive, true),
                  );
            const [conn] = await db
                .select({ vaultRefKey: systemConnections.vaultRefKey, externalUserId: systemConnections.externalUserId })
                .from(systemConnections)
                .where(connWhere)
                .limit(1);
            if (!conn?.vaultRefKey) throw new Error('No active Instagram connection for this post.');

            const secretData = await getSecret(db, conn.vaultRefKey);
            const token = secretData?.token as string | undefined;
            if (!token) throw new Error('No token in vault for connection.');
            const igUserId = conn.externalUserId;
            if (!igUserId) throw new Error('No Instagram user ID in connection.');

            // Caption + hashtags + the post's link. Instagram does not make a link in a caption
            // clickable — it publishes as plain text — but it is still the address the user chose
            // to put in front of readers, so it is sent rather than silently dropped. The composer
            // says so at the point the link is typed (PLATFORM_FORMATS.linksClickable).
            const fullCaption = composePostText({
                caption: post.caption, hashtags: post.hashtags,
                linkUrl: post.link_url, ctaText: post.cta_text,
            });
            const isVideo = ['reel', 'video'].includes(post.post_format?.toLowerCase() ?? '');
            const mediaProxyBase = `${process.env.BASE_URL || 'https://bemoreswan.com'}/.netlify/functions/media-proxy?postId=${post.id}`;

            // ── Carousel? ───────────────────────────────────────────────────────────────────────
            // Instagram builds one from CHILD containers — one per slide, each flagged
            // is_carousel_item and carrying NO caption — followed by a CAROUSEL parent that holds
            // the caption and lists the children. Each child's media is fetched separately by Meta,
            // which is why media-proxy takes &index=N: without it every child would resolve to
            // slide 1 and the post would publish successfully as the same picture repeated.
            const slides = await resolvePostMediaList(db, post.content_asset_ids).catch(() => []);
            const isCarousel = slides.length > 1;

            let containerId: string;

            if (isCarousel) {
                // Video SLIDES are deliberately refused for now. Instagram requires each video child
                // container to reach FINISHED before the parent is assembled, and shipping that
                // polling untested would fail at publish time — on a post the reviewer had already
                // approved — rather than here, where it can be said plainly.
                if (slides.some(s => s.kind === 'video')) {
                    await handlePublishFailure(db, post, {
                        errorCode: null,
                        errorMessage: 'Instagram carousels with video slides aren’t supported yet — use images only, or post the video on its own as a Reel.',
                        isRetryable: false,
                    }, now);
                    failed++;
                    return;
                }

                const childIds: string[] = [];
                let childFailure: FailureReason | null = null;

                for (let i = 0; i < slides.length; i++) {
                    const slideIsVideo = slides[i].kind === 'video';
                    const childBody: Record<string, string | boolean> = {
                        is_carousel_item: true,
                        access_token: token,
                    };
                    if (slideIsVideo) {
                        childBody.media_type = 'VIDEO';
                        childBody.video_url = `${mediaProxyBase}&index=${i}`;
                    } else {
                        childBody.image_url = `${mediaProxyBase}&index=${i}`;
                    }
                    const childRes = await fetch(
                        `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
                        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(childBody) }
                    );
                    const childData: { id?: string; error?: { code: number; message: string; error_subcode?: number } } = await childRes.json();
                    if (!childData.id) {
                        const err = childData.error;
                        childFailure = {
                            errorCode: err?.code ?? null,
                            errorMessage: `Slide ${i + 1}: ${err?.message ?? 'could not be prepared'}`,
                            errorSubcode: err?.error_subcode,
                            isRetryable: isRetryable(err?.code ?? 0),
                        };
                        break;
                    }
                    childIds.push(childData.id);
                }

                // One bad slide fails the whole post. A carousel missing a slide is not a lesser
                // version of what was approved — it is a different post, and the reviewer approved
                // the one with all of them.
                if (childFailure) {
                    await handlePublishFailure(db, post, childFailure, now);
                    if (!childFailure.isRetryable) failed++;
                    return;
                }

                const parentRes = await fetch(
                    `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
                    {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            media_type: 'CAROUSEL',
                            children: childIds.join(','),
                            caption: fullCaption,
                            access_token: token,
                        }),
                    }
                );
                const parentData: { id?: string; error?: { code: number; message: string; error_subcode?: number } } = await parentRes.json();
                if (!parentData.id) {
                    const err = parentData.error;
                    const retryable = isRetryable(err?.code ?? 0);
                    await handlePublishFailure(db, post, {
                        errorCode: err?.code ?? null,
                        errorMessage: err?.message ?? 'Could not assemble the carousel.',
                        errorSubcode: err?.error_subcode,
                        isRetryable: retryable,
                    }, now);
                    if (!retryable) failed++;
                    return;
                }
                containerId = parentData.id;
            } else {

            // Step 1: create media container (image or video)
            const containerBody: Record<string, string> = {
                caption: fullCaption,
                access_token: token,
            };
            if (isVideo) {
                containerBody.video_url = mediaProxyBase;
                containerBody.media_type = 'REELS';
            } else {
                containerBody.image_url = mediaProxyBase;
                containerBody.media_type = 'IMAGE';
            }

            const mediaRes = await fetch(
                `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(containerBody) }
            );
            const mediaData: { id?: string; error?: { code: number; message: string; error_subcode?: number } } = await mediaRes.json();

            if (!mediaData.id) {
                const err = mediaData.error;
                const retryable = isRetryable(err?.code ?? 0);
                const reason: FailureReason = { errorCode: err?.code ?? null, errorMessage: err?.message ?? 'Unknown error', errorSubcode: err?.error_subcode, isRetryable: retryable };
                await handlePublishFailure(db, post, reason, now);
                if (!retryable) failed++;
                return;
            }

            containerId = mediaData.id;
            }
            await db.update(scheduledPosts).set({ containerId, updatedAt: new Date() }).where(eq(scheduledPosts.id, post.id));

            // Video-only: poll container status until FINISHED (or ERROR).
            // Never for a carousel: its parent is assembled from children that are already ready, and
            // status_code is not what a CAROUSEL container reports.
            if (isVideo && !isCarousel) {
                const POLL_INTERVAL_MS = 5_000;
                const POLL_TIMEOUT_MS  = 120_000;
                const pollStart = Date.now();
                let statusCode = 'IN_PROGRESS';
                while (statusCode !== 'FINISHED') {
                    if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
                        const reason: FailureReason = { errorCode: null, errorMessage: 'Video processing timed out after 120s', isRetryable: true };
                        await handlePublishFailure(db, post, reason, now);
                        return;
                    }
                    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
                    const pollRes = await fetch(
                        `https://graph.facebook.com/${GRAPH_VERSION}/${containerId}?fields=status_code&access_token=${token}`
                    );
                    const pollData: { status_code?: string; error?: { code: number; message: string; error_subcode?: number } } = await pollRes.json();
                    statusCode = pollData.status_code ?? 'ERROR';
                    if (statusCode === 'ERROR') {
                        const err = pollData.error;
                        const reason: FailureReason = { errorCode: err?.code ?? null, errorMessage: err?.message ?? 'Video processing failed', errorSubcode: err?.error_subcode, isRetryable: false };
                        await handlePublishFailure(db, post, reason, now);
                        failed++;
                        return;
                    }
                }
            }

            // Step 2: publish the container
            const publishRes = await fetch(
                `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media_publish`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ creation_id: containerId, access_token: token }),
                }
            );
            const publishData: { id?: string; error?: { code: number; message: string; error_subcode?: number } } = await publishRes.json();

            if (!publishData.id) {
                const err = publishData.error;
                const retryable = isRetryable(err?.code ?? 0);
                const reason: FailureReason = { errorCode: err?.code ?? null, errorMessage: err?.message ?? 'Unknown error', errorSubcode: err?.error_subcode, isRetryable: retryable };
                await handlePublishFailure(db, post, reason, now);
                if (!retryable) failed++;
                return;
            }

            // Success
            const instagramPostId = publishData.id;
            await db.execute(
                `UPDATE scheduled_posts SET status = 'published', platform_post_id = '${instagramPostId}', published_at = now(), updated_at = now() WHERE id = ${post.id}`
            );

            // US2 AC2.5: burn any Pexels asset on this post so it is never reused (idempotent).
            await recordPostedAssets(db, { orgId: post.organisation_id, userId: post.user_id, scheduledPostId: post.id })
                .catch(e => console.warn(`[publish-instagram] recordPostedAssets failed for post ${post.id}:`, e?.message || e));

            await createNotification(db, 'post_published_instagram', {
                userId: post.user_id,
                metadata: { postId: post.id, instagramPostId, assistantId: post.assistant_id },
            });

            succeeded++;

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-instagram] post ${post.id} error:`, msg);
            const reason: FailureReason = { errorCode: null, errorMessage: msg, isRetryable: true };
            await handlePublishFailure(db, post, reason, now);
        }
    }));

    const durationMs = Date.now() - tickStart;
    const overrunAlert = durationMs > OVERRUN_MS;

    await db.insert(publishCronLog).values({ postsProcessed: processed, postsSucceeded: succeeded, postsFailed: failed, durationMs, overrunAlert });

    if (overrunAlert) {
        console.warn(`[publish-instagram] OVERRUN: tick took ${durationMs}ms`);
        await db.insert(auditLogs).values({ actionType: 'publish_cron_overrun', resourceType: 'publish_cron_log', resourceId: 'tick', newState: { durationMs, postsProcessed: processed } });
    }

    return { statusCode: 200, body: JSON.stringify({ processed, succeeded, failed, durationMs }) };
});

async function handlePublishFailure(
    db: ReturnType<typeof getDb>,
    post: { id: number; user_id: number; organisation_id: number; attempt_count: number; assistant_id: number | null },
    reason: FailureReason,
    now: Date,
) {
    const attempt = post.attempt_count + 1;

    // Handle 429 rate limit: defer ALL posts for this org
    if (reason.errorCode === 429) {
        const rateLimitedUntil = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour
        await db.execute(
            `INSERT INTO rate_limit_states (organisation_id, platform, rate_limited_until, updated_at)
             VALUES (${post.organisation_id}, 'instagram', '${rateLimitedUntil.toISOString()}', now())
             ON CONFLICT (organisation_id, platform) DO UPDATE SET rate_limited_until = EXCLUDED.rate_limited_until, updated_at = now()`
        );
        // Revert this post to scheduled with retryAt
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${rateLimitedUntil.toISOString()}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );

        // Only notify user if posts will be delayed >2h past scheduled time
        const scheduledAt = new Date((post as any).publish_date ?? now);
        const delayHours = (rateLimitedUntil.getTime() - scheduledAt.getTime()) / 3_600_000;
        if (delayHours > 2) {
            await createNotification(db, 'instagram_rate_limited', {
                userId: post.user_id,
                metadata: { rateLimitedUntil, assistantId: post.assistant_id },
            });
        }
        return;
    }

    if (!reason.isRetryable || attempt >= MAX_ATTEMPTS) {
        // Permanent failure
        await db.execute(
            `UPDATE scheduled_posts SET status = 'failed', failure_reason = '${JSON.stringify(reason).replace(/'/g, "''")}', attempt_count = ${attempt}, updated_at = now() WHERE id = ${post.id}`
        );
        await createNotification(db, 'post_publish_failed_instagram', {
            userId: post.user_id,
            context: { failure: { reason: userMessage(reason) } },
            metadata: { postId: post.id, reason, assistantId: post.assistant_id },
        });
        await db.insert(auditLogs).values({ actionType: 'instagram_publish_failed', resourceType: 'scheduled_posts', resourceId: String(post.id), userId: post.user_id, newState: { reason, attempt } });

        // Token expired — mark connection
        if (reason.errorCode === 190) {
            await db.update(systemConnections)
                .set({ status: 'token_expired', updatedAt: new Date() })
                .where(and(eq(systemConnections.organisationId, post.organisation_id), eq(systemConnections.serviceName, 'instagram')));
            await db.execute(sql`UPDATE scheduled_posts SET status = 'paused', updated_at = now() WHERE connection_id IN (SELECT id FROM system_connections WHERE organisation_id = ${post.organisation_id} AND service_name = 'instagram') AND status = 'scheduled'`);
        }
    } else {
        // Retryable: exponential backoff
        const backoffMs = (BACKOFF_MINS[attempt - 1] ?? 30) * 60 * 1000;
        const retryAt = new Date(now.getTime() + backoffMs).toISOString();
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${retryAt}', attempt_count = ${attempt}, failure_reason = '${JSON.stringify(reason).replace(/'/g, "''")}', updated_at = now() WHERE id = ${post.id}`
        );
    }
}
