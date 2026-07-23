// netlify/functions/get-post-image.ts
// Return a post's CLEAN base image as a same-origin data URL, for the text-overlay editor.
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
// GET ?postId=<id> → { dataUrl, assetId, mimeType }
//   Auth: aura_session (requireTenant). The post must belong to the caller's org.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolvePostImage, fetchImageBytes } from '../../src/utils/social-publish';
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

    const postId = Number(event.queryStringParameters?.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

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
            body: JSON.stringify({ dataUrl, assetId, mimeType: image.mimeType, overlays: Array.isArray(post.imageOverlays) ? post.imageOverlays : [] }),
        };
    } catch (err) {
        console.error(`[get-post-image] post ${postId} error:`, err instanceof Error ? err.message : err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not load the image bytes.' }) };
    }
});
