// netlify/functions/trigger-post-render.ts
// Phase 4: queue a Remotion Lambda render of a video post's timed text overlays.
//
//   POST { postId, width?, height?, durationS? }
//     Auth: aura_session (requireTenant). The post must belong to the caller's org.
//
//   202 { jobId, renderStatus: 'pending' }   — queued; the worker is running
//   200 { skipped: 'not_video' | 'no_overlays' } — nothing to render (the caller carries on)
//   503 { code: 'RENDER_UNAVAILABLE' }       — Remotion isn't configured in this environment
//
// This is the video twin of the browser bake for photos (ImageOverlayEditor.bake): a browser cannot
// encode video, so the flatten moves server-side and becomes asynchronous. The approve flow calls
// this INSTEAD of baking when the post's media is a video, then approves as normal — the post lands
// in 'scheduled' with render_status 'pending', and the publishers refuse to pick it up until the
// render lands (see the render_status gate in publish-social-posts / publish-instagram /
// publish-facebook). So approval stays instant and the clip is never published un-overlaid.
//
// width/height/durationS come from the CLIENT because they are read off the <video> element and
// stored nowhere — content_assets has no duration column and width/height only for some providers.
// They are advisory: frameMeta clamps them and falls back to the asset's own values. Nothing
// security-relevant rides on them; the worst a bad value buys is a wrongly-sized render of the
// caller's own clip.

import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { postRenderJobs, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { postFormatSpec } from '../../src/config/post-formats';
import { frameMeta, frameMetaFromJson, queuePostRender, renderableOverlays, resolveOverlayVideoBase } from '../../src/lib/post-render';
import { needsVideoRender, renderableAudio } from '../../src/lib/audio-overlays';
import { remotionConfigured } from '../../src/lib/remotion-lambda';
import { r2IsConfigured } from '../../src/lib/media-persist';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Queueing + dispatch + the un-gate-on-failure rollback live in queuePostRender (post-render.ts),
// shared with the autonomous Short drafter. Both paths must fail the same way: a post left at
// render_status 'pending' with no worker behind it can never publish.

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { postId?: number; width?: number; height?: number; durationS?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    // Ownership + the stored overlay design.
    const [post] = await db
        .select({
            id: scheduledPosts.id,
            imageOverlays: scheduledPosts.imageOverlays,
            audioOverlays: scheduledPosts.audioOverlays,
            formatKey: scheduledPosts.formatKey,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    const overlays = renderableOverlays(post.imageOverlays);
    const audioCount = renderableAudio(post.audioOverlays).length;
    const base = await resolveOverlayVideoBase(db, postId, orgId);

    // No media at all → nothing to render onto. Clear any stale gate so the post can still publish.
    if (!base) {
        await db.update(scheduledPosts).set({ renderStatus: null, updatedAt: new Date() }).where(eq(scheduledPosts.id, postId));
        return json(200, { skipped: 'no_media' });
    }

    // ── A still on a video-only FORMAT must become an mp4, even with nothing to burn in ──────────
    // needsVideoRender asks "is there something to burn IN?" — text on a video, or audio. That is
    // the right question for every post a reviewer composes by hand, and the wrong one for a post
    // whose FORMAT is the whole reason a render exists. An autonomous YouTube Short is a brand card:
    // a still whose words are already drawn into the image, on a format that carries video and
    // nothing else. The autonomous drafter has always known this and passes `forceVideo`.
    //
    // This endpoint is ALSO the Review Queue's "Try the render again" button, and it did not know.
    // So a Short whose first render failed took the branch below on retry: it answered
    // `skipped: 'not_video'`, CLEARED render_status, and returned 200. The client reads a `skipped`
    // reply as "nothing to render after all, the post is publishable now" and drops the banner — so
    // it looked like the retry had worked. The post kept its PNG, lost its publish gate, and the
    // format router then refused it, correctly, with "A Short can't carry this — Short takes video,
    // and this is image". Two paths building the same render input independently is what allowed it.
    const declared = postFormatSpec(post.formatKey);
    const forceVideo = base.kind === 'image' && declared?.media === 'video';

    if (!forceVideo && !needsVideoRender({ hasVideo: base.kind === 'video', textOverlays: overlays.length, audioOverlays: audioCount })) {
        await db.update(scheduledPosts).set({ renderStatus: null, updatedAt: new Date() }).where(eq(scheduledPosts.id, postId));
        // 'not_video' keeps the existing contract with gpQueueVideoRender: a photo whose text still
        // bakes in the browser must fall through to that path, not stop here.
        return json(200, { skipped: base.kind === 'video' ? 'no_overlays' : 'not_video' });
    }

    // Refuse BEFORE gating the post. Setting render_status with no renderer behind it would strand
    // the post permanently unpublishable; a 503 lets the reviewer decide (remove the text, or wait).
    if (!remotionConfigured()) {
        return json(503, {
            error: 'Video text rendering is not available in this environment yet.',
            code: 'RENDER_UNAVAILABLE',
        });
    }
    if (!r2IsConfigured()) {
        // The render would succeed and then have nowhere durable to land — Remotion's S3 output is
        // not ours to depend on long-term. Fail now rather than after the Lambda bill.
        return json(503, {
            error: 'Media storage is not configured — video rendering is unavailable.',
            code: 'RENDER_UNAVAILABLE',
        });
    }

    // ── Frame metadata, and why a forced render prefers the PREVIOUS job's ──────────────────────
    // width/height/durationS normally arrive from the client, read off the <video> element. A still
    // has no <video> to read, so on a forced render the body is empty and frameMeta would fall back
    // to its generic 15s default — quietly turning a 10s Short into a 15s one on retry, with no
    // error anywhere. The earlier job's snapshot holds the numbers the drafter actually chose, and
    // reusing them is precisely what "try the render again" ought to mean.
    let meta = frameMeta(body, base);
    if (forceVideo) {
        const [prior] = await db
            .select({ renderInput: postRenderJobs.renderInput })
            .from(postRenderJobs)
            .where(and(eq(postRenderJobs.postId, postId), eq(postRenderJobs.organisationId, orgId)))
            .orderBy(desc(postRenderJobs.id))
            .limit(1);
        meta = frameMetaFromJson(prior?.renderInput) ?? meta;
    }

    const queued = await queuePostRender(db, {
        orgId,
        postId,
        userId,
        // forceVideo travels ON THE JOB because the worker cannot re-derive it: it sees no overlays
        // and no audio and would take its own "nothing to do" bail-out, clearing the gate and
        // leaving the still exactly as this endpoint used to.
        input: { ...meta, ...(forceVideo ? { forceVideo: true } : {}) },
        baseUrl: resolveBaseUrl(event.headers as Record<string, string | undefined>),
    });
    if (!queued.ok) return json(502, { error: 'Could not start the video render — please try again in a moment.' });

    return json(202, { jobId: queued.jobId, renderStatus: 'pending', overlays: overlays.length });
});
