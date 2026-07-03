// netlify/functions/regenerate-post-media.ts
// Epic 3 US7: "Regenerate Media" on an AI-review-queue draft. Generates a fresh AI image for the
// post (charging 1 credit) and swaps it in for the currently-attached asset.
//
// POST { postId, prompt? }  → { assetId, thumbnailUrl, balance }
//   Auth: aura_session. The post must belong to the caller's org. Charges only on success.
//
// Image only. Video regeneration runs through the async composer flow (generate-ai-video).

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { generateAndPersistImage } from '../../src/lib/media-persist';
import { holdCredits, settleHold, getBalance, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';
import { presignR2Get } from '../../src/utils/social-publish';
import { FalContentPolicyError } from '../../src/lib/fal-gateway';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { postId?: number; prompt?: string };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

    const [post] = await db
        .select({ id: scheduledPosts.id, caption: scheduledPosts.caption })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // Prompt: caller-supplied, else derive from the caption.
    const prompt = (body.prompt || post.caption || 'On-brand social media image').trim().slice(0, 1000);
    const blocked = await enforcePromptModeration({ text: prompt, userId, organisationId: orgId, source: 'regenerate-post-media' });
    if (blocked) return blocked;

    const hold = await holdCredits(db, { orgId, amount: IMAGE_CREDIT_COST });
    if (!hold.ok) return { statusCode: 402, body: JSON.stringify({ error: 'insufficient_credits', cost: IMAGE_CREDIT_COST, balance: hold.balance }) };

    let assetId: number;
    try {
        assetId = await generateAndPersistImage(db, { orgId, userId, prompt, aspectRatio: '4:5' });
        await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId });
    } catch (err) {
        await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId });
        if (err instanceof FalContentPolicyError) {
            return { statusCode: 422, body: JSON.stringify({ error: 'Prompt flagged for policy violation. Please adjust your text and try again.', code: 'POLICY_FLAGGED' }) };
        }
        console.error('[regenerate-post-media] error:', err);
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not regenerate the image. Please try again.' }) };
    }

    // Swap the attached media: drop the old junction rows, attach the new asset.
    await db.delete(scheduledPostAssets).where(eq(scheduledPostAssets.scheduledPostId, postId));
    await db.insert(scheduledPostAssets).values({ scheduledPostId: postId, contentAssetId: assetId, position: 0 }).onConflictDoNothing();
    // Issue #55: regenerating media resolves any "media deleted" flag from the Review Queue.
    await db.update(scheduledPosts)
        .set({ contentAssetIds: [assetId], mediaMissing: false, mediaMissingNote: null })
        .where(eq(scheduledPosts.id, postId));

    const [asset] = await db.select({ storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
        .from(contentAssets).where(eq(contentAssets.id, assetId)).limit(1);
    let thumbnailUrl: string | null = null;
    if (asset?.storageKey) { try { thumbnailUrl = await presignR2Get(asset.storageKey); } catch { /* ignore */ } }
    if (!thumbnailUrl && asset?.externalUrl) thumbnailUrl = asset.externalUrl;

    const balance = await getBalance(db, orgId);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, thumbnailUrl, balance: balance.balance }),
    };
};
