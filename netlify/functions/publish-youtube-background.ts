// netlify/functions/publish-youtube-background.ts
// Background worker that uploads ONE scheduled YouTube post.
//
// POST { postId } — resolves the post's video asset, opens (or resumes) a YouTube resumable upload
// session, and pushes chunks until the video is live or the wall clock runs out.
//
// WHY THIS IS NOT IN publish-social-posts.ts: that cron is a synchronous function on Netlify's
// default ~10s timeout, and it claims up to 100 posts per tick. A LinkedIn, X or Threads post is
// one API call and fits fine; a video upload does not. Background functions (filename must end in
// `-background`) get a 15-minute ceiling instead, which is the only budget where a real video has a
// chance of finishing.
//
// Even 15 minutes isn't guaranteed to be enough, which is the point of the resume state: the driver
// stops at a chunk boundary before the deadline and parks { uploadUrl, total, offset } on the post
// (db/youtube-upload-resume.sql). This worker then re-triggers itself to carry on. A video too big
// for one invocation therefore completes across several, instead of restarting from zero forever.

import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { resolveBaseUrl } from '../../src/utils/base-url';
import {
    resolvePostVideo, resolveSocialCredentials, publishYouTubeResumable, youtubeMetaFromCaption,
    type YouTubeResumeState,
} from '../../src/utils/social-publish';
import { recordPostedAssets } from '../../src/utils/pexels';
import { postLinkLine } from '../../src/utils/post-link';
import { fireOrchestrations } from '../../src/utils/orchestration';
import { withLambda } from '@netlify/aws-lambda-compat';

// 12 min of the 15-min background ceiling. The driver keeps its own margin on top of this for the
// in-flight chunk, so the invocation always has room to persist state before the runtime kills it.
const UPLOAD_BUDGET_MS = 12 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const isRetryable = (s: number | null) => s === 429 || (s != null && s >= 500);

export default withLambda(async (event: HandlerEvent) => {
    let postId: number;
    try { postId = JSON.parse(event.body || '{}').postId; }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    if (!postId) return { statusCode: 400, body: 'Missing postId' };

    const db = getDb();
    const [post] = await db.select().from(scheduledPosts).where(eq(scheduledPosts.id, postId)).limit(1);
    if (!post) return { statusCode: 404, body: 'Post not found' };

    // The cron claims the row (status → 'publishing') before triggering us. Anything else means a
    // duplicate trigger, or a post someone has since cancelled — either way, don't publish it.
    if (post.status !== 'publishing') return { statusCode: 200, body: `Post is '${post.status}', not publishing` };

    const prior = (post.youtubeUploadState as YouTubeResumeState | null) ?? null;

    try {
        // Re-presigned on every invocation, so a resume never inherits a nearly-expired URL.
        // Video-only platform: a post with no video can never publish, so fail it permanently
        // rather than retrying something that will never acquire one.
        const video = await resolvePostVideo(db, post.contentAssetIds).catch(() => null);
        if (!video) {
            return settleFailure(db, post, 'This YouTube post has no video attached — add one and reschedule it.', false);
        }

        const creds = await resolveSocialCredentials(db, {
            organisationId: post.organisationId!,
            platform: 'youtube',
            connectionId: post.connectionId,
        });

        const meta = youtubeMetaFromCaption(
            post.caption ?? '', post.hashtags ?? '', post.postFormat ?? undefined,
            postLinkLine({ caption: post.caption, linkUrl: post.linkUrl, ctaText: post.ctaText }),
        );

        const outcome = await publishYouTubeResumable(meta, creds.token, video, {
            deadlineMs: Date.now() + UPLOAD_BUDGET_MS,
            resume: prior ?? undefined,
        });

        if (outcome.kind === 'incomplete') {
            // Refuse to re-trigger unless real progress was made. Without this a session that
            // accepts nothing would bounce between invocations forever, burning the background
            // budget on an upload that is never going to finish.
            if (prior && outcome.state.offset <= prior.offset) {
                return settleFailure(db, post, 'The YouTube upload stopped making progress and was abandoned.', false);
            }
            await db.update(scheduledPosts)
                .set({ youtubeUploadState: outcome.state, updatedAt: new Date() })
                .where(eq(scheduledPosts.id, post.id));
            await retrigger(post.id);
            const pct = Math.floor((outcome.state.offset / outcome.state.total) * 100);
            return { statusCode: 200, body: `Upload in progress (${pct}%) — continuing in a new invocation` };
        }

        if (outcome.kind === 'failed') {
            return settleFailure(db, post, outcome.error, isRetryable(outcome.status), outcome.status);
        }

        // ── Published ──
        await db.update(scheduledPosts).set({
            status: 'published',
            platformPostId: outcome.id,
            platformPostUrl: `https://www.youtube.com/watch?v=${outcome.id}`,
            publishedAt: new Date(),
            youtubeUploadState: null,
            updatedAt: new Date(),
        }).where(eq(scheduledPosts.id, post.id));

        await recordPostedAssets(db, { orgId: post.organisationId!, userId: post.userId, scheduledPostId: post.id })
            .catch(e => console.warn(`[publish-youtube-background] recordPostedAssets failed for post ${post.id}:`, e?.message || e));
        await createNotification(db, 'post_published', {
            userId: post.userId,
            context: { platform: { label: 'YouTube' } },
            metadata: { postId: post.id, platform: 'youtube', platformPostId: outcome.id, assistantId: post.assistantId },
        });
        // Orchestration: this assistant just published — hand off to any linked assistants.
        // Best-effort; each downstream draft still needs approval.
        if (post.assistantId) {
            await fireOrchestrations(db, {
                sourceAssistantId: post.assistantId,
                orgId: post.organisationId!,
                userId: post.userId,
                event: 'publishes_a_post',
                sourcePostId: post.id,
                sourceCaption: post.caption ?? null,
            });
        }
        return { statusCode: 200, body: `Published ${outcome.id}` };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[publish-youtube-background] post ${postId} error:`, msg);
        return settleFailure(db, post, msg, true);
    }
});

// Settle a failed upload. ALWAYS clears the session state: a stale uploadUrl left behind would make
// a later attempt resume into a video the user may have edited or replaced in the meantime.
async function settleFailure(
    db: ReturnType<typeof getDb>,
    post: { id: number; userId: number; attemptCount: number | null; assistantId?: number | null },
    error: string,
    retryable: boolean,
    httpStatus: number | null = null,
) {
    const attempt = (post.attemptCount ?? 0) + 1;
    const giveUp = !retryable || attempt >= MAX_ATTEMPTS;

    await db.update(scheduledPosts).set({
        status: giveUp ? 'failed' : 'scheduled',
        // Retryable failures come back through the cron's normal sweep rather than re-triggering
        // here — a tight self-retry loop on a failing upload would hammer the API.
        retryAt: giveUp ? null : new Date(Date.now() + 10 * 60 * 1000),
        attemptCount: attempt,
        failureReason: { httpStatus, errorMessage: error, isRetryable: retryable },
        youtubeUploadState: null,
        updatedAt: new Date(),
    }).where(eq(scheduledPosts.id, post.id));

    if (giveUp) {
        await createNotification(db, 'post_publish_failed', {
            userId: post.userId,
            // The template renders "Publishing to {{platform.label}} failed: {{failure.reason}}",
            // and the CTA deep-links via assistantId — both were missing here, so the YouTube
            // failure notice read as a truncated sentence with no way through to the post.
            context: { platform: { label: 'YouTube' }, failure: { reason: error } },
            metadata: { postId: post.id, platform: 'youtube', error, assistantId: post.assistantId },
        }).catch(() => { /* a notification failure must not mask the publish failure */ });
    }
    return { statusCode: 200, body: `Upload failed: ${error}` };
}

// Continue the upload in a fresh invocation. MUST be awaited: on Lambda the runtime freezes the
// moment the handler returns, so an un-awaited trigger is frozen mid-flight and the upload is
// stranded 'publishing' until the cron's stale sweep reclaims it.
async function retrigger(postId: number): Promise<void> {
    const baseUrl = resolveBaseUrl();
    if (!baseUrl) { console.error('[publish-youtube-background] no base URL — cannot continue post', postId); return; }
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
        console.error('[publish-youtube-background] failed to continue upload:', err);
    } finally {
        clearTimeout(timer);
    }
}
