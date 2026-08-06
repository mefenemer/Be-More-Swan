// netlify/functions/publish-social-posts.ts
// Publish due LinkedIn, X (Twitter), Threads & YouTube posts every minute — the non-Instagram half
// of the social publisher. Mirrors publish-instagram's orchestration (claim FOR UPDATE SKIP
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
import { resolvePostMediaList, hasAttachedMedia, resolveSocialCredentials, publishX, publishLinkedIn, publishThreads, type DriverResult } from '../../src/utils/social-publish';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { recordPostedAssets } from '../../src/utils/pexels';
import { markPostMediaPosted } from '../../src/utils/release-post-media';
import { fireOrchestrations } from '../../src/utils/orchestration';
import { holdXCredits, settleXHold, xPostCost, xPostHasLink } from '../../src/utils/ai-credits';
import { composePostText } from '../../src/utils/post-link';
import { withLambda } from '@netlify/aws-lambda-compat';

const BATCH = 100;
const BACKOFF_MINS = [2, 8, 30];
const MAX_ATTEMPTS = 3;
const LABEL: Record<string, string> = { linkedin: 'LinkedIn', x: 'X (Twitter)', threads: 'Threads', youtube: 'YouTube' };
// A row left in 'publishing' longer than this was orphaned by a timed-out tick — reclaim it.
const STALE_PUBLISHING_MINS = 10;
// YouTube's upload lives in a background function that holds the row far longer — see the sweep below.
const STALE_YOUTUBE_MINS = 30;

// errorCode/errorSubcode are the PLATFORM's own numbers, not the HTTP status, and they are what
// post-failure-diagnosis.ts branches on. Optional: only the Meta family reports them.
type FailureReason = {
    httpStatus: number | null;
    errorCode?: number | null;
    errorSubcode?: number | null;
    errorMessage: string;
    isRetryable: boolean;
};
type PostRow = {
    id: number; user_id: number; organisation_id: number; caption: string | null;
    hashtags: string | null; connection_id: number | null; attempt_count: number;
    publish_date: string; platform: string; content_asset_ids: unknown;
    assistant_id: number | null; link_url: string | null; cta_text: string | null;
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
         WHERE status = 'publishing' AND platform IN ('linkedin','x','threads')
           AND updated_at < now() - interval '${STALE_PUBLISHING_MINS} minutes'`
    );

    // YouTube needs its own, much longer window. Its upload runs in a background function that
    // legitimately holds the row 'publishing' for up to ~12 minutes PER INVOCATION and re-triggers
    // itself for as many invocations as the video needs. Sweeping it on the 10-minute rule would
    // reclaim a perfectly healthy upload mid-flight and start a duplicate one alongside it.
    // The worker touches updated_at every time it parks resume state, so a row that has gone quiet
    // for this long really has died; clear the session so the retry starts cleanly.
    // The attempt_count bump is load-bearing, not bookkeeping. A reclaim that only reset the status
    // would retry forever: the worker's streamed fallback (a source that won't serve ranges) cannot
    // stop at a chunk boundary, so a video too slow for the 15-minute budget is killed mid-PUT and
    // returns nothing — leaving a row that goes stale, gets reclaimed, and is retried from zero on
    // an endless 30-minute cycle. Counting the attempt lets it fail like any other stuck post.
    await db.execute(
        `UPDATE scheduled_posts
            SET status = CASE WHEN attempt_count + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'scheduled' END,
                retry_at = NULL,
                attempt_count = attempt_count + 1,
                failure_reason = CASE WHEN attempt_count + 1 >= ${MAX_ATTEMPTS}
                    THEN '{"httpStatus":null,"errorMessage":"The video upload did not finish within its time budget.","isRetryable":false}'::jsonb
                    ELSE failure_reason END,
                youtube_upload_state = NULL,
                updated_at = now()
          WHERE status = 'publishing' AND platform = 'youtube'
            AND updated_at < now() - interval '${STALE_YOUTUBE_MINS} minutes'`
    );

    // Resume X posts paused for credit exhaustion once their hold-until (the first of next month)
    // has passed: the monthly X allowance has reset, so they re-enter the normal scheduled flow and
    // publish on this tick (their publish_date is already in the past). See pauseForXCredits.
    await db.execute(
        `UPDATE scheduled_posts SET status = 'scheduled', retry_at = NULL, updated_at = now()
         WHERE status = 'paused_credits' AND platform = 'x'
           AND (retry_at IS NULL OR retry_at <= now())`
    );

    const posts = await db.execute<PostRow>(
        `SELECT id, user_id, organisation_id, caption, hashtags, connection_id,
                attempt_count, publish_date, platform, content_asset_ids, assistant_id,
                link_url, cta_text
         FROM scheduled_posts
         WHERE status = 'scheduled'
           AND platform IN ('linkedin','x','threads','youtube')
           AND publish_date <= now()
           AND (retry_at IS NULL OR retry_at <= now())
           -- Video text-overlay render gate (Phase 4). NULL = nothing to render, 'done' = the
           -- overlaid clip is attached. 'pending'/'rendering' hold the post back so it can never
           -- publish without its text; 'failed' holds it back too, for the reviewer to resolve.
           AND (render_status IS NULL OR render_status = 'done')
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

    // Orgs already notified this tick that their X allowance is spent — one notification per org,
    // not one per paused post.
    const xPausedOrgs = new Set<number>();

    await Promise.allSettled(posts.map(async post => {
        try {
            // YouTube is never uploaded inline: this function is synchronous on Netlify's default
            // ~10s timeout and may be handling 100 posts at once, which no real video upload fits
            // inside. Hand it to the background worker (15-min ceiling, resumable across
            // invocations) and leave the row claimed as 'publishing' — the worker owns credentials,
            // the video, settling the row and notifying. Dispatched before anything else is
            // resolved so the cron does no work the worker is about to repeat.
            if (post.platform === 'youtube') {
                await triggerYoutubeUpload(post.id);
                return;
            }

            // Resolve credentials — by connection id, else the org's active connection for the
            // platform. Reads from whichever store backs this platform (see resolveSocialCredentials).
            const creds = await resolveSocialCredentials(db, {
                organisationId: post.organisation_id,
                platform: post.platform,
                connectionId: post.connection_id,
            });
            let token = creds.token;

            // Caption + hashtags + the post's link, in that order. Composed BEFORE the X credit
            // hold below, which prices the string it is given — see composePostText.
            const text = composePostText({
                caption: post.caption, hashtags: post.hashtags,
                linkUrl: post.link_url, ctaText: post.cta_text,
            });
            if (!text) throw new Error('Post has no text to publish.');

            // EVERY attachment, in slide order — a carousel is the same post with more media, so
            // the drivers take the list and decide what their platform calls that.
            const items = await resolvePostMediaList(db, post.content_asset_ids).catch(() => []);
            const image = items.length ? items : null;
            // No media attached = a genuine text post. Media attached that we cannot resolve = a
            // post that would go out stripped of the picture the user approved, recorded as a
            // success. Only the second is a failure, and it has to BE one — see hasAttachedMedia.
            if (!image && hasAttachedMedia(post.content_asset_ids)) {
                await handleFailure(db, post, {
                    httpStatus: null,
                    errorMessage: 'This post has media attached but it could not be loaded, so it was not published. Re-attach the media and try again.',
                    isRetryable: true,
                }, now);
                return;
            }

            // Explicit per-platform dispatch. This was `if (x) … else → LinkedIn`; a catch-all
            // else silently publishes every newly-claimed platform to LinkedIn, so each platform
            // in the claim query above must have its own arm and anything unrecognised must throw.
            let result: DriverResult;
            if (post.platform === 'x') {
                // X charges per request (text ~$0.015, any link ~$0.20), so hold from this org's
                // monthly X allowance BEFORE calling the API. If the allowance is spent, PAUSE the
                // post — no API call, no spend — and it auto-resumes next month.
                // Fail OPEN: if the credit engine itself errors (e.g. the migration hasn't run yet),
                // never block a legitimate post on it — publish unmetered and log.
                const xCost = xPostCost(text);
                let metered = false;
                try {
                    const xHold = await holdXCredits(db, { orgId: post.organisation_id, amount: xCost });
                    if (!xHold.ok) {
                        await pauseForXCredits(db, post, xPausedOrgs, now);
                        return;
                    }
                    metered = true;
                } catch (e) {
                    console.warn(`[publish-social-posts] X credit hold failed for post ${post.id}, publishing unmetered:`, (e as Error)?.message || e);
                }
                result = await publishX(text, token, image);
                // Token expired → refresh once and retry.
                if (!result.ok && result.status === 401 && creds.refresh) {
                    const fresh = await creds.refresh();
                    if (fresh) { token = fresh; result = await publishX(text, token, image); }
                }
                // Settle: success keeps + ledgers the spend; any failure refunds it (a failed post
                // is never charged, and the retry re-holds on its next attempt).
                if (metered) {
                    try {
                        await settleXHold(db, { orgId: post.organisation_id, amount: xCost, success: result.ok, hasLink: xPostHasLink(text), userId: post.user_id, assistantId: post.assistant_id });
                    } catch (e) {
                        console.warn(`[publish-social-posts] X credit settle failed for post ${post.id}:`, (e as Error)?.message || e);
                    }
                }
                // 402 = quota, not failure. Our pre-flight hold above passed, so the ledger thought
                // there was credit and only X knows better — the connected X account has hit its own
                // API quota. Route to the SAME paused_credits destination the ledger path uses, so
                // the monthly sweep and a credit top-up can both resurrect the post. Falling through
                // to handleFailure() marks it 'failed', which no sweep and no Review Queue column
                // ever selects again.
                //
                // Deliberately AFTER the settle: the post did not go out, so the hold must be
                // refunded first (settle sees result.ok === false and refunds). Pausing before that
                // would leak the hold on every 402.
                //
                // Note this can re-pause monthly if the X account's quota is structurally zero
                // rather than merely spent. That is the honest outcome — the post is genuinely
                // still pending — and each pause re-notifies, so it stays visible rather than
                // silently dying. It never burns an attempt.
                if (!result.ok && result.status === 402) {
                    await pauseForXCredits(db, post, xPausedOrgs, now, 'api', result.error);
                    return;
                }
            } else if (post.platform === 'linkedin') {
                result = await publishLinkedIn(text, token, creds.externalUserId, image);
            } else if (post.platform === 'threads') {
                result = await publishThreads(text, token, creds.externalUserId, image);
            } else {
                throw new Error(`No publish driver for platform '${post.platform}'.`);
            }

            if (!result.ok) {
                // LOG IT. Only the catch block below used to write anything, so a driver that
                // returned {ok:false} — the ordinary way a platform rejects a post — recorded the
                // failure to the database and notified the user while leaving the function logs
                // completely clean. That is precisely backwards for debugging: a prod Threads
                // outage sat behind seven days of healthy-looking ticks.
                console.error(
                    `[publish-social-posts] post ${post.id} (${post.platform}) rejected by platform:`,
                    JSON.stringify({ status: result.status, code: result.errorCode ?? null, subcode: result.errorSubcode ?? null, error: result.error }),
                );
                await handleFailure(db, post, {
                    httpStatus: result.status,
                    errorCode: result.errorCode ?? null,
                    errorSubcode: result.errorSubcode ?? null,
                    errorMessage: result.error,
                    isRetryable: isRetryable(result.status),
                }, now);
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
            // The post has gone out, so its media enters the 30-day retention window and
            // content-retention.ts can finally reclaim the R2 bytes. Skips anything a cross-post
            // sibling is still waiting to publish. Best-effort: a publish that succeeded must never
            // be reported as failed because a housekeeping clock did not get set.
            await markPostMediaPosted(db, [post.id])
                .catch(e => console.warn(`[publish-social-posts] markPostMediaPosted failed for post ${post.id}:`, e?.message || e));
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
// Hand a claimed YouTube post to the background worker. MUST be awaited: on Lambda the runtime
// freezes as soon as the handler returns, so an un-awaited trigger never reaches the worker and the
// post sits 'publishing' until the stale sweep reclaims it. Posting to a `-background` function
// returns 202 before the work starts, so the await costs only the trigger round-trip.
async function triggerYoutubeUpload(postId: number): Promise<void> {
    const baseUrl = resolveBaseUrl();
    if (!baseUrl) { console.error('[publish-social-posts] no base URL — YouTube worker not triggered for post', postId); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        await fetch(`${baseUrl}/.netlify/functions/publish-youtube-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ postId }),
            signal: controller.signal,
        });
    } catch (err) {
        console.error('[publish-social-posts] failed to trigger YouTube worker:', err);
    } finally {
        clearTimeout(timer);
    }
}

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

// X posting has stopped because a quota is spent. Move the post to the distinct 'paused_credits'
// status (never picked up by the publisher, never counted as a failure or an attempt) and stamp
// retry_at at the first of next month, when the allowance resets and the resume sweep re-queues it.
// Notify the org at most once per tick. This is NOT a failure — no attempt_count bump, no
// post_publish_failed.
//
// ── Two detection sides, one destination ────────────────────────────────────────────────────────
// 'ledger'  — our own X allowance is spent. holdXCredits refused BEFORE any API call, so no spend
//             and no request. This is the cheap, expected path.
// 'api'     — our ledger said there was credit, we called X, and X answered 402. The two disagree:
//             the connected X developer account has hit ITS quota, which our allowance knows
//             nothing about.
//
// The API side used to fall through to handleFailure and land on 'failed', which is a one-way door:
// BOTH resume sweeps (the monthly reset above, and stripe-webhook.ts on a credit top-up) select
// `status = 'paused_credits' AND platform = 'x'`, and 'failed' has no Review Queue column either.
// A post that was merely out of quota became permanently unrecoverable and invisible — exactly what
// happened to the 2026-07-23 post whose LinkedIn sibling went out fine.
type XPauseSource = 'ledger' | 'api';
async function pauseForXCredits(
    db: ReturnType<typeof getDb>,
    post: PostRow,
    notifiedOrgs: Set<number>,
    now: Date,
    source: XPauseSource = 'ledger',
    apiDetail?: string,
) {
    const resumeAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5, 0));
    // The reviewer has to be able to tell these apart from the row alone: one is resolved by
    // upgrading here, the other only at X. `reason` stays machine-readable and distinct.
    const reason = source === 'api'
        ? {
            httpStatus: 402,
            errorMessage: `X declined the post — the connected X account has reached its own API posting quota${apiDetail ? `: ${apiDetail}` : '.'} Paused until the quota resets.`,
            isRetryable: false,
            reason: 'x_api_quota_exhausted',
        }
        : {
            httpStatus: null,
            errorMessage: 'X monthly posting allowance reached — paused until it resets.',
            isRetryable: false,
            reason: 'x_credits_exhausted',
        };
    await db.execute(
        `UPDATE scheduled_posts
            SET status = 'paused_credits',
                retry_at = '${resumeAt.toISOString()}',
                failure_reason = '${esc(JSON.stringify(reason))}',
                updated_at = now()
          WHERE id = ${post.id}`
    );
    if (!notifiedOrgs.has(post.organisation_id)) {
        notifiedOrgs.add(post.organisation_id);
        await createNotification(db, source === 'api' ? 'x_api_quota_exhausted' : 'x_credits_exhausted', {
            userId: post.user_id,
            metadata: { postId: post.id, platform: 'x', assistantId: post.assistant_id, source },
        });
    }
}
