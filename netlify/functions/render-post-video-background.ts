// netlify/functions/render-post-video-background.ts
// Phase 4: the background worker that burns a post's timed text overlays into its video.
//
// POST { jobId }  — claim the post_render_jobs row, start a Remotion Lambda render, poll it to
// completion, copy the output into R2 as a content asset, attach it to the post, and clear the
// publish gate (scheduled_posts.render_status → 'done').
//
// Netlify background functions (filename ends in `-background`) run async with a 15-minute ceiling;
// triggered by trigger-post-render.ts, which awaits the dispatch. A social clip renders in well under
// a minute, so POLL_TIMEOUT_MS sits far inside the ceiling and exists only to fail a stuck render
// loudly rather than let the handler be killed mid-poll with the post gated at 'rendering'.
//
// EVERY exit path must leave render_status in a terminal state ('done' or 'failed'). A post left at
// 'pending'/'rendering' is invisible to all three publishers and will never go out — a silent drop is
// far worse here than a visible failure, which the reviewer can see and retry.

import { HandlerEvent } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, postRenderJobs, scheduledPosts } from '../../db/schema';
import { presignR2Get } from '../../src/utils/social-publish';
import { persistRemoteMediaToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { attachRenderedVideo, frameMeta, frameMetaFromJson, renderableOverlays, resolveAudioTracks, resolveOverlayVideoBase } from '../../src/lib/post-render';
import { remotionConfigured, renderProgress, startRender, type StartedRender } from '../../src/lib/remotion-lambda';
import { withLambda } from '@netlify/aws-lambda-compat';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;   // 10 min, under the 15-min background ceiling
// The base clip is fetched by Lambda over the whole render, not once up front — a short-lived URL
// expires mid-render and the job dies at 80%. An hour covers any clip this pipeline accepts.
const SOURCE_URL_TTL_SEC = 3600;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default withLambda(async (event: HandlerEvent) => {
    let jobId: number;
    try { jobId = Number(JSON.parse(event.body || '{}').jobId); }
    catch { return { statusCode: 400, body: 'Invalid JSON' }; }
    if (!Number.isInteger(jobId)) return { statusCode: 400, body: 'Missing jobId' };

    const db = getDb();

    const [job] = await db.select().from(postRenderJobs).where(eq(postRenderJobs.id, jobId)).limit(1);
    if (!job) return { statusCode: 200, body: 'No such job' };

    // Terminal states must stay terminal, or a duplicate invocation re-renders a post that already
    // published with its overlaid clip.
    const fail = async (message: string) => {
        await db.update(postRenderJobs)
            .set({ status: 'failed', errorMessage: message.slice(0, 500), updatedAt: new Date() })
            .where(eq(postRenderJobs.id, jobId));
        await db.update(scheduledPosts)
            .set({ renderStatus: 'failed', updatedAt: new Date() })
            .where(eq(scheduledPosts.id, job.postId));
    };

    // Claim the job by transitioning queued → rendering. The status predicate IS the claim: a
    // duplicate invocation finds the row already 'rendering', updates nothing, and returns rather
    // than starting a second Lambda render of the same post.
    const claimed = await db.update(postRenderJobs)
        .set({ status: 'rendering', updatedAt: new Date() })
        .where(and(eq(postRenderJobs.id, jobId), eq(postRenderJobs.status, 'queued')))
        .returning({ id: postRenderJobs.id });
    if (!claimed.length) return { statusCode: 200, body: 'Already claimed' };

    await db.update(scheduledPosts)
        .set({ renderStatus: 'rendering', updatedAt: new Date() })
        .where(eq(scheduledPosts.id, job.postId));

    try {
        // post_render_jobs.user_id is ON DELETE SET NULL but content_assets.user_id is NOT NULL, so a
        // user deleted between queueing and rendering would surface as an opaque constraint violation
        // at the very end of a paid render. There is no sensible owner to substitute — fail early.
        if (job.userId == null) {
            await fail('The user who queued this render no longer exists.');
            return { statusCode: 200, body: 'No owner' };
        }
        if (!remotionConfigured()) { await fail('Video rendering is not configured in this environment.'); return { statusCode: 200, body: 'Not configured' }; }
        if (!r2IsConfigured()) { await fail('Media storage is not configured.'); return { statusCode: 200, body: 'No R2' }; }

        // Re-derived, not taken from the job: the overlay design may have been edited after queueing,
        // and the presigned source URL has to be minted fresh because they expire.
        const [post] = await db
            .select({ id: scheduledPosts.id, imageOverlays: scheduledPosts.imageOverlays, audioOverlays: scheduledPosts.audioOverlays })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, job.postId))
            .limit(1);
        if (!post) { await fail('The post no longer exists.'); return { statusCode: 200, body: 'No post' }; }

        const overlays = renderableOverlays(post.imageOverlays);
        const audio = await resolveAudioTracks(db, post.audioOverlays, job.organisationId, presignR2Get);
        const base = await resolveOverlayVideoBase(db, job.postId, job.organisationId);
        if (!base) { await fail('The post no longer has media to render.'); return { statusCode: 200, body: 'No media' }; }

        // Both were removed while the job was queued. Nothing to burn in — clear the gate and let
        // the original media publish rather than failing a post that is perfectly publishable.
        //
        // Audio counts here as much as text: a photo post with a voice note is ONLY publishable as a
        // render, so if the voice note goes away the post reverts to an ordinary photo and needs no
        // render at all.
        if (!overlays.length && !audio.length) {
            await db.update(postRenderJobs)
                .set({ status: 'completed', updatedAt: new Date() })
                .where(eq(postRenderJobs.id, jobId));
            await db.update(scheduledPosts)
                .set({ renderStatus: null, updatedAt: new Date() })
                .where(eq(scheduledPosts.id, job.postId));
            return { statusCode: 200, body: 'No overlays left' };
        }

        const mediaSrc = base.storageKey
            ? await presignR2Get(base.storageKey, SOURCE_URL_TTL_SEC)
            : base.externalUrl!;

        // The snapshot is authoritative (it carries the duration, which is stored nowhere else); the
        // recompute is the fallback for a row written before render_input existed.
        const meta = frameMetaFromJson(job.renderInput) ?? frameMeta({}, base);

        // A still goes in as imageSrc, not videoSrc — the composition branches on which is set, and
        // its calculateMetadata takes the LENGTH from the audio when there is no video to measure.
        const started: StartedRender = await startRender({
            videoSrc: base.kind === 'video' ? mediaSrc : '',
            ...(base.kind === 'image' ? { imageSrc: mediaSrc } : {}),
            audio,
            overlays,
            ...meta,
        });
        await db.update(postRenderJobs)
            .set({ renderId: started.renderId, bucketName: started.bucketName, region: started.region, updatedAt: new Date() })
            .where(eq(postRenderJobs.id, jobId));

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let outputUrl: string | null = null;
        while (true) {
            const progress = await renderProgress(started);
            if (progress.error) { await fail(progress.error); return { statusCode: 200, body: 'Render failed' }; }
            if (progress.done) {
                if (!progress.outputUrl) { await fail('The render finished but produced no file.'); return { statusCode: 200, body: 'No output' }; }
                outputUrl = progress.outputUrl;
                break;
            }
            if (Date.now() > deadline) { await fail('The render took too long and was abandoned.'); return { statusCode: 200, body: 'Timed out' }; }
            await sleep(POLL_INTERVAL_MS);
        }

        // Remotion's output lives in ITS S3 bucket under ITS lifecycle rules. Copy the bytes into our
        // own storage before anything points a published post at them.
        const stored = await persistRemoteMediaToR2({
            orgId: job.organisationId,
            url: outputUrl,
            contentType: 'video/mp4',
            folder: 'rendered',
            label: 'rendered video',
        });

        const [asset] = await db.insert(contentAssets).values({
            userId: job.userId,
            organisationId: job.organisationId,
            name: `Post ${job.postId} — text overlay render`,
            assetType: 'video',
            mimeType: 'video/mp4',
            fileSize: stored.fileSize,
            storageKey: stored.storageKey,
            width: meta.width,
            height: meta.height,
            provider: 'remotion',
            status: 'pending',
        }).returning({ id: contentAssets.id });

        await attachRenderedVideo(db, job.postId, asset.id);

        await db.update(postRenderJobs)
            .set({ status: 'completed', outputAssetId: asset.id, updatedAt: new Date() })
            .where(eq(postRenderJobs.id, jobId));
        // Clearing the gate is the last thing that happens: the publishers pick the post up on their
        // next tick (they run every minute), so this must not go 'done' before the media is attached.
        await db.update(scheduledPosts)
            .set({ renderStatus: 'done', updatedAt: new Date() })
            .where(eq(scheduledPosts.id, job.postId));

        return { statusCode: 200, body: 'Done' };
    } catch (err) {
        console.error(`[render-post-video-background] job ${jobId} failed:`, err);
        await fail(err instanceof Error ? err.message : 'The render failed unexpectedly.').catch(() => {});
        return { statusCode: 200, body: 'Failed' };
    }
});
