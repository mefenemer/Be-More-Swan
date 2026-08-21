// netlify/functions/get-post-image.ts
// Return the backdrop the text-overlay editor drags text onto: a photo post's CLEAN base image as a
// same-origin data URL, or — for a video post — the clip's asset id and a fetchable media URL for the
// client to grab a frame from.
//
// Why a data URL (not the presigned/CDN URL directly): the editor bakes the overlays into the image
// with an HTML canvas, and canvas.toBlob() throws SecurityError if the <img> was loaded cross-origin
// without CORS. R2 presigned URLs and Pexels CDN URLs are cross-origin and not guaranteed CORS-clean,
// so we fetch the bytes server-side and hand back a data: URL, which is same-origin by definition and
// never taints the canvas — no bucket/CDN CORS config required.
//
// "Clean base" = overlay_base_asset_id when set (the pre-bake original, so re-edits never composite
// onto an already-flattened image), otherwise the post's current first image asset.
//
// GET ?postId=<id>  → { dataUrl, assetId, mimeType, overlays }              — photo
//                   → { isVideo: true, mediaUrl, assetId, mimeType, overlays } — video
// GET ?assetId=<id> → { dataUrl, assetId, mimeType, overlays: [] }
//   Auth: aura_session (requireTenant). The post — or the asset — must belong to the caller's org.
//
// ⚠️ THE assetId FORM EXISTS FOR THE NEWSLETTER DESIGN STUDIO, which puts text and stickers on an
// image that belongs to no scheduled post at all. Everything about the canvas-taint problem above
// is identical there, so it reuses this rather than growing a second data-URL endpoint with its own
// size cap and its own idea of what "clean base" means. The overlays come back empty because a
// newsletter's overlays live on the design block, not on a row in this database.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolvePostImage, resolvePostVideo, fetchImageBytes } from '../../src/utils/social-publish';
import { withLambda } from '@netlify/aws-lambda-compat';

// Netlify returns the whole body in one response (~6 MB cap). Base64 inflates ~33%, so refuse to
// build a data URL past this to fail cleanly rather than truncate into a corrupt image.
const MAX_IMAGE_BYTES = 4_000_000;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    // ── The bare-asset form. Org-scoped by the same rule as everything else on this endpoint.
    const bareAssetId = Number(event.queryStringParameters?.assetId);
    if (Number.isInteger(bareAssetId) && bareAssetId > 0) {
        const [owned] = await db
            .select({ id: contentAssets.id })
            .from(contentAssets)
            .where(and(eq(contentAssets.id, bareAssetId), eq(contentAssets.organisationId, orgId)))
            .limit(1);
        if (!owned) return { statusCode: 404, body: JSON.stringify({ error: 'Image not found.' }) };
        return dataUrlFor(db, bareAssetId, `asset ${bareAssetId}`);
    }

    const postId = Number(event.queryStringParameters?.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId or assetId required.' }) };

    // Ownership + the pinned clean base (if any).
    const [post] = await db
        .select({ id: scheduledPosts.id, overlayBaseAssetId: scheduledPosts.overlayBaseAssetId, imageOverlays: scheduledPosts.imageOverlays, contentAssetIds: scheduledPosts.contentAssetIds })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Resolve the asset id to render. Prefer the pinned base; else the current first image asset
    // (junction table is canonical, with the deprecated array as a fallback — mirrors media-proxy).
    let assetId = post.overlayBaseAssetId ?? null;
    if (assetId == null) {
        const junction = await db
            .select({ contentAssetId: scheduledPostAssets.contentAssetId, position: scheduledPostAssets.position })
            .from(scheduledPostAssets)
            .where(eq(scheduledPostAssets.scheduledPostId, postId));
        const ids = [
            ...junction.sort((a, b) => a.position - b.position).map(r => r.contentAssetId),
            ...(Array.isArray(post.contentAssetIds) ? (post.contentAssetIds as number[]) : []),
        ];
        assetId = [...new Set(ids)][0] ?? null;
    }
    if (assetId == null) return { statusCode: 404, body: JSON.stringify({ error: 'This post has no image to overlay.' }) };

    // A VIDEO post gets a different answer, not an error. The editor needs something to drag text
    // onto; for a clip that is a frame of the clip, which only a browser can decode. So we hand back
    // the asset id and a fetchable media URL and let the client grab a frame off a <video> element
    // (_pceCaptureVideoFrame). No bytes come through this function — a clip can be 500 MB, far past
    // the response cap that makes the data-URL trick work for stills.
    //
    // Nothing is composited from this frame either way: a photo's overlays are baked in the browser,
    // but a video's are burned in by Remotion Lambda from the ORIGINAL clip. The frame is purely a
    // backdrop for positioning, which is why an approximate one is fine.
    const video = await resolvePostVideo(db, [assetId]);
    if (video) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            body: JSON.stringify({
                isVideo: true, assetId, mediaUrl: video.url, mimeType: video.mimeType,
                overlays: Array.isArray(post.imageOverlays) ? post.imageOverlays : [],
            }),
        };
    }

    return dataUrlFor(db, assetId, `post ${postId}`, Array.isArray(post.imageOverlays) ? post.imageOverlays : []);
});

/** The bytes as a same-origin data: URL — the only form an HTML canvas can bake without tainting. */
async function dataUrlFor(
    db: ReturnType<typeof getDb>,
    assetId: number,
    label: string,
    overlays: unknown[] = [],
) {
    const image = await resolvePostImage(db, [assetId]);
    if (!image) return { statusCode: 404, body: JSON.stringify({ error: 'Image could not be resolved.' }) };

    try {
        const bytes = await fetchImageBytes(image.url);
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
            return { statusCode: 413, body: JSON.stringify({ error: 'Image is too large to edit in the browser.' }) };
        }
        const b64 = Buffer.from(bytes).toString('base64');
        const dataUrl = `data:${image.mimeType};base64,${b64}`;
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            body: JSON.stringify({ dataUrl, assetId, mimeType: image.mimeType, overlays }),
        };
    } catch (err) {
        console.error(`[get-post-image] ${label} error:`, err instanceof Error ? err.message : err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not load the image bytes.' }) };
    }
}
