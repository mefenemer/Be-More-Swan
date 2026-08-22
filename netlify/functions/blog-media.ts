// netlify/functions/blog-media.ts
// Autonomous Content Engine — US 2.1: wire media onto a blog post.
//
// Reuses the existing content_assets library (uploads, AI-generated images via generate-ai-image,
// etc.). The hero/feature graphic is a direct FK (blog_posts.feature_asset_id); additional inline
// media is ordered via the blog_post_assets junction. Org-scoped via requireTenant; no credits are
// charged here (generation/upload already metered upstream).
//
// GET  ?blogPostId=n                                             → { feature, inline[] } (URLs resolved)
// POST { blogPostId, action:'attach'|'detach', role, assetId? }  → { feature, inline[] }
//   role: 'feature' | 'inline'
//   attach may pass a `pexelsCandidate` instead of `assetId`: we mint a hotlinked content_asset
//   from it (createPexelsAsset — no scheduledPosts coupling) and attach that. Candidates come from
//   the existing pexels-search endpoint; attribution rides on contentAssets.attributionName.
//   `pexelsType: 'image' | 'video'` says WHICH search it came from — the two candidate shapes are
//   indistinguishable here and a video minted as an image renders as a broken picture.

import { HandlerEvent } from '@netlify/functions';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { blogPosts, blogPostAssets, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { resolveAssetDisplayUrl } from '../../src/utils/social-publish';
import { createPexelsAsset, type PexelsCandidate, type PexelsVideoCandidate } from '../../src/utils/pexels';
import { withLambda } from '@netlify/aws-lambda-compat';

type Db = ReturnType<typeof getDb>;

// The post's current media, with a freshly-resolved URL for each asset (presigned R2 / external CDN).
async function loadMedia(db: Db, orgId: number, blogPostId: number, featureAssetId: number | null) {
    let feature: { assetId: number; url: string | null; name: string; assetType: string | null; attribution: string | null } | null = null;
    if (featureAssetId) {
        const [a] = await db
            .select({
                id: contentAssets.id, name: contentAssets.name, assetType: contentAssets.assetType,
                storageUrl: contentAssets.storageUrl, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
                attributionName: contentAssets.attributionName,
            })
            .from(contentAssets)
            .where(and(eq(contentAssets.id, featureAssetId), eq(contentAssets.organisationId, orgId)))
            .limit(1);
        // The asset may have been deleted from the library since it was attached — degrade gracefully.
        if (a) feature = { assetId: a.id, url: await resolveAssetDisplayUrl(a), name: a.name, assetType: a.assetType, attribution: a.attributionName };
    }

    const rows = await db
        .select({
            assetId: blogPostAssets.contentAssetId, position: blogPostAssets.position,
            name: contentAssets.name, assetType: contentAssets.assetType,
            storageUrl: contentAssets.storageUrl, storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl,
        })
        .from(blogPostAssets)
        .innerJoin(contentAssets, eq(contentAssets.id, blogPostAssets.contentAssetId))
        .where(and(eq(blogPostAssets.blogPostId, blogPostId), eq(contentAssets.organisationId, orgId)))
        .orderBy(asc(blogPostAssets.position));
    const inline = await Promise.all(rows.map(async (r) => ({
        assetId: r.assetId, position: r.position, name: r.name, assetType: r.assetType, url: await resolveAssetDisplayUrl(r),
    })));

    return { feature, inline };
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    // Resolve + verify the post belongs to this org (shared by GET and POST).
    async function getPost(blogPostId: number) {
        const [post] = await db
            .select({ id: blogPosts.id, featureAssetId: blogPosts.featureAssetId })
            .from(blogPosts)
            .where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, orgId)))
            .limit(1);
        return post;
    }

    if (event.httpMethod === 'GET') {
        const blogPostId = Number(event.queryStringParameters?.blogPostId);
        if (!Number.isFinite(blogPostId)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };
        const post = await getPost(blogPostId);
        if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };
        return { statusCode: 200, body: JSON.stringify(await loadMedia(db, orgId, blogPostId, post.featureAssetId)) };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const blogPostId = Number(body.blogPostId);
    const action = body.action === 'detach' ? 'detach' : 'attach';
    const role = body.role === 'inline' ? 'inline' : 'feature';
    if (!Number.isFinite(blogPostId)) return { statusCode: 400, body: JSON.stringify({ error: 'blogPostId is required.' }) };

    const post = await getPost(blogPostId);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Blog post not found.' }) };

    if (action === 'detach') {
        if (role === 'feature') {
            await db.update(blogPosts).set({ featureAssetId: null, updatedAt: new Date() })
                .where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, orgId)));
        } else {
            const assetId = Number(body.assetId);
            if (!Number.isFinite(assetId)) return { statusCode: 400, body: JSON.stringify({ error: 'assetId is required to detach inline media.' }) };
            await db.delete(blogPostAssets)
                .where(and(eq(blogPostAssets.blogPostId, blogPostId), eq(blogPostAssets.contentAssetId, assetId)));
        }
        return { statusCode: 200, body: JSON.stringify(await loadMedia(db, orgId, blogPostId, role === 'feature' ? null : post.featureAssetId)) };
    }

    // action === 'attach'. Either an existing library asset (assetId) or a Pexels candidate to mint.
    let assetId: number;
    if (body.pexelsCandidate) {
        const c = body.pexelsCandidate as PexelsCandidate | PexelsVideoCandidate;
        if (!c.providerAssetId || !c.url) {
            return { statusCode: 400, body: JSON.stringify({ error: 'A valid pexelsCandidate is required.' }) };
        }
        // Stock video as well as stock photos (plan §4 Phase 5.2). The candidate shapes are
        // different searches from the same provider, so the caller says which it picked — guessing
        // from the URL would mint a video as an image and render it as a broken picture.
        // ⚠️ The hero is unaffected: a non-image asset is refused for the feature role below,
        // whatever the type says here.
        const pexelsType = body.pexelsType === 'video' ? 'video' : 'image';
        assetId = await createPexelsAsset(db, { userId: ctx.userId, orgId, candidate: c, assetType: pexelsType });
    } else {
        assetId = Number(body.assetId);
        if (!Number.isFinite(assetId)) return { statusCode: 400, body: JSON.stringify({ error: 'assetId is required.' }) };
    }

    // The asset must belong to this org and be a usable visual.
    const [asset] = await db
        .select({ id: contentAssets.id, assetType: contentAssets.assetType })
        .from(contentAssets)
        .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId)))
        .limit(1);
    if (!asset) return { statusCode: 404, body: JSON.stringify({ error: 'Media not found.' }) };
    if (role === 'feature' && asset.assetType !== 'image') {
        return { statusCode: 422, body: JSON.stringify({ error: 'The feature graphic must be an image.' }) };
    }
    // The body takes image, video and audio; the feature slot is image-only and already rejected
    // above. Audio in the hero stays explicitly out of scope (plan §6).
    if (asset.assetType !== 'image' && asset.assetType !== 'video' && asset.assetType !== 'audio') {
        return { statusCode: 422, body: JSON.stringify({ error: 'Only images, videos and audio can be attached.' }) };
    }

    let nextFeature = post.featureAssetId;
    if (role === 'feature') {
        await db.update(blogPosts).set({ featureAssetId: assetId, updatedAt: new Date() })
            .where(and(eq(blogPosts.id, blogPostId), eq(blogPosts.organisationId, orgId)));
        nextFeature = assetId;
    } else {
        // Append after the current last position; idempotent on the (post, asset) unique key.
        const existing = await db.select({ position: blogPostAssets.position })
            .from(blogPostAssets).where(eq(blogPostAssets.blogPostId, blogPostId));
        const nextPos = existing.reduce((max, r) => Math.max(max, r.position + 1), 0);
        await db.insert(blogPostAssets)
            .values({ blogPostId, contentAssetId: assetId, position: nextPos })
            .onConflictDoNothing();
    }

    return { statusCode: 200, body: JSON.stringify(await loadMedia(db, orgId, blogPostId, nextFeature)) };
});
