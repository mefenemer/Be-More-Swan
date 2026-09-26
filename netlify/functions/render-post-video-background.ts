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
import { and, eq, inArray, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, postRenderJobs, scheduledPosts } from '../../db/schema';
import { presignR2Get } from '../../src/utils/social-publish';
import { persistRemoteMediaToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { attachRenderedVideo, frameMeta, frameMetaFromJson, readForceVideo, readPostVideoEdit, renderPlanFor, renderableOverlays, resolveAudioTracks, resolveEditClips, resolveOverlayVideoBase } from '../../src/lib/post-render';
import { editChangesMedia } from '../../src/lib/video-edit';
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
            .select({
                id: scheduledPosts.id,
                imageOverlays: scheduledPosts.imageOverlays,
                audioOverlays: scheduledPosts.audioOverlays,
                platform: scheduledPosts.platform,
                formatKey: scheduledPosts.formatKey,
                crosspostGroupId: scheduledPosts.crosspostGroupId,
            })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, job.postId))
            .limit(1);
        if (!post) { await fail('The post no longer exists.'); return { statusCode: 200, body: 'No post' }; }

        // Read on its own so a missing column cannot take the whole post query down — see
        // readPostVideoEdit. An environment without it renders every post unedited, as before.
        const videoEdit = await readPostVideoEdit(db, job.postId, job.organisationId);
        const overlays = renderableOverlays(post.imageOverlays);
        const audio = await resolveAudioTracks(db, post.audioOverlays, job.organisationId, presignR2Get);
        const base = await resolveOverlayVideoBase(db, job.postId, job.organisationId);
        if (!base) { await fail('The post no longer has media to render.'); return { statusCode: 200, body: 'No media' }; }

        // ── The timeline ────────────────────────────────────────────────────────────────────────
        // The edit list is the authority on WHAT renders; `base` now only answers "is this a video
        // post at all" and supplies the overlay pin. resolveEditClips falls back to [base] when there
        // is no edit, so a post that has never been edited renders exactly as it always did.
        //
        // Phase 1 matched the trim to base.assetId to avoid applying one clip's in/out points to a
        // different video. That mismatch is gone: the edit now names its own clips, so there is
        // nothing to reconcile.
        const timeline = await resolveEditClips(
            db,
            { videoEdit, orgId: job.organisationId, base, hasTimelineAudio: audio.length > 0 },
            presignR2Get,
        );
        const hasEdit = editChangesMedia(videoEdit);
        // The same plan the trigger computed — ratio, crop position and the fingerprint that decides
        // who else may have this file. Re-derived rather than read off the job because the edit may
        // have been changed while the job sat queued, exactly as the overlays are.
        const plan = renderPlanFor({ ...post, videoEdit }, base, audio.length > 0);

        // Both were removed while the job was queued. Nothing to burn in — clear the gate and let
        // the original media publish rather than failing a post that is perfectly publishable.
        //
        // Audio counts here as much as text: a photo post with a voice note is ONLY publishable as a
        // render, so if the voice note goes away the post reverts to an ordinary photo and needs no
        // render at all.
        // ...unless the render IS the point. An autonomous YouTube Short is a brand card — a still
        // whose words are already drawn into the image — and YouTube has no image post, so the still
        // has to become an mp4 with nothing burned on top. Bailing here would clear the gate and
        // leave a video-only platform holding a photo it can never publish.
        // An edit counts here exactly as text and audio do: a cut or a stitch only exists once the
        // clip has been re-encoded, so a post whose overlays were deleted while its cut survived
        // still has to render. Dropping through would clear the gate and publish the raw original —
        // the first clip alone, including whatever the user cut off the front.
        if (!overlays.length && !audio.length && !hasEdit && !readForceVideo(job.renderInput)) {
            await db.update(postRenderJobs)
                .set({ status: 'completed', updatedAt: new Date() })
                .where(eq(postRenderJobs.id, jobId));
            await db.update(scheduledPosts)
                .set({ renderStatus: null, updatedAt: new Date() })
                .where(eq(scheduledPosts.id, job.postId));
            return { statusCode: 200, body: 'No overlays left' };
        }

        // Every clip is presigned inside resolveEditClips; a still has no timeline and is presigned here.
        if (base.kind === 'video' && !timeline.length) {
            await fail('The post’s video could not be read.');
            return { statusCode: 200, body: 'No source' };
        }
        const mediaSrc = base.kind === 'image'
            ? (base.storageKey ? await presignR2Get(base.storageKey, SOURCE_URL_TTL_SEC) : base.externalUrl!)
            : timeline[0].src;

        // The snapshot is authoritative (it carries the duration, which is stored nowhere else); the
        // recompute is the fallback for a row written before render_input existed.
        const meta = frameMetaFromJson(job.renderInput) ?? frameMeta({}, base);

        // A still goes in as imageSrc, not videoSrc — the composition branches on which is set, and
        // its calculateMetadata takes the LENGTH from the audio when there is no video to measure.
        const started: StartedRender = await startRender({
            // videoSrc + videoTrim describe the FIRST clip only. They are sent alongside `clips`
            // purely so props from this deploy still render on the previous site bundle, which a git
            // push does not update — an old bundle then produces clip one instead of nothing at all.
            videoSrc: base.kind === 'video' ? mediaSrc : '',
            ...(base.kind === 'image' ? { imageSrc: mediaSrc } : {}),
            ...(base.kind === 'video' && (timeline[0].inS || timeline[0].outS != null)
                ? { videoTrim: { inS: timeline[0].inS ?? 0, outS: timeline[0].outS ?? null } }
                : {}),
            ...(base.kind === 'video' ? { clips: timeline } : {}),
            ...(plan.targetRatio ? { targetRatio: plan.targetRatio } : {}),
            ...(plan.framePosition ? { framePosition: plan.framePosition } : {}),
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
            // We KNOW this clip's length — we chose it. Everywhere else duration is read off a
            // <video> in the browser and never stored, which is why validateAgainstFormat can only
            // wave posts through; a render is the one path that can answer honestly, so it should.
            durationS: Math.round(meta.durationInFrames / meta.fps),
            provider: 'remotion',
            status: 'pending',
        }).returning({ id: contentAssets.id });

        await attachRenderedVideo(db, job.postId, asset.id);

        // ── Hand this file to every sibling it genuinely fits ───────────────────────────────────
        // Siblings that wanted the identical output were gated and queued nothing (see the sharing
        // branch in trigger-post-render). Their gate is only cleared here, so this loop is the ONLY
        // thing standing between them and a post that never publishes — it must run on the success
        // path unconditionally, and it must not throw.
        //
        // Each one's fingerprint is RECOMPUTED from its row as it stands now, not trusted from the
        // moment it decided to wait. That check is the whole safety of sharing: text overlays are
        // per-post by design, so a sibling whose words changed in the meantime no longer matches,
        // is left gated, and renders its own file instead of publishing this one's text.
        if (post.crosspostGroupId) {
            try {
                const siblings = await db
                    .select({
                        id: scheduledPosts.id,
                        platform: scheduledPosts.platform,
                        formatKey: scheduledPosts.formatKey,
                        imageOverlays: scheduledPosts.imageOverlays,
                        audioOverlays: scheduledPosts.audioOverlays,
                            })
                    .from(scheduledPosts)
                    .where(and(
                        eq(scheduledPosts.crosspostGroupId, post.crosspostGroupId),
                        eq(scheduledPosts.organisationId, job.organisationId),
                        ne(scheduledPosts.id, job.postId),
                        inArray(scheduledPosts.renderStatus, ['pending']),
                    ));
                for (const sibling of siblings) {
                    // Its OWN base asset, not this post's. Media normally fans out across a group,
                    // but "normally" is not a guarantee — and passing the anchor's base here would
                    // make a sibling carrying different footage fingerprint as identical and receive
                    // this post's video. The fingerprint is only worth checking if what goes into it
                    // belongs to the post being checked.
                    const siblingBase = await resolveOverlayVideoBase(db, sibling.id, job.organisationId);
                    if (!siblingBase) continue;
                    const siblingAudio = await resolveAudioTracks(db, sibling.audioOverlays, job.organisationId, presignR2Get);
                    const siblingEdit = await readPostVideoEdit(db, sibling.id, job.organisationId);
                    const siblingPlan = renderPlanFor({ ...sibling, videoEdit: siblingEdit }, siblingBase, siblingAudio.length > 0);
                    if (siblingPlan.fingerprint !== plan.fingerprint) continue;
                    await attachRenderedVideo(db, sibling.id, asset.id);
                    await db.update(scheduledPosts)
                        .set({ renderStatus: 'done', updatedAt: new Date() })
                        .where(eq(scheduledPosts.id, sibling.id));
                }
            } catch (err) {
                // A sibling left gated is visible and retryable in the Review Queue; failing THIS
                // post because someone else could not be updated would be the worse outcome.
                console.error(`[render-post-video-background] job ${jobId} could not share its output:`, err);
            }
        }

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
