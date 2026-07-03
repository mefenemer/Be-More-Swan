// media-proxy.ts — public media source for the Instagram publisher (publish-instagram.ts).
//
// Meta's Graph media-container API (image_url / video_url) requires a publicly reachable
// URL that returns the raw image/video bytes. Our assets live as either a private R2 object
// (storageKey → presigned URL) or a hotlinked Pexels CDN URL (externalUrl). This function
// resolves a scheduled post's first image asset and 302-redirects to that fetchable URL;
// both a presigned R2 URL and a Pexels CDN URL satisfy Meta's public-reachability requirement
// and return raw bytes. A redirect (rather than streaming) avoids Netlify's response payload
// limit, which raw image/video bytes would routinely exceed.
//
// GET ?postId=<id>  → 302 to the resolved media URL (or 404 if the post has no image asset).

import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { resolvePostImage } from '../../src/utils/social-publish';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const postId = Number(event.queryStringParameters?.postId);
    if (!Number.isFinite(postId)) {
        return { statusCode: 400, body: 'postId is required.' };
    }

    const db = getDb();

    try {
        // Resolve the post and confirm it exists.
        const [post] = await db
            .select({ id: scheduledPosts.id, contentAssetIds: scheduledPosts.contentAssetIds })
            .from(scheduledPosts)
            .where(eq(scheduledPosts.id, postId))
            .limit(1);
        if (!post) return { statusCode: 404, body: 'Post not found.' };

        // Collect attached asset IDs: junction table (canonical, US-DB-1.2.1) + the
        // deprecated contentAssetIds array, in case the migration hasn't backfilled it.
        const junction = await db
            .select({ contentAssetId: scheduledPostAssets.contentAssetId, position: scheduledPostAssets.position })
            .from(scheduledPostAssets)
            .where(eq(scheduledPostAssets.scheduledPostId, postId));

        const ids = [
            ...junction.sort((a, b) => a.position - b.position).map(r => r.contentAssetId),
            ...(Array.isArray(post.contentAssetIds) ? (post.contentAssetIds as number[]) : []),
        ];
        // De-dupe while preserving order (junction takes precedence).
        const uniqueIds = [...new Set(ids)];

        const image = await resolvePostImage(db, uniqueIds);
        if (!image) return { statusCode: 404, body: 'No image asset attached to this post.' };

        // 302 to the fetchable URL (presigned R2 or Pexels CDN). Meta follows the redirect
        // and fetches the raw bytes from there.
        return {
            statusCode: 302,
            headers: {
                Location: image.url,
                'Content-Type': image.mimeType,
                'Cache-Control': 'no-store',
            },
            body: '',
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[media-proxy] post ${postId} error:`, msg);
        return { statusCode: 500, body: 'Internal Server Error' };
    }
};
