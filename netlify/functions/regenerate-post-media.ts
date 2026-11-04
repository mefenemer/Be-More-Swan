// netlify/functions/regenerate-post-media.ts
// Epic 3 US7: "Regenerate Media" on an AI-review-queue draft. Generates a fresh AI image for the
// post (charging 1 credit) and swaps it in for the currently-attached asset.
//
// POST { postId, prompt? }  → { assetId, thumbnailUrl, balance, postIds, overlays }
//   Auth: aura_session. The post must belong to the caller's org. Charges only on success.
//
// Image only. Video regeneration runs through the async composer flow (generate-ai-video).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { scheduledPosts, scheduledPostAssets, contentAssets, mediaGenerationJobs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { generateAndPersistImage } from '../../src/lib/media-persist';
import { wordsToOverlays } from '../../src/lib/image-prompt';
import { directPostImage } from '../../src/utils/post-image-direction';
import { holdCredits, settleHold, getBalance, IMAGE_CREDIT_COST } from '../../src/utils/ai-credits';
import { presignR2Get } from '../../src/utils/social-publish';
import { FalContentPolicyError, FalError, FalServiceError, IMAGE_MODEL } from '../../src/lib/fal-gateway';
import { mediaTargetPostIds } from '../../src/utils/crosspost-media';
import { withLambda } from '@netlify/aws-lambda-compat';


export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const startedAt = Date.now();
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { postId?: number; prompt?: string; applyToGroup?: boolean };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return { statusCode: 400, body: JSON.stringify({ error: 'postId required.' }) };

    const [post] = await db
        .select({
            id: scheduledPosts.id, caption: scheduledPosts.caption, mediaDescription: scheduledPosts.suggestedMediaDescription,
            assistantId: scheduledPosts.assistantId, platform: scheduledPosts.platform, contentAssetIds: scheduledPosts.contentAssetIds,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, orgId)))
        .limit(1);
    if (!post) return { statusCode: 404, body: JSON.stringify({ error: 'Post not found.' }) };

    // What the picture should show: the caller's words, else the scene the drafter described for this
    // post, and only then the caption. ⚠️ The caption used to be sent to FLUX as it was (owner,
    // 2026-11-02: a "Before: … After: …" caption came back as a picture of that list, misspelt and
    // garbled) — a model asked to draw a page of text draws letters as shapes. Whatever the source, it
    // is rewritten as a scene first (post-image-direction.ts, which knows the business, the brand, the
    // rules and what was turned down); the no-text rule is still added to every prompt in fal-gateway.ts.
    //
    // Picture first, words second: when the request asks for words ON the picture (a drafter's "headline
    // reading …", a "Before / After" label), the plan hands those back separately and they go on below
    // as editable text layers — drawn by us, spelt right — instead of being lost to the no-text rule.
    const request = (body.prompt || post.mediaDescription || post.caption || 'On-brand social media image').trim().slice(0, 1000);
    const blocked = await enforcePromptModeration({ text: request, userId, organisationId: orgId, source: 'regenerate-post-media' });
    if (blocked) return blocked;
    const fromCaption = request === (post.caption || '').trim().slice(0, 1000);
    const { scene: prompt, words } = await directPostImage(db, {
        orgId, userId, postId, assistantId: post.assistantId, platform: post.platform,
        request, requestIsCaption: fromCaption, contentAssetIds: post.contentAssetIds,
    });
    // A caption is what the post SAYS, not a request for words on its picture — and the editor sends
    // the caption as `prompt` when the drafter left no media description. Only a real request
    // (typed, or the drafter's media description) puts words on the image.
    const overlays = fromCaption ? [] : wordsToOverlays(words);

    const hold = await holdCredits(db, { orgId, amount: IMAGE_CREDIT_COST });
    if (!hold.ok) return { statusCode: 402, body: JSON.stringify({ error: 'insufficient_credits', cost: hold.cost, balance: hold.balance, unit: hold.unit }) };

    let assetId: number;
    try {
        // Up to 18 s, out of what the 26 s function has left: 23 s less what the writer above took,
        // never under 12 s (its budget is 10 s), which keeps room to store the picture afterwards.
        const timeoutMs = Math.min(18_000, Math.max(12_000, 23_000 - (Date.now() - startedAt)));
        assetId = await generateAndPersistImage(db, { orgId, userId, prompt, aspectRatio: '4:5', timeoutMs });
        await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId });
    } catch (err) {
        await settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId });
        if (err instanceof FalContentPolicyError) {
            return { statusCode: 422, body: JSON.stringify({ error: 'Prompt flagged for policy violation. Please adjust your text and try again.', code: 'POLICY_FLAGGED' }) };
        }
        // Record WHY. This path used to log only to the function console and answer every failure
        // with the same "please try again", so a dead provider account, a timeout and an R2 fault
        // were indistinguishable from the outside. generate-ai-image already writes failures here;
        // now the post editor's button does too, and one query on media_generation_jobs says which.
        const message = err instanceof Error ? err.message : String(err);
        await db.insert(mediaGenerationJobs).values({
            organisationId: orgId, userId, mediaType: 'image', prompt, aspectRatio: '4:5',
            model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST, status: 'failed',
            errorMessage: `[regenerate-post-media] ${message}`.slice(0, 1000),
        }).catch((e) => console.error('[regenerate-post-media] could not record the failure:', e));

        // Provider account/billing (exhausted balance, locked, throttled): retrying cannot help, so
        // don't tell the user to — same honest answer generate-ai-image gives.
        if (err instanceof FalServiceError) {
            console.error('[regenerate-post-media] FAL SERVICE UNAVAILABLE (operator action needed):', message);
            return { statusCode: 503, body: JSON.stringify({ error: 'AI image generation is temporarily unavailable. Please try again later, or use Find a photo instead.', code: 'SERVICE_UNAVAILABLE' }) };
        }
        console.error('[regenerate-post-media] error:', err);
        const timedOut = err instanceof FalError && err.status === 504;
        return { statusCode: 502, body: JSON.stringify({ error: timedOut
            ? 'The image took too long to generate. Please try again.'
            : 'Could not regenerate the image. Please try again.' }) };
    }

    // One generated image covers the whole cross-post by default — the credit was charged once, and
    // leaving the other platforms on their old picture is not what "regenerate this post's media"
    // means. See src/utils/crosspost-media.ts.
    const targetIds = await mediaTargetPostIds(db, { postId, orgId, applyToGroup: body.applyToGroup });

    // Swap the attached media: drop the old junction rows, attach the new asset.
    await db.delete(scheduledPostAssets).where(inArray(scheduledPostAssets.scheduledPostId, targetIds));
    await db.insert(scheduledPostAssets)
        .values(targetIds.map(id => ({ scheduledPostId: id, contentAssetId: assetId, position: 0 })))
        .onConflictDoNothing();
    // Issue #55: regenerating media resolves any "media deleted" flag from the Review Queue.
    // Text layers were placed on the old picture, so they go with it — the same as any other swap
    // (attach-draft-media). ⚠️ They used to be left behind with overlay_base_asset_id still naming the
    // OLD asset, so the approve bake (get-post-image reads that base first) published the old picture
    // under them. Now the post carries only the words planned for this picture, based on it.
    await db.update(scheduledPosts)
        .set({
            contentAssetIds: [assetId], mediaMissing: false, mediaMissingNote: null,
            imageOverlays: overlays.length ? overlays : null,
            overlayBaseAssetId: overlays.length ? assetId : null,
        })
        .where(inArray(scheduledPosts.id, targetIds));

    const [asset] = await db.select({ storageKey: contentAssets.storageKey, externalUrl: contentAssets.externalUrl })
        .from(contentAssets).where(eq(contentAssets.id, assetId)).limit(1);
    let thumbnailUrl: string | null = null;
    if (asset?.storageKey) { try { thumbnailUrl = await presignR2Get(asset.storageKey); } catch { /* ignore */ } }
    if (!thumbnailUrl && asset?.externalUrl) thumbnailUrl = asset.externalUrl;

    const balance = await getBalance(db, orgId);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId, thumbnailUrl, balance: balance.balance, postIds: targetIds, overlays }),
    };
});
