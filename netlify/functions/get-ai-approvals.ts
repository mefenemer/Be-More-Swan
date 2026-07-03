// netlify/functions/get-ai-approvals.ts
// Epic 3 US6: the AI Review Dashboard data source — autonomous (assistant-drafted) posts awaiting
// approval, with a media thumbnail, the contextual reasoning note, and filters.
//
// GET ?platform=&type=image|video&campaign=
//   → { drafts: [{ id, platform, postFormat, caption, hashtags, generationReason, publishDate,
//                  assistantName, campaign, mediaType, thumbnailUrl }], count }
//   Auth: aura_session cookie.

import { Handler } from '@netlify/functions';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets, aiAssistants, organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { presignR2Get } from '../../src/utils/social-publish';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    const q = event.queryStringParameters || {};

    const drafts = await db
        .select({
            id: scheduledPosts.id,
            platform: scheduledPosts.platform,
            postFormat: scheduledPosts.postFormat,
            caption: scheduledPosts.caption,
            hashtags: scheduledPosts.hashtags,
            generationReason: scheduledPosts.generationReason,
            publishDate: scheduledPosts.publishDate,
            campaign: scheduledPosts.campaign,
            assistantName: aiAssistants.name,
        })
        .from(scheduledPosts)
        .leftJoin(aiAssistants, eq(scheduledPosts.assistantId, aiAssistants.id))
        .where(and(
            eq(scheduledPosts.organisationId, orgId),
            eq(scheduledPosts.status, 'pending_approval'),
            eq(scheduledPosts.isAutonomous, true),
        ))
        .orderBy(desc(scheduledPosts.generatedAt));

    // Resolve a media thumbnail + type per post from its attached content_assets.
    const ids = drafts.map(d => d.id);
    const assetRows = ids.length ? await db
        .select({
            postId: scheduledPostAssets.scheduledPostId,
            position: scheduledPostAssets.position,
            assetType: contentAssets.assetType,
            storageKey: contentAssets.storageKey,
            externalUrl: contentAssets.externalUrl,
        })
        .from(scheduledPostAssets)
        .innerJoin(contentAssets, eq(scheduledPostAssets.contentAssetId, contentAssets.id))
        .where(inArray(scheduledPostAssets.scheduledPostId, ids)) : [];

    // First asset (lowest position) per post.
    const firstAsset = new Map<number, typeof assetRows[number]>();
    for (const r of assetRows.sort((a, b) => a.position - b.position)) {
        if (!firstAsset.has(r.postId)) firstAsset.set(r.postId, r);
    }

    let out = await Promise.all(drafts.map(async d => {
        const asset = firstAsset.get(d.id);
        let thumbnailUrl: string | null = null;
        const mediaType = asset?.assetType ?? (d.postFormat === 'video' || d.postFormat === 'reel' ? 'video' : 'image');
        if (asset?.storageKey) { try { thumbnailUrl = await presignR2Get(asset.storageKey); } catch { /* ignore */ } }
        if (!thumbnailUrl && asset?.externalUrl) thumbnailUrl = asset.externalUrl;
        return { ...d, mediaType, thumbnailUrl };
    }));

    // Filters (US6 sorting & filtering).
    if (q.platform) out = out.filter(d => d.platform === q.platform);
    if (q.type)     out = out.filter(d => d.mediaType === q.type);
    if (q.campaign) out = out.filter(d => (d.campaign || '') === q.campaign);

    const [org] = await db.select({ digestFrequency: organisations.aiDigestFrequency })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drafts: out, count: out.length, digestFrequency: org?.digestFrequency ?? 'off' }),
    };
};
