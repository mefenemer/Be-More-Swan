// src/utils/flyer-briefs.ts
// The flyer half of the Brand Designer's engine (docs/brand-designer-flyers-plan.md §3.3, §3.5).
// visual-briefs.ts runs the round and the decision; for a brief with purpose 'flyer' it hands the
// making of options, and the making of the PDFs on approve, to the two functions here.
//
// ── A round ─────────────────────────────────────────────────────────────────────────────────────
// At most one stock photo and one AI photo, then three pages drawn from the brief's saved words:
//   photo at the top (the first photo) · framed photo (the last photo) · words only.
// Words never sit on a photo, and each page takes its colour from flyerColours below.
// A layout the words do not fit is left out with the reason (FlyerFitError's message) — never drawn
// with words missing. Each option is a PREVIEW PNG; nothing is print-rendered until it is approved.
//
// ── Approve ─────────────────────────────────────────────────────────────────────────────────────
// Both PDFs are drawn from the option's render_params — the words, kit and photo it was drawn with,
// stored whole, so a later edit to the brief or the kit cannot change a flyer the user approved.

import { contentAssets, mediaGenerationJobs } from '../../db/schema';
import type { getDb } from '../../db/client';
import { FalContentPolicyError, falConfigured, generateImages, IMAGE_MODEL } from '../lib/fal-gateway';
import { FlyerFitError, MIN_PHOTO_DPI, PREVIEW_DPI, flyerPageStyle, renderFlyer, renderFlyerPdfs, type FlyerPageStyle, type FlyerPhoto } from '../lib/flyer';
import { persistBufferToR2, persistRemoteMediaToR2, r2IsConfigured } from '../lib/media-persist';
import { normalizeBrandKit, type BrandKit } from './brand-kit';
import { isAccentCandidate } from './brand-extract';
import { PexelsRateLimitError, searchUniqueImages } from './pexels';
import { resolveAssetDisplayUrl } from './social-publish';
import {
    FLYER_LAYOUT_LABELS, PAPER_SPECS, PRINT_BLEED_MM, normaliseFlyerContent, paperSizeOf,
    type FlyerContent, type FlyerLayout, type PaperSize,
} from '../config/flyer-vocab';
import { FLYER_SOURCE, PURPOSE_SPECS } from '../config/visual-brief-vocab';
import { IMAGE_CREDIT_COST } from './ai-credits';
import type { ArtDirection, BriefContext, BriefRow } from './visual-briefs';

type Db = ReturnType<typeof getDb>;

export const FLYER_PROVIDER = 'flyer';
/** Widest stock photo we ask Pexels for: an A4 page at 300 dpi is 2480 px across. */
const STOCK_PRINT_WIDTH = 2480;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const BRAND_KIT_PLACE = 'Business Information ▸ Brand Assets ▸ Brand style';

/** Where a flyer's photo lives — kept on the option so approve can fetch the same photo again. */
export interface FlyerPhotoRef {
    source: 'stock' | 'ai_image';
    storageKey: string | null;
    externalUrl: string | null;
    mimeType: string;
    width: number | null;
    height: number | null;
    providerAssetId?: string | null;
    attributionName?: string | null;
    attributionUrl?: string | null;
}

/** What a flyer option stores in render_params. */
export interface FlyerRenderParams {
    kind: 'flyer';
    layout: FlyerLayout;
    paperSize: PaperSize;
    content: FlyerContent;
    kit: BrandKit;
    orgName: string;
    photo: FlyerPhotoRef | null;
    /** The photo's printed dpi in this layout, and whether that prints soft. */
    photoDpi: number | null;
    lowResPhoto: boolean;
    /** The page's colours. Absent on a page drawn before they were stored. */
    style?: FlyerPageStyle;
}

/** The business's own real colours: black, white and grey do not count, they are what an unset kit holds. */
export function brandPageColours(kit: BrandKit, secondaryColors: string[]): string[] {
    return [...new Set([kit.primaryColor, ...secondaryColors, kit.backgroundColor])].filter(isAccentCandidate);
}

export interface FlyerColours {
    colours: string[];
    /** brand: their own. look: the look this brief asks for. suggested: chosen, because they have none set. none: nothing known. */
    from: 'brand' | 'look' | 'suggested' | 'none';
}

/**
 * Which colours a round's pages use. The look the user asked for on this brief comes first, then the
 * business's own colours. Only when it has neither does the designer's suggestion count, so a suggestion
 * can never replace a real brand colour unasked.
 */
export function flyerColours(args: { brand: string[]; mood: string | null | undefined; picks: string[] | undefined }): FlyerColours {
    const picks = args.picks ?? [];
    if (args.mood && picks.length) return { colours: [...new Set([...picks, ...args.brand])], from: 'look' };
    if (args.brand.length) return { colours: args.brand, from: 'brand' };
    if (picks.length) return { colours: picks, from: 'suggested' };
    return { colours: [], from: 'none' };
}

/** One colour per page, so the three pages are three different looks when there are colours to spare. */
export function colourForPage(colours: string[], layout: FlyerLayout): string | null {
    if (!colours.length) return null;
    const i = layout === 'photo_framed' ? 1 : layout === 'type_only' ? 2 : 0;
    return colours[i % colours.length];
}

/**
 * A Pexels CDN link at print width. Their `src.large` is ~940 px — sharp on a phone, soft on paper.
 * The CDN resizes on request (`w`); `h` is dropped so the photo keeps its own shape. Non-Pexels links
 * are returned as they are.
 */
export function pexelsPrintUrl(url: string, width = STOCK_PRINT_WIDTH): string {
    try {
        const u = new URL(url);
        if (u.hostname !== 'images.pexels.com') return url;
        u.searchParams.delete('h');
        u.searchParams.set('auto', 'compress');
        u.searchParams.set('cs', 'tinysrgb');
        u.searchParams.set('w', String(width));
        return u.toString();
    } catch { return url; }
}

/** The photo's bytes, from R2 (ours) or the stock CDN. Null on any failure — that layout is skipped. */
export async function fetchFlyerPhoto(ref: FlyerPhotoRef): Promise<FlyerPhoto | null> {
    try {
        const url = ref.storageKey
            ? await resolveAssetDisplayUrl({ assetType: 'image', storageKey: ref.storageKey })
            : ref.externalUrl;
        if (!url) return null;
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) return null;
        const bytes = Buffer.from(await res.arrayBuffer());
        if (!bytes.byteLength || bytes.byteLength > MAX_PHOTO_BYTES) return null;
        const mimeType = (res.headers.get('content-type') || ref.mimeType || 'image/jpeg').split(';')[0].trim();
        if (!/^image\/(jpe?g|png|webp)$/i.test(mimeType)) return null;
        return { bytes, mimeType, width: ref.width, height: ref.height };
    } catch { return null; }
}

type OptionValues = {
    source: string; storageKey: string; mimeType: string; width: number; height: number; prompt: string;
    providerAssetId?: string | null; attributionName?: string | null; attributionUrl?: string | null;
    renderParams: FlyerRenderParams;
};

/** One stock photo at print width, not shown on this brief before. */
async function stockPhoto(db: Db, brief: BriefRow, ad: ArtDirection, exclude: string[]): Promise<FlyerPhotoRef | null> {
    const { candidates } = await searchUniqueImages(db, brief.organisationId, brief.message || brief.title, {
        limit: 1, keywords: ad.stockKeywords, exclude, orientation: 'portrait',
        // A flyer is not a social post: the never-reuse-on-the-feed rule does not apply to it.
        dedup: false,
    });
    const c = candidates[0];
    if (!c?.url) return null;
    const scale = c.width ? Math.min(1, STOCK_PRINT_WIDTH / c.width) : 1;
    return {
        source: 'stock', storageKey: null, externalUrl: pexelsPrintUrl(c.url), mimeType: 'image/jpeg',
        width: c.width ? Math.round(c.width * scale) : null, height: c.height ? Math.round(c.height * scale) : null,
        providerAssetId: c.providerAssetId, attributionName: c.photographer, attributionUrl: c.photographerUrl,
    };
}

/** One AI photo, copied into R2 (fal's links expire). Logged like every other AI image. */
async function aiPhoto(db: Db, brief: BriefRow, ad: ArtDirection, userId: number | null): Promise<FlyerPhotoRef | null> {
    const aspectRatio = PURPOSE_SPECS.flyer.aspectRatio;
    const job = {
        organisationId: brief.organisationId, userId, assistantId: brief.aiAssistantId, mediaType: 'image',
        prompt: ad.imagePrompt, aspectRatio, model: IMAGE_MODEL, creditCost: IMAGE_CREDIT_COST,
    };
    let img;
    try {
        [img] = falConfigured()
            ? await generateImages({ prompt: ad.imagePrompt, aspectRatio, numImages: 1, usage: { workspaceId: brief.organisationId, userId, assistantId: brief.aiAssistantId } })
            : [{ url: `https://picsum.photos/seed/flyer-${brief.id}-${brief.rounds}/1024/1280`, width: 1024, height: 1280, contentType: 'image/jpeg' }];
    } catch (err) {
        const flagged = err instanceof FalContentPolicyError;
        await db.insert(mediaGenerationJobs).values({
            ...job, status: flagged ? 'flagged' : 'failed',
            errorMessage: `[brand-designer flyer] ${err instanceof Error ? err.message : 'generation failed'}`.slice(0, 1000),
        }).catch(() => {});
        throw err;
    }
    if (!img) return null;
    const mimeType = img.contentType || 'image/jpeg';
    const { storageKey } = await persistRemoteMediaToR2({ orgId: brief.organisationId, url: img.url, contentType: mimeType, folder: 'briefs', label: 'AI flyer photo' });
    await db.insert(mediaGenerationJobs).values({ ...job, status: 'completed' }).catch(() => {});
    return { source: 'ai_image', storageKey, externalUrl: null, mimeType, width: img.width || null, height: img.height || null };
}

export interface FlyerRoundResult {
    options: OptionValues[];
    notes: string[];
    /** An option was drawn on the AI photo — the image part of the hold is charged. */
    aiUsed: boolean;
}

/**
 * One flyer round. Never throws for a photo or a layout: each failure is a note and one fewer
 * option. Throws only when there are no words to draw (startRound refuses that first).
 */
export async function flyerRoundOptions(db: Db, args: {
    brief: BriefRow; ad: ArtDirection; ctx: BriefContext; userId: number | null;
    wantStock: boolean; wantAi: boolean; shownStockIds: string[];
}): Promise<FlyerRoundResult> {
    const { brief, ad, ctx } = args;
    if (!r2IsConfigured()) throw new Error('brand_card_requires_r2');
    const n = normaliseFlyerContent(brief.flyerContent);
    if (!n.ok) throw new Error('flyer_needs_words');
    const content = n.content;
    const paperSize = paperSizeOf(brief.paperSize) ?? 'A5';
    const notes: string[] = [];

    const [stock, ai] = await Promise.allSettled([
        args.wantStock ? stockPhoto(db, brief, ad, args.shownStockIds) : Promise.resolve(null),
        args.wantAi ? aiPhoto(db, brief, ad, args.userId) : Promise.resolve(null),
    ]);
    if (stock.status === 'rejected') notes.push(stock.reason instanceof PexelsRateLimitError ? 'Stock search is resting for a few minutes, so no stock photo this round.' : 'Stock search failed this round.');
    else if (args.wantStock && !stock.value) notes.push('No new stock photo matched — the search words are shown under the brief.');
    if (ai.status === 'rejected') notes.push(ai.reason instanceof FalContentPolicyError
        ? 'The AI image service refused this brief as written. Nothing was charged. Try rewording what it should show.'
        : 'The AI photo could not be made this round. Nothing was charged for it.');

    const refs = [stock, ai].map((r) => (r.status === 'fulfilled' ? r.value : null)).filter((r): r is FlyerPhotoRef => !!r);
    const photos: Array<{ ref: FlyerPhotoRef; photo: FlyerPhoto }> = [];
    for (const ref of refs) {
        const photo = await fetchFlyerPhoto(ref);
        if (photo) photos.push({ ref, photo });
        else notes.push(`The ${ref.source === 'stock' ? 'stock' : 'AI'} photo could not be downloaded, so it is not on a flyer this round.`);
    }

    const plan: Array<{ layout: FlyerLayout; p: { ref: FlyerPhotoRef; photo: FlyerPhoto } | null }> = [];
    if (photos.length) {
        plan.push({ layout: 'photo_top', p: photos[0] });
        plan.push({ layout: 'photo_framed', p: photos[photos.length - 1] });
    }
    plan.push({ layout: 'type_only', p: null });

    const { colours, from } = flyerColours({ brand: brandPageColours(ctx.kit, ctx.guidelines.secondaryColors), mood: brief.mood, picks: ad.flyerColours });
    if (from === 'suggested') notes.push(`Your brand kit only has black and white, so these colours were chosen to suit your business and this flyer. Set your own under ${BRAND_KIT_PLACE} and every flyer will use them.`);
    if (from === 'none') notes.push(`Your brand kit only has black and white, so these pages do too. Set your colours under ${BRAND_KIT_PLACE}, or say the look you want on this flyer.`);

    const options: OptionValues[] = [];
    const fitNotes = new Set<string>();
    for (const { layout, p } of plan) {
        try {
            const style = flyerPageStyle(layout, colourForPage(colours, layout), ctx.kit);
            const r = await renderFlyer({ content, kit: ctx.kit, paperSize, layout, photo: p?.photo ?? null, orgName: ctx.orgName, dpi: PREVIEW_DPI, style });
            const { storageKey } = await persistBufferToR2({ orgId: brief.organisationId, bytes: r.png, contentType: 'image/png', folder: 'briefs' });
            // Pixels per inch of PAPER, so the same at any render dpi.
            const lowResPhoto = r.photoDpi !== null && r.photoDpi < MIN_PHOTO_DPI;
            options.push({
                source: FLYER_SOURCE, storageKey, mimeType: 'image/png', width: r.width, height: r.height,
                prompt: `${FLYER_LAYOUT_LABELS[layout]} · ${paperSize}`,
                providerAssetId: p?.ref.providerAssetId ?? null,
                attributionName: p?.ref.attributionName ?? null, attributionUrl: p?.ref.attributionUrl ?? null,
                renderParams: {
                    kind: 'flyer', layout, paperSize, content, kit: ctx.kit, orgName: ctx.orgName,
                    photo: p?.ref ?? null, photoDpi: r.photoDpi, lowResPhoto, style,
                },
            });
        } catch (err) {
            if (err instanceof FlyerFitError) fitNotes.add(`${FLYER_LAYOUT_LABELS[layout]}: ${err.message}`);
            else {
                console.error('[flyer-briefs] layout failed:', brief.id, layout, err instanceof Error ? err.message : err);
                notes.push(`The "${FLYER_LAYOUT_LABELS[layout]}" page could not be drawn this round.`);
            }
        }
    }
    notes.push(...fitNotes);
    const aiUsed = options.some((o) => o.renderParams.photo?.source === 'ai_image');
    if (photos.some((p) => p.ref.source === 'ai_image') && !aiUsed) notes.push('The AI photo was not used on any page, so nothing was charged for it.');
    return { options, notes, aiUsed };
}

/**
 * Approve a flyer option: draw both PDFs at print resolution, store them, and add ONE library asset
 * (a document) pointing at the home PDF, with the print-shop PDF and the preview alongside in its
 * render_params. Returns the new asset id. Throws on failure — decideOption gives the option back.
 */
export async function approveFlyerOption(db: Db, args: {
    orgId: number; userId: number; title: string;
    option: { storageKey: string | null; renderParams: unknown; width: number | null; height: number | null };
}): Promise<number> {
    const p = args.option.renderParams as FlyerRenderParams | null;
    if (!p || p.kind !== 'flyer') throw new Error('not_a_flyer_option');
    const n = normaliseFlyerContent(p.content);
    if (!n.ok) throw new Error('flyer_needs_words');
    const paperSize = paperSizeOf(p.paperSize) ?? 'A5';
    const photo = p.photo ? await fetchFlyerPhoto(p.photo) : null;
    if (p.photo && !photo) throw new Error('flyer_photo_unavailable');

    const { home, printShop } = await renderFlyerPdfs({
        content: n.content, kit: normalizeBrandKit(p.kit), paperSize, layout: p.layout, photo,
        orgName: p.orgName, title: args.title, bleedMm: PRINT_BLEED_MM, style: p.style ?? null,
    });
    const [homeObj, shopObj] = await Promise.all([
        persistBufferToR2({ orgId: args.orgId, bytes: home, contentType: 'application/pdf', folder: 'flyers' }),
        persistBufferToR2({ orgId: args.orgId, bytes: printShop, contentType: 'application/pdf', folder: 'flyers' }),
    ]);
    const spec = PAPER_SPECS[paperSize];
    const [asset] = await db.insert(contentAssets).values({
        userId: args.userId, organisationId: args.orgId, name: args.title.slice(0, 120),
        assetType: 'document', mimeType: 'application/pdf', fileSize: homeObj.fileSize,
        storageKey: homeObj.storageKey, provider: FLYER_PROVIDER, status: 'pending',
        width: args.option.width, height: args.option.height,
        prompt: `${FLYER_LAYOUT_LABELS[p.layout]} · ${paperSize} (${spec.widthMm} × ${spec.heightMm} mm)`,
        attributionName: p.photo?.attributionName ?? null, attributionUrl: p.photo?.attributionUrl ?? null,
        renderParams: {
            ...p,
            previewKey: args.option.storageKey,
            printShopKey: shopObj.storageKey,
            printShopFileSize: shopObj.fileSize,
            bleedMm: PRINT_BLEED_MM,
        },
        // A flyer a human approved is a keeper, not transient media (see brand-card-lifecycle.ts).
        libraryKeptAt: new Date(),
    }).returning({ id: contentAssets.id });
    return asset.id;
}

