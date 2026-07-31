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

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { frameMeta, queuePostRender, renderableOverlays, resolveOverlayVideoBase } from '../../src/lib/post-render';
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
        .select({ id: scheduledPosts.id, imageOverlays: scheduledPosts.imageOverlays, audioOverlays: scheduledPosts.audioOverlays })
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

    // Does this actually need a render? Text alone only forces one on a VIDEO — a photo's text bakes
    // in the browser, which is faster, free, and font-perfect. Audio forces one either way, and on a
    // photo it forces a render that turns the still into an mp4, because no platform accepts an image
    // with sound.
    if (!needsVideoRender({ hasVideo: base.kind === 'video', textOverlays: overlays.length, audioOverlays: audioCount })) {
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

    const queued = await queuePostRender(db, {
        orgId,
        postId,
        userId,
        input: frameMeta(body, base),
        baseUrl: resolveBaseUrl(event.headers as Record<string, string | undefined>),
    });
    if (!queued.ok) return json(502, { error: 'Could not start the video render — please try again in a moment.' });

    return json(202, { jobId: queued.jobId, renderStatus: 'pending', overlays: overlays.length });
});
