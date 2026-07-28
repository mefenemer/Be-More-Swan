// netlify/functions/attach-draft-media.ts
// Attach an EXISTING content asset (from My Content, or an AI-generated video produced by
// generate-ai-video) to an AI-review-queue draft, swapping out whatever media is currently attached.
//
// POST { postId, assetId, applyToGroup? }  → { assetId, thumbnailUrl, postIds }
//   Auth: aura_session (requireTenant). Both the post and the asset must belong to the caller's org.
//
// The media lands on every cross-post sibling of `postId` by default — one post going to four
// platforms is still one post, so a picture added to it belongs on all four. Pass applyToGroup:false
// to change a single platform. See src/utils/crosspost-media.ts for the rules that bound the fan-out.
//
// This mirrors the media-swap performed by regenerate-post-media / pexels-search(select), but for an
// asset the user has already chosen rather than one generated on the spot. No credits are charged.

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { presignR2Get } from '../../src/utils/social-publish';
import { mediaTargetPostIds } from '../../src/utils/crosspost-media';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    let body: { postId?: number; assetId?: number; keepOverlays?: boolean; applyToGroup?: boolean };
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

    // Which rows this write touches. A picture added to a cross-post belongs on every platform of
    // that post, not just the tab that happened to be selected — see src/utils/crosspost-media.ts.
    //
    // The approve-time overlay bake is the one caller that must NOT fan out: it uploads an image
    // flattened against ONE post's overlay design, so pushing it onto the siblings would stamp that
    // platform's text on all of them. It is also the only caller that sends keepOverlays.
    const targetIds = await mediaTargetPostIds(db, {
        postId,
        orgId,
        applyToGroup: body.applyToGroup ?? !body.keepOverlays,
    });

    // Swap the attached media: drop the old junction rows, attach the chosen asset, keep the
    // deprecated contentAssetIds array in sync (resolvePostImage still reads it during migration).
    await db.delete(scheduledPostAssets).where(inArray(scheduledPostAssets.scheduledPostId, targetIds));
    await db.insert(scheduledPostAssets)
        .values(targetIds.map(id => ({ scheduledPostId: id, contentAssetId: assetId, position: 0 })))
        .onConflictDoNothing();
    // Issue #55: swapping in new media resolves any "media deleted" flag from the Review Queue.
    // Text overlays are designed against a specific image, so swapping the photo through the normal
    // media UI clears them (and the base pin). The approve-time bake attaches its flattened image
    // with keepOverlays:true so the design/pin survive that internal swap (idempotent re-bake).
    const overlayReset = body.keepOverlays ? {} : { imageOverlays: null, overlayBaseAssetId: null };
    await db.update(scheduledPosts)
        .set({ contentAssetIds: [assetId], mediaMissing: false, mediaMissingNote: null, updatedAt: new Date(), ...overlayReset })
        .where(inArray(scheduledPosts.id, targetIds));

    let thumbnailUrl: string | null = null;
    if (asset.storageKey) { try { thumbnailUrl = await presignR2Get(asset.storageKey); } catch { /* ignore */ } }
    if (!thumbnailUrl && asset.externalUrl) thumbnailUrl = asset.externalUrl;

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        // postIds is every row this write landed on, so the editor can update the cached siblings
        // rather than leaving their tabs showing the media they no longer carry.
        body: JSON.stringify({ assetId, assetType: asset.assetType, thumbnailUrl, postIds: targetIds }),
    };
});
