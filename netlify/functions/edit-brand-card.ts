// netlify/functions/edit-brand-card.ts — re-style a branded text card while reviewing its post.
//
// POST { postId, preview: true, ...edits } → { dataUrl, renderParams }   renders, saves nothing
// POST { postId, ...edits }                → { assetId, imageUrl, renderParams }  re-renders + saves
//   edits: { headline?, variant?, primaryColor?, backgroundColor?, textColor?, fontFamily?,
//            wordmark?, website?, logoUrl?,
//            layout?: { wordmark: {show,align,y}, website: {show,align,y} },
//            resetKit?: true   // discard this card's stored style, re-resolve from Brand Assets }
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
import { contentAssets, organisations, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { renderBrandCard, normalizeCardLayout, MAX_HEADLINE_CHARS, type CardVariant } from '../../src/lib/brand-card';
import { persistBufferToR2, r2IsConfigured } from '../../src/lib/media-persist';
import { normalizeBrandKit, resolveCardEditorKit, type BrandKit } from '../../src/utils/brand-kit';
import type { AspectRatio } from '../../src/lib/fal-gateway';
import { withLambda } from '@netlify/aws-lambda-compat';
import { platformFormat } from '../../src/config/platform-formats';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const KIT_FIELDS = ['primaryColor', 'backgroundColor', 'textColor', 'fontFamily', 'wordmark', 'website', 'logoUrl'] as const;

interface StoredRenderParams { kind?: string; headline?: string; variant?: CardVariant; kit?: unknown; layout?: unknown }

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
        .select({
            id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform,
            contentAssetIds: scheduledPosts.contentAssetIds,
        })
        .from(scheduledPosts)
        .where(and(eq(scheduledPosts.id, postId), eq(scheduledPosts.organisationId, ctx.organisationId)))
        .limit(1);
    if (!post) return json(404, { error: 'Post not found.' });

    // Editing a post that has already gone out would change the image on a live platform post that
    // nobody re-uploads — the card in the library would stop matching what followers can see.
    if (post.status === 'posted' || post.status === 'published') {
        return json(409, { error: 'This post has already been published, so its image can no longer be changed.' });
    }

    const [existing] = await db
        .select({
            id: contentAssets.id, provider: contentAssets.provider, prompt: contentAssets.prompt,
            aspectRatio: contentAssets.aspectRatio, renderParams: contentAssets.renderParams,
        })
        .from(contentAssets)
        .innerJoin(scheduledPostAssets, eq(scheduledPostAssets.contentAssetId, contentAssets.id))
        .where(and(eq(scheduledPostAssets.scheduledPostId, postId), eq(contentAssets.provider, 'brand_card')))
        .limit(1);

    // ── Creating a card, not just editing one ───────────────────────────────────────────────────
    // Until now a branded card could only exist if an autonomous drafter had made one: this endpoint
    // refused any post without one, and no other surface could produce one. So "make me a text card"
    // was a thing the product did on its own but the user could not ask for — the editor could
    // restyle a card it would never let you create.
    //
    // A card being created has no stored style and no asset row yet; everything below treats it as a
    // card whose stored params are empty, which is exactly the path a pre-render_params card already
    // takes. The aspect ratio comes from the post's platform, since there is no asset to inherit one
    // from and a 1:1 card on a Reel would be letterboxed.
    const creating = !existing && body.create === true;
    if (!existing && !creating) return json(404, { error: 'This post does not have a branded text card to edit.' });

    const asset = existing ?? {
        id: 0,
        provider: 'brand_card',
        prompt: '',
        aspectRatio: platformFormat(post.platform ?? 'instagram').aspectRatio as string,
        renderParams: null as unknown,
    };

    // Seed from what this card was LAST rendered with, so reopening the editor shows the user's own
    // edits rather than resetting to the org default.
    const stored = (asset.renderParams ?? {}) as StoredRenderParams;

    // `resetKit` deliberately discards what the card recorded and re-resolves from the org's
    // current Brand style. A card's own kit is normally authoritative — changing Brand Assets must
    // not silently restyle work already reviewed — but that same rule strands a card whose stored
    // kit is wrong (anything saved while the editor was inventing monochrome), with no way back to
    // the brand short of deleting the post. This is the way back, and it is explicit.
    const resetKit = body.resetKit === true;

    // Cards drafted before render_params existed carry no kit — see resolveCardEditorKit for why
    // the org's own kit, not the neutral default, is what those must fall back to. The org row is
    // fetched only when it is actually needed; the common path knows everything from the asset.
    let org: { name: string | null; brandKit: unknown } | undefined;
    if (!stored.kit || resetKit) {
        [org] = await db
            .select({ name: organisations.name, brandKit: organisations.brandKit })
            .from(organisations).where(eq(organisations.id, ctx.organisationId)).limit(1);
    }
    const { kit: baseKit, orgName } = resolveCardEditorKit(
        resetKit ? null : stored.kit, org?.brandKit, org?.name,
    );
    const baseHeadline = stored.headline ?? asset.prompt ?? '';
    const baseVariant: CardVariant = stored.variant === 'bold' ? 'bold' : 'light';

    // On a reset, per-card style overrides are exactly what is being discarded — so they are
    // ignored even if the client sends them. Enforcing that here and not only in the browser is
    // the point: the original bug WAS a client that sent colours it should not have.
    const overrides: Record<string, unknown> = {};
    if (!resetKit) {
        for (const f of KIT_FIELDS) if (body[f] !== undefined) overrides[f] = body[f] === '' ? null : body[f];
    }
    // normalizeBrandKit is the only gate on stored style — it rejects non-hex colours, font names
    // that could escape into a URL, and non-http logo URLs.
    const kit: BrandKit = normalizeBrandKit({ ...baseKit, ...overrides, source: 'manual' });

    const headline = String(body.headline ?? baseHeadline).trim().slice(0, MAX_HEADLINE_CHARS);
    if (!headline) return json(400, { error: 'A card needs some wording.' });
    const variant: CardVariant = body.variant === 'bold' || body.variant === 'light' ? body.variant : baseVariant;
    const aspectRatio = (asset.aspectRatio || '1:1') as AspectRatio;
    // Placement/visibility of the company name and website. Absent from the request = keep what the
    // card already had, so a client that only sends colours never quietly resets the layout.
    const layout = normalizeCardLayout(body.layout ?? stored.layout);

    let card;
    try {
        card = await renderBrandCard({ headline, kit, aspectRatio, variant, layout, orgName });
    } catch (err) {
        console.error('[edit-brand-card] render failed:', err instanceof Error ? err.message : err);
        return json(500, { error: 'Could not render that card.' });
    }

    const renderParams = { kind: 'brand_card', headline: card.headline, variant: card.variant, kit, layout: card.layout };

    if (body.preview === true) {
        // `elements` carries the drawn geometry (and which elements the org has anything to draw
        // for). The editor puts its drag handles on those exact boxes rather than re-deriving the
        // padding maths in the browser, where it would drift the moment either side changed.
        return json(200, {
            dataUrl: `data:image/png;base64,${card.png.toString('base64')}`,
            renderParams,
            elements: card.elements,
            canvas: { width: card.width, height: card.height },
        });
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

    if (creating) {
        // A brand new card: insert the asset, then attach it to the post BOTH ways. The junction is
        // the source of truth for new queries, but publish-social-posts.ts still reads media from
        // the legacy contentAssetIds column — writing only one of them produces a card that shows in
        // the editor and then publishes as a post with no image at all.
        const [made] = await db.insert(contentAssets).values({
            userId: ctx.userId,
            organisationId: ctx.organisationId,
            name: `Brand card — ${card.headline.slice(0, 60)}`,
            assetType: 'image',
            mimeType: 'image/png',
            provider: 'brand_card',
            prompt: card.headline,
            aspectRatio: asset.aspectRatio,
            storageKey: stored2.storageKey,
            fileSize: stored2.fileSize,
            width: card.width,
            height: card.height,
            renderParams,
            status: 'scheduled',
        }).returning({ id: contentAssets.id });

        await db.insert(scheduledPostAssets)
            .values({ scheduledPostId: postId, contentAssetId: made.id, position: 0 })
            .onConflictDoNothing();

        // Replace rather than append: a card IS the post's picture, so leaving the previous media in
        // the array would publish that instead — the array's first entry is what resolvePostImage
        // hands to the publisher.
        await db.update(scheduledPosts)
            .set({ contentAssetIds: [made.id], postFormat: 'image', updatedAt: new Date() })
            .where(eq(scheduledPosts.id, postId));

        return json(200, { assetId: made.id, renderParams, storageKey: stored2.storageKey, created: true });
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
