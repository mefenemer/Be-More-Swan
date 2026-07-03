// netlify/functions/attach-draft-media.ts
// Attach an EXISTING content asset (from My Content, or an AI-generated video produced by
// generate-ai-video) to an AI-review-queue draft, swapping out whatever media is currently attached.
//
// POST { postId, assetId }  → { assetId, thumbnailUrl }
//   Auth: aura_session (requireTenant). Both the post and the asset must belong to the caller's org.
//
// This mirrors the media-swap performed by regenerate-post-media / pexels-search(select), but for an
// asset the user has already chosen rather than one generated on the spot. No credits are charged.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { presignR2Get } from '../../src/utils/social-publish';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; assetId?: number };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    const assetId = Number(body.assetId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };
    if (!Number.isInteger(assetId)) return { statusCode: 400, body: JSON.stringify({ error: 'assetId required.' }) };

    // Ownership: the draft must belong to this org.
    const [post] = await db
        .select({ id: scheduledPosts.id })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Ownership: the asset must belong to this org and be a usable visual.
    const [asset] = await db
        .select({ id: contentAssets.id, assetType: contentAssets.assetType, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
        .from(contentAssets)
        .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId)))
        .limit(1);
    if (!asset) return { statusCode: 404, body: JSON.stringify({ error: 'Media not found.' }) };
    if (asset.assetType !== 'image' && asset.assetType !== 'video') {
        return { statusCode: 422, body: JSON.stringify({ error: 'Only images and videos can be attached to a post.' }) };
    }

    // Swap the attached media: drop the old junction rows, attach the chosen asset, keep the
    // deprecated contentAssetIds array in sync (resolvePostImage still reads it during migration).
    await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, postId));
    await db.insert(scheduledPostAssets)
        .values({ scheduledPostId: postId, contentAssetId: assetId, position: 0 })
        .onConflictDoNothing();
    // Issue #55: swapping in new media resolves any "media deleted" flag from the Review Queue.
    await db.update(scheduledPosts)
        .set({ contentAssetIds: [assetId], mediaMissing: false, mediaMissingNote: null, updatedAt: new Date() })
        .where(eq(scheduledPosts.id, postId));

    let thumbnailUrl: string | null = null;
    if (asset.storageKey) { try { thumbnailUrl = await presignR2Get(asset.storageKey); } catch { /* ignore */ } }
    if (!thumbnailUrl && asset.externalUrl) thumbnailUrl = asset.externalUrl;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, assetType: asset.assetType, thumbnailUrl }),
    };
};
