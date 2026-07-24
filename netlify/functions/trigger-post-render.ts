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
import { postRenderJobs, scheduledPosts } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { frameMeta, renderableOverlays, resolveOverlayVideoBase } from '../../src/lib/post-render';
import { remotionConfigured } from '../../src/lib/remotion-lambda';
import { r2IsConfigured } from '../../src/lib/media-persist';
import { withLambda } from '@netlify/aws-lambda-compat';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// MUST be awaited — see the same note in canva-import.ts. Lambda freezes the execution environment
// the moment the handler returns, so an un-awaited trigger never leaves the box and the job sits
// 'queued' forever with the post gated behind it. Posting to a -background function returns 202
// immediately, so awaiting costs only the round-trip.
async function triggerWorker(headers: Record<string, string | undefined>, jobId: number): Promise<boolean> {
    const baseUrl = resolveBaseUrl(headers);
    if (!baseUrl) { console.error('[trigger-post-render] no base URL — worker not triggered for job', jobId); return false; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/render-post-video-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId }),
            signal: controller.signal,
        });
        return res.ok;
    } catch (err) {
        console.error('[trigger-post-render] failed to trigger worker:', err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

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
        .select({ id: scheduledPosts.id, imageOverlays: scheduledPosts.imageOverlays })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    const overlays = renderableOverlays(post.imageOverlays);
    const base = await resolveOverlayVideoBase(db, postId, orgId);

    // Not a video post → the caller bakes in the browser instead. Clear any stale gate so a post
    // whose media was swapped from video to photo can still publish.
    if (!base) {
        await db.update(scheduledPosts).set({ renderStatus: null, updatedAt: new Date() }).where(eq(scheduledPosts.id, postId));
        return json(200, { skipped: 'not_video' });
    }
    // A video with no text needs no render at all — publish the original clip.
    if (!overlays.length) {
        await db.update(scheduledPosts).set({ renderStatus: null, updatedAt: new Date() }).where(eq(scheduledPosts.id, postId));
        return json(200, { skipped: 'no_overlays' });
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

    const meta = frameMeta(body, base);

    const [job] = await db.insert(postRenderJobs).values({
        organisationId: orgId,
        postId,
        userId,
        status: 'queued',
        renderInput: meta,
    }).returning({ id: postRenderJobs.id });

    await db.update(scheduledPosts)
        .set({ renderStatus: 'pending', updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));

    const dispatched = await triggerWorker(event.headers as Record<string, string | undefined>, job.id);
    if (!dispatched) {
        // Nothing will ever process the row, so un-gate the post and report the failure rather than
        // approving it into a permanent 'pending' render.
        await db.update(postRenderJobs)
            .set({ status: 'failed', errorMessage: 'The render worker could not be reached.', updatedAt: new Date() })
            .where(eq(postRenderJobs.id, job.id));
        await db.update(scheduledPosts)
            .set({ renderStatus: null, updatedAt: new Date() })
            .where(eq(scheduledPosts.id, postId));
        return json(502, { error: 'Could not start the video render — please try again in a moment.' });
    }

    return json(202, { jobId: job.id, renderStatus: 'pending', overlays: overlays.length });
});
