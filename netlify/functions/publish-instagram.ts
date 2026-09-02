// netlify/functions/publish-instagram.ts
// US-SMM-3.3.1 + US-SMM-3.3.2: Publish due Instagram posts every minute.
// Handles: two-step Graph API publish, video polling, retry + exponential backoff,
// rate-limit state table, permanent-error classification, push notifications, cron log.

import { Handler } from '@netlify/functions';
import { and, eq, lte, or, isNull, inArray, sql, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
    scheduledPosts, systemConnections, rateLimitStates, publishCronLog,
    users, auditLogs,
} from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { getSecret } from '../../src/utils/vault';
import { recordPostedAssets } from '../../src/utils/pexels';
import { markPostMediaPosted } from '../../src/utils/release-post-media';
import { resolvePostMediaList } from '../../src/utils/social-publish';
import { composePostText } from '../../src/utils/post-link';
import { withLambda } from '@netlify/aws-lambda-compat';
import { isMetaAppBlocked, APP_BLOCK_HOLD_MS } from '../../src/utils/meta-app-block';

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

type FailureReason = { httpStatus: number | null; errorCode: number | null; errorMessage: string; errorSubcode?: number; isRetryable: boolean };

/**
 * Meta application error codes that mean "ask again later", not "this post is bad".
 *
 * These are NOT HTTP statuses. Graph answers a throttle with HTTP 200 or 400 and puts the real
 * verdict in `error.code`, so a classifier that only looks at numbers ≥500 sees a rate limit as a
 * permanent rejection. 4/17/32/613 are the documented app-, user- and page-level limits (the same
 * set goal-metric-selftest treats as inconclusive — see tests/graph-error-classification.test.ts),
 * 341 is the app-level limit, and 1/2 are Graph's transient "unknown error"/"downtime" pair.
 */
const META_THROTTLE_CODES = new Set([4, 17, 32, 341, 613]);
const META_TRANSIENT_CODES = new Set([1, 2]);

/**
 * The container is not ready yet — #9007 / subcode 2207027, "Media ID is not available".
 *
 * Graph reports it as a 400, which is what made it look permanent, but nothing about the post is
 * wrong: media_publish simply arrived before the container finished processing. Observed on prod
 * post 362 (2026-08-13, an IMAGE) — burned on attempt 1 of 3 for a race that a retry seconds later
 * would have won.
 *
 * NOT a throttle: isThrottle must keep excluding it, or one unlucky container would defer every
 * other post in the org for an hour.
 */
const META_CONTAINER_NOT_READY_CODES = new Set([9007]);

/**
 * Is this failure worth another attempt?
 *
 * Reads BOTH the HTTP status and Meta's application code, because either one alone gets it wrong:
 *
 *   • This used to take `code` only, and callers passed `err?.code ?? 0`. A 500/502/503 from
 *     Meta's edge carries no `error` object at all, so `code` was 0 → PERMANENT. The post burned
 *     on attempt 1 over a blip, and stored `{"errorCode": null, "errorMessage": "Unknown error",
 *     "isRetryable": false}` — the same unactionable row the X and LinkedIn media paths produced.
 *   • Reading the status alone is equally wrong here: Graph reports its rate limits as an
 *     application code under a 200/400, so every throttle would classify as permanent.
 *
 * The old `code >= 500` test was checking an application code against an HTTP range — a comparison
 * that matched nothing Meta actually sends. Real throttles (4/17/32/613) all fell through it.
 */
export function isRetryable(httpStatus: number | null, code: number | null): boolean {
    if (httpStatus === 429 || (httpStatus != null && httpStatus >= 500)) return true;
    if (code == null) return false;
    return META_THROTTLE_CODES.has(code)
        || META_TRANSIENT_CODES.has(code)
        || META_CONTAINER_NOT_READY_CODES.has(code);
}

/** A throttle defers every post for the org, not just this one — see handlePublishFailure. */
export function isThrottle(httpStatus: number | null, code: number | null): boolean {
    return httpStatus === 429 || (code != null && META_THROTTLE_CODES.has(code));
}

/**
 * Read a Graph response body without letting a non-JSON edge page throw.
 *
 * Meta's edge answers a 502 with HTML, and a bare `await res.json()` on that rejects — which used
 * to land in the outer catch and report a JSON parse error as the publishing failure. The status is
 * what matters there, so parse defensively and let the caller classify.
 */
async function graphJson<T>(res: Response): Promise<T> {
    return (await res.json().catch(() => ({}))) as T;
}

/**
 * Polling profiles for waitForContainerReady.
 *
 * VIDEO_POLL reproduces the original video figures exactly — first check after 5s, give up at 120s —
 * so encoding behaviour is untouched. IMAGE_POLL checks IMMEDIATELY, because an image container is
 * usually ready the moment it exists: the common case costs one extra request and no added latency,
 * and only the unlucky case waits at all.
 */
const VIDEO_POLL = { firstDelayMs: 5_000, intervalMs: 5_000, timeoutMs: 120_000, what: 'Video processing' } as const;
const IMAGE_POLL = { firstDelayMs: 0, intervalMs: 1_000, timeoutMs: 30_000, what: 'Image processing' } as const;

/**
 * Wait for a media container to report FINISHED before publishing it.
 *
 * Instagram's /media endpoint is asynchronous for BOTH kinds. Only video was ever polled here, on
 * the assumption that an image container is ready as soon as it is created. It usually is — but when
 * it is not, media_publish answers 400 with #9007 / subcode 2207027 ("Media ID is not available")
 * and the post used to burn on attempt 1, because that code classified as permanent. Prod post 362
 * on 2026-08-13 is the case in point.
 *
 * Two independent guards, deliberately: this poll removes the race, and #9007 staying retryable
 * (META_CONTAINER_NOT_READY_CODES) catches whatever still slips through — a container can finish
 * between the poll and the publish call.
 */
export async function waitForContainerReady(args: {
    containerId: string;
    token: string;
    firstDelayMs: number;
    intervalMs: number;
    timeoutMs: number;
    what: string;
    /** Seam for tests; defaults to the real Graph call. */
    poll?: (containerId: string) => Promise<{ status: number | null; status_code?: string; error?: { code: number; message: string; error_subcode?: number } }>;
    sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: true } | { ok: false; reason: FailureReason }> {
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const poll = args.poll ?? (async (id: string) => {
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${id}?fields=status_code&access_token=${args.token}`);
        const data = await graphJson<{ status_code?: string; error?: { code: number; message: string; error_subcode?: number } }>(res);
        return { status: res.status, ...data };
    });

    const started = Date.now();
    let delay = args.firstDelayMs;
    for (;;) {
        if (delay > 0) await sleep(delay);
        delay = args.intervalMs;

        const r = await poll(args.containerId);

        // A clean read that simply carries no status_code means READY, not broken.
        //
        // This matters because images were never polled before, so there is no evidence that an
        // IMAGE container reports status_code on this Graph version at all. Treating the field's
        // absence as ERROR (what the video-only loop did) would turn "we added a health check" into
        // "every image post now fails" — the worst possible outcome for a reliability fix. Assuming
        // ready restores exactly the old image behaviour, and #9007 stays retryable underneath it.
        // An error object, or a non-2xx status, is still an error; only silence is optimistic.
        const httpOk = r.status != null && r.status >= 200 && r.status < 300;
        const statusCode = r.status_code ?? (httpOk && !r.error ? 'FINISHED' : 'ERROR');
        if (statusCode === 'FINISHED') return { ok: true };

        if (statusCode === 'ERROR') {
            // A container Instagram rejected outright stays permanent — re-uploading the identical
            // file cannot succeed. But a poll that merely failed to REACH Graph (a 5xx on the status
            // read) says nothing about the container, so it must not be mistaken for a rejection.
            const retryable = isRetryable(r.status, r.error?.code ?? null);
            return { ok: false, reason: {
                httpStatus: r.status,
                errorCode: r.error?.code ?? null,
                errorMessage: r.error?.message ?? `${args.what} failed (${r.status})`,
                errorSubcode: r.error?.error_subcode,
                isRetryable: retryable,
            } };
        }

        // Still IN_PROGRESS. Check the clock only after a poll, so a zero first delay always gets at
        // least one real answer rather than timing out against a stale deadline.
        if (Date.now() - started > args.timeoutMs) {
            return { ok: false, reason: {
                httpStatus: null, errorCode: null,
                errorMessage: `${args.what} timed out after ${Math.round(args.timeoutMs / 1000)}s`,
                isRetryable: true,
            } };
        }
    }
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
            // ORDER BY matters: an org can hold several Instagram accounts, and an unordered
            // limit(1) picked one arbitrarily — including a DISCONNECTED row, because connWhere
            // only filters isActive when no explicit connection_id was given. Newest-first makes
            // the fallback deterministic; a post that must target a specific account carries
            // connection_id and never reaches this branch.
            const [conn] = await db
                .select({ vaultRefKey: systemConnections.vaultRefKey, externalUserId: systemConnections.externalUserId })
                .from(systemConnections)
                .where(connWhere)
                .orderBy(desc(systemConnections.updatedAt))
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
                        httpStatus: null,
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
                    const childData = await graphJson<{ id?: string; error?: { code: number; message: string; error_subcode?: number } }>(childRes);
                    if (!childData.id) {
                        const err = childData.error;
                        childFailure = {
                            httpStatus: childRes.status,
                            errorCode: err?.code ?? null,
                            errorMessage: `Slide ${i + 1}: ${err?.message ?? `could not be prepared (${childRes.status})`}`,
                            errorSubcode: err?.error_subcode,
                            isRetryable: isRetryable(childRes.status, err?.code ?? null),
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
                const parentData = await graphJson<{ id?: string; error?: { code: number; message: string; error_subcode?: number } }>(parentRes);
                if (!parentData.id) {
                    const err = parentData.error;
                    const retryable = isRetryable(parentRes.status, err?.code ?? null);
                    await handlePublishFailure(db, post, {
                        httpStatus: parentRes.status,
                        errorCode: err?.code ?? null,
                        errorMessage: err?.message ?? `Could not assemble the carousel (${parentRes.status}).`,
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
            const mediaData = await graphJson<{ id?: string; error?: { code: number; message: string; error_subcode?: number } }>(mediaRes);

            if (!mediaData.id) {
                const err = mediaData.error;
                const retryable = isRetryable(mediaRes.status, err?.code ?? null);
                const reason: FailureReason = { httpStatus: mediaRes.status, errorCode: err?.code ?? null, errorMessage: err?.message ?? `Instagram container error (${mediaRes.status})`, errorSubcode: err?.error_subcode, isRetryable: retryable };
                await handlePublishFailure(db, post, reason, now);
                if (!retryable) failed++;
                return;
            }

            containerId = mediaData.id;
            }
            await db.update(scheduledPosts).set({ containerId, updatedAt: new Date() }).where(eq(scheduledPosts.id, post.id));

            // Wait for the container to report FINISHED. Never for a carousel: its parent is
            // assembled from children that are already ready, and status_code is not what a CAROUSEL
            // container reports.
            if (!isCarousel) {
                const wait = await waitForContainerReady({
                    containerId, token,
                    ...(isVideo ? VIDEO_POLL : IMAGE_POLL),
                });
                if (!wait.ok) {
                    await handlePublishFailure(db, post, wait.reason, now);
                    if (!wait.reason.isRetryable) failed++;
                    return;
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
            const publishData = await graphJson<{ id?: string; error?: { code: number; message: string; error_subcode?: number } }>(publishRes);

            if (!publishData.id) {
                const err = publishData.error;
                const retryable = isRetryable(publishRes.status, err?.code ?? null);
                const reason: FailureReason = { httpStatus: publishRes.status, errorCode: err?.code ?? null, errorMessage: err?.message ?? `Instagram publish error (${publishRes.status})`, errorSubcode: err?.error_subcode, isRetryable: retryable };
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

            // Media has gone live — start its 30-day retention clock so content-retention.ts can
            // reclaim the R2 bytes. Instagram fetched its own copy from the URL we handed the Graph
            // API, so the published post does not depend on ours surviving.
            await markPostMediaPosted(db, [post.id])
                .catch(e => console.warn(`[publish-instagram] markPostMediaPosted failed for post ${post.id}:`, e?.message || e));

            await createNotification(db, 'post_published_instagram', {
                userId: post.user_id,
                metadata: { postId: post.id, instagramPostId, assistantId: post.assistant_id },
            });

            succeeded++;

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[publish-instagram] post ${post.id} error:`, msg);
            const reason: FailureReason = { httpStatus: null, errorCode: null, errorMessage: msg, isRetryable: true };
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

    // ── Meta has blocked the APP, not this connection ───────────────────────────────────────────
    // Checked before everything else, because it is the one failure where both of the other
    // branches are actively harmful: the permanent branch would burn a post over an outage nobody
    // in this org caused, and the customer-facing message would tell them to reconnect an account
    // that is not broken. See src/utils/meta-app-block.ts.
    //
    // Held exactly like a throttle — the mechanism is already here and already tested — with two
    // deliberate differences: attempt_count is NOT incremented (the post has not had a real
    // attempt, and burning through three of them during an outage would defeat the whole point),
    // and there is no notification, because a per-post alert storm during a platform-wide outage
    // tells the customer nothing they can act on.
    if (isMetaAppBlocked(reason.errorMessage)) {
        const heldUntil = new Date(now.getTime() + APP_BLOCK_HOLD_MS);
        await db.execute(
            `INSERT INTO rate_limit_states (organisation_id, platform, rate_limited_until, updated_at)
             VALUES (${post.organisation_id}, 'instagram', '${heldUntil.toISOString()}', now())
             ON CONFLICT (organisation_id, platform) DO UPDATE SET rate_limited_until = EXCLUDED.rate_limited_until, updated_at = now()`
        );
        await db.execute(
            `UPDATE scheduled_posts SET status = 'scheduled', retry_at = '${heldUntil.toISOString()}', failure_reason = '${JSON.stringify(reason).replace(/'/g, "''")}', updated_at = now() WHERE id = ${post.id}`
        );
        return;
    }

    // Handle a rate limit: defer ALL posts for this org, not just this one — the limit is on the
    // app/page/user, so the next post in the batch would hit the same wall.
    //
    // This used to test `reason.errorCode === 429`, which could never be true: 429 is an HTTP
    // status and errorCode holds Meta's APPLICATION code, which is 4/17/32/613 for a throttle. The
    // whole rate_limit_states mechanism below — and the instagram_rate_limited notification — was
    // therefore unreachable, and throttled posts fell through to the permanent-failure branch.
    if (isThrottle(reason.httpStatus, reason.errorCode)) {
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
