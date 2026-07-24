// netlify/functions/edit-brand-card.ts — re-style a branded text card while reviewing its post.
//
// POST { postId, preview: true, ...edits } → { dataUrl, renderParams }   renders, saves nothing
// POST { postId, ...edits }                → { assetId, imageUrl, renderParams }  re-renders + saves
//   edits: { headline?, variant?, primaryColor?, backgroundColor?, textColor?, fontFamily?,
//            wordmark?, website?, logoUrl? }
//   Auth: aura_session cookie; the post must belong to the caller's organisation.
//
// WHY SERVER-SIDE: the published image has to be the image the user approved. The existing text
// overlay feature bakes in the browser at approve time, which is right for text ON a photo — but a
// brand card IS the render, so re-running the same renderBrandCard the drafter used is the only way
// the preview and the published PNG cannot disagree. It also means an edit costs no AI credits.
//
// The edit is scoped to THIS card. It writes render_params on the asset, not the org's brand kit,
// so tuning one post never silently restyles every future post — the org-wide setting lives on
// Business Information → Brand style.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { contentAssets, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { renderBrandCard, MAX_HEADLINE_CHARS, type CardVariant } from '../../src/lib/brand-card';
import { persistBufferToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { normalizeBrandKit, type BrandKit } from '../../src/utils/brand-kit';
import type { AspectRatio } from '../../src/lib/fal-gateway';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const KIT_FIELDS = ['primaryColor', 'backgroundColor', 'textColor', 'fontFamily', 'wordmark', 'website', 'logoUrl'] as const;

interface StoredRenderParams { kind?: string; headline?: string; variant?: CardVariant; kit?: unknown }

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const postId = Number(body.postId);
    if (!Number.isInteger(postId)) return json(400, { error: 'postId required.' });

    // Tenant check on the POST, then find its card among the attached assets. Scoping the asset
    // lookup through the junction (rather than trusting an assetId from the client) is what stops
    // one workspace re-rendering another's media.
    const [post] = await db
        .select({ id: scheduledPosts.id, status: scheduledPosts.status })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    // Editing a post that has already gone out would change the image on a live platform post that
    // nobody re-uploads — the card in the library would stop matching what followers can see.
    if (post.status === 'posted' || post.status === 'published') {
        return json(409, { error: 'This post has already been published, so its image can no longer be changed.' });
    }

    const [asset] = await db
        .select({
            id: contentAssets.id, provider: contentAssets.provider, prompt: contentAssets.prompt,
            aspectRatio: contentAssets.aspectRatio, renderParams: contentAssets.renderParams,
        })
        .from(contentAssets)
        .innerJoin(scheduledPostAssets, eq(scheduledPostAssets.contentAssetId, contentAssets.id))
        .where(and(eq(scheduledPostAssets.scheduledPostId, postId), eq(contentAssets.provider, 'brand_card')))
        .limit(1);
    if (!asset) return json(404, { error: 'This post does not have a branded text card to edit.' });

    // Seed from what this card was LAST rendered with, so reopening the editor shows the user's own
    // edits rather than resetting to the org default. Cards drafted before render_params existed
    // fall back to the stored prompt (the headline) over a default kit.
    const stored = (asset.renderParams ?? {}) as StoredRenderParams;
    const baseKit = normalizeBrandKit(stored.kit);
    const baseHeadline = stored.headline ?? asset.prompt ?? '';
    const baseVariant: CardVariant = stored.variant === 'bold' ? 'bold' : 'light';

    const overrides: Record<string, unknown> = {};
    for (const f of KIT_FIELDS) if (body[f] !== undefined) overrides[f] = body[f] === '' ? null : body[f];
    // normalizeBrandKit is the only gate on stored style — it rejects non-hex colours, font names
    // that could escape into a URL, and non-http logo URLs.
    const kit: BrandKit = normalizeBrandKit({ ...baseKit, ...overrides, source: 'manual' });

    const headline = String(body.headline ?? baseHeadline).trim().slice(0, MAX_HEADLINE_CHARS);
    if (!headline) return json(400, { error: 'A card needs some wording.' });
    const variant: CardVariant = body.variant === 'bold' || body.variant === 'light' ? body.variant : baseVariant;
    const aspectRatio = (asset.aspectRatio || '1:1') as AspectRatio;

    let card;
    try {
        card = await renderBrandCard({ headline, kit, aspectRatio, variant });
    } catch (err) {
        console.error('[edit-brand-card] render failed:', err instanceof Error ? err.message : err);
        return json(500, { error: 'Could not render that card.' });
    }

    const renderParams = { kind: 'brand_card', headline: card.headline, variant: card.variant, kit };

    if (body.preview === true) {
        return json(200, { dataUrl: `data:image/png;base64,${card.png.toString('base64')}`, renderParams });
    }

    if (!r2IsConfigured()) return json(503, { error: 'Media storage is not configured, so the card cannot be saved.' });

    let stored2;
    try {
        stored2 = await persistBufferToR2({
            orgId: ctx.organisationId, bytes: card.png, contentType: 'image/png', folder: 'brand-cards',
        });
    } catch (err) {
        console.error('[edit-brand-card] R2 write failed:', err instanceof Error ? err.message : err);
        return json(502, { error: 'Could not save the new card. Please try again.' });
    }

    // Update the EXISTING asset row rather than inserting a new one: the post's junction row and its
    // legacy contentAssetIds array both already point here, and swapping ids means keeping two
    // places in step for no gain. The superseded R2 object is left for lifecycle cleanup — an
    // orphaned blob is cheaper than a post pointing at a key we deleted mid-request.
    await db.update(contentAssets).set({
        storageKey: stored2.storageKey,
        fileSize: stored2.fileSize,
        width: card.width, height: card.height,
        name: `Brand card — ${card.headline.slice(0, 60)}`,
        prompt: card.headline,
        renderParams,
        updatedAt: new Date(),
    }).where(eq(contentAssets.id, asset.id));

    return json(200, { assetId: asset.id, renderParams, storageKey: stored2.storageKey });
});
