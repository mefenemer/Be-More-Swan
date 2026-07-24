// src/lib/brand-card.ts — deterministic, on-brand text cards for social posts.
//
// The fourth media source. Manual/stock/AI all hand back a PHOTOGRAPH; this one renders the post's
// own idea as typography in the org's colours, which is what a quote-card, stat-card or hot-take
// post actually wants. Alternated with stock (see media-resolver) so a feed mixes cards and imagery
// rather than becoming a wall of either.
//
// WHY NOT AI IMAGE GENERATION: because the card is mostly words. Diffusion models still mangle
// rendered text — a misspelled headline on a brand card is worse than no card at all — and the
// output is non-reproducible, so the same post can never be re-rendered identically. satori lays
// out real fonts with a flexbox engine and resvg rasterises the result: the glyphs are exactly the
// glyphs in the font, every time. It also costs no AI credits, and (unlike an AI image) it carries
// no unreviewed-imagery risk, so the Autopilot gate lets it publish unattended.
//
// Two polarities, per the brief: 'light' = brand type on a light canvas, 'bold' = light type on a
// brand-colour field. Which one a given post gets is decided by pickVariant() below.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { brandCardFonts, BRAND_CARD_FONT_FAMILY } from './brand-card-fonts';
import { loadWebFont } from './brand-card-webfont';
import {
    contrastRatio, readableInkOn, MIN_DISPLAY_CONTRAST,
    type BrandKit,
} from '../utils/brand-kit';
import type { AspectRatio } from './fal-gateway';

export type CardVariant = 'light' | 'bold';

export type CardAlign = 'left' | 'center' | 'right';

/**
 * Where one piece of the card's furniture sits, and whether it shows at all.
 *
 * Vertical is free (`y`), horizontal snaps to three anchors (`align`). That split is deliberate: a
 * freely-positioned x would need the rendered TEXT WIDTH to clamp against, and satori only knows
 * that after it has laid the card out — so a right-dragged wordmark could print off the edge, and
 * the first anyone would know is a published post. Anchoring to the safe-area rail instead makes
 * overhang impossible by construction, while dragging still feels free in the axis that matters
 * (how far down the card the line sits).
 */
export interface CardElementLayout {
    show: boolean;
    align: CardAlign;
    /** Top edge as a fraction of canvas height, clamped into the safe area at render time — so 0
     *  and 1 mean "as high/low as this can legibly go", never off the card. */
    y: number;
}

/** The two elements a reviewer can show, hide and place: the company name and the website. */
export interface CardLayout {
    wordmark: CardElementLayout;
    website: CardElementLayout;
}

/** Reproduces the original fixed layout: name top-left, website bottom-left, both shown. */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
    wordmark: { show: true, align: 'left', y: 0 },
    website: { show: true, align: 'left', y: 1 },
};

function normalizeCardElement(raw: unknown, fallback: CardElementLayout): CardElementLayout {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const align = o.align === 'left' || o.align === 'center' || o.align === 'right' ? o.align : fallback.align;
    const y = Number(o.y);
    return {
        show: typeof o.show === 'boolean' ? o.show : fallback.show,
        align,
        y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : fallback.y,
    };
}

/**
 * Coerce anything — a stored render_params blob, a request body, undefined — into a usable layout.
 * Like normalizeBrandKit, this is the ONLY gate: the values reach a renderer that has no opinion
 * about nonsense, so an out-of-range y or a junk align must be corrected here or not at all.
 */
export function normalizeCardLayout(raw: unknown): CardLayout {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
        wordmark: normalizeCardElement(o.wordmark, DEFAULT_CARD_LAYOUT.wordmark),
        website: normalizeCardElement(o.website, DEFAULT_CARD_LAYOUT.website),
    };
}

/** Rendered pixel size per slot ratio. 1080-wide is every platform's native upload width. */
const DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
    '1:1': { width: 1080, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
    '9:16': { width: 1080, height: 1920 },
    '16:9': { width: 1920, height: 1080 },
};

/** Longest headline worth setting as display type; past this the card stops being a card. */
export const MAX_HEADLINE_CHARS = 120;

/**
 * Reduce a caption to a single card-sized line.
 *
 * The generator is asked for a purpose-built `cardHeadline`, but it is an LLM and the field goes
 * missing; this is the fallback that keeps the source working when it does. Strips the furniture a
 * caption carries and a card must not show — hashtags, @handles, links, emoji, the disclosure
 * footer's leading separator — then takes the first sentence that fits.
 */
export function headlineFromCaption(caption: string): string | null {
    const cleaned = (caption || '')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[#@][\w-]+/g, ' ')
        // Emoji and dingbats: decorative on a card, and not in the latin font subset anyway.
        .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{27BF}\u{FE0F}\u{2600}-\u{26FF}]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!cleaned) return null;

    // Sentence-ish split. Keeps the punctuation off the card — display type doesn't want a full stop.
    const sentences = cleaned.split(/(?<=[.!?])\s+/).map((s) => s.replace(/[.!?]+$/, '').trim()).filter(Boolean);
    const fits = sentences.find((s) => s.length >= 12 && s.length <= MAX_HEADLINE_CHARS);
    if (fits) return fits;

    const first = sentences[0] ?? cleaned;
    if (first.length <= MAX_HEADLINE_CHARS) return first.length >= 4 ? first : null;

    // Nothing short enough: cut at the last word boundary inside the limit rather than mid-word.
    const clipped = first.slice(0, MAX_HEADLINE_CHARS);
    const lastSpace = clipped.lastIndexOf(' ');
    return (lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped).trim() || null;
}

/**
 * Alternating variant choice. Deterministic in `seed` (the post id) so a re-render of the same post
 * is byte-identical and a test can assert the polarity, while consecutive posts still differ.
 */
export function pickVariant(seed: number): CardVariant {
    return Math.abs(Math.trunc(seed)) % 2 === 0 ? 'light' : 'bold';
}

/**
 * Resolve the palette for one card, with legibility as the tiebreak over the nominal design.
 *
 * 'bold' fills with the brand accent and writes in whatever is readable on it (white normally, ink
 * on a pale accent). 'light' writes the accent on the light canvas — but a pale accent on a pale
 * canvas is an unreadable card, so when it fails MIN_DISPLAY_CONTRAST the headline falls back to
 * the org's ink and the accent is demoted to the eyebrow/rule.
 */
export function resolveCardPalette(kit: BrandKit, variant: CardVariant): {
    background: string; headline: string; eyebrow: string; footer: string;
} {
    if (variant === 'bold') {
        const ink = readableInkOn(kit.primaryColor, kit.textColor);
        return {
            background: kit.primaryColor,
            headline: ink,
            eyebrow: ink,
            footer: ink,
        };
    }

    const accentReadable = contrastRatio(kit.primaryColor, kit.backgroundColor) >= MIN_DISPLAY_CONTRAST;
    const headline = accentReadable ? kit.primaryColor : readableInkOn(kit.backgroundColor, kit.textColor);
    return {
        background: kit.backgroundColor,
        headline,
        eyebrow: accentReadable ? kit.primaryColor : headline,
        footer: readableInkOn(kit.backgroundColor, kit.textColor),
    };
}

/**
 * Headline point size for a given character count and canvas width.
 *
 * satori has no "shrink text to fit" — it will happily overflow the box — so the size is chosen up
 * front from the one thing that predicts wrapped height well enough: length. The bands are tuned so
 * a MAX_HEADLINE_CHARS headline still lands inside the safe area on the tightest ratio (16:9).
 */
export function headlineFontSize(chars: number, canvasWidth: number): number {
    const scale = canvasWidth / 1080;
    const base =
        chars <= 28 ? 104 :
        chars <= 48 ? 88 :
        chars <= 70 ? 74 :
        chars <= 95 ? 62 : 54;
    return Math.round(base * scale);
}

/** Fetch a logo and inline it as a data URI. Returns null on any failure — the card falls back to
 *  the wordmark rather than failing, and a slow host must never hold a generation job open. */
async function inlineLogo(url: string): Promise<string | null> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const type = res.headers.get('content-type') || '';
        // satori rasterises png/jpeg/gif directly; an SVG logo would need its own parse pass.
        if (!/^image\/(png|jpeg|jpg|gif)$/.test(type.split(';')[0].trim())) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > 2_000_000) return null;
        return `data:${type.split(';')[0].trim()};base64,${buf.toString('base64')}`;
    } catch { return null; }
}

/** Where an element was actually drawn, in canvas pixels. */
export interface CardElementBox { left: number; top: number; width: number; height: number }

/**
 * What became of one placeable element. `available` is false when the org has nothing to draw (no
 * wordmark/org name, no website) — which the editor needs kept distinct from "the user hid it", or
 * it would offer a toggle that silently does nothing.
 */
export interface CardElementRender {
    available: boolean;
    shown: boolean;
    box: CardElementBox | null;
}

export interface BrandCardResult {
    png: Buffer;
    width: number;
    height: number;
    variant: CardVariant;
    headline: string;
    /** The layout actually used, post-normalisation — what the caller should store. */
    layout: CardLayout;
    /** Drawn geometry, so the editor can put its drag handles exactly where the render put the
     *  text instead of re-deriving the same padding maths in the browser and drifting from it. */
    elements: { wordmark: CardElementRender; website: CardElementRender };
}

/**
 * Render one card. Throws only if satori/resvg themselves fail; callers treat that as "this source
 * produced nothing" and fall through to the next media source.
 */
export async function renderBrandCard(opts: {
    headline: string;
    kit: BrandKit;
    aspectRatio?: AspectRatio;
    variant?: CardVariant;
    /** Used to pick the variant when one isn't given. Post id at the call site. */
    seed?: number;
    /** Eyebrow fallback when the kit has no wordmark — the org name. */
    orgName?: string | null;
    /** Per-card visibility/placement of the company name and website. Omitted = the original fixed
     *  layout, so every existing caller renders exactly as it did. */
    layout?: unknown;
}): Promise<BrandCardResult> {
    const headline = opts.headline.trim();
    if (!headline) throw new Error('Brand card needs a headline.');

    const aspectRatio = opts.aspectRatio ?? '1:1';
    const { width, height } = DIMENSIONS[aspectRatio] ?? DIMENSIONS['1:1'];
    const variant = opts.variant ?? pickVariant(opts.seed ?? 0);
    const palette = resolveCardPalette(opts.kit, variant);

    const pad = Math.round(width * 0.083);
    const eyebrowText = (opts.kit.wordmark || opts.orgName || '').trim().toUpperCase().slice(0, 32);
    const layout = normalizeCardLayout(opts.layout);

    // The org's own display font when we can serve it, the bundled family otherwise. Both are
    // fetched together — a slow logo host shouldn't serialise behind a slow font CDN.
    const [logoSrc, webFont] = await Promise.all([
        opts.kit.logoUrl ? inlineLogo(opts.kit.logoUrl) : Promise.resolve(null),
        loadWebFont(opts.kit.fontFamily),
    ]);
    // The bundled family stays registered as a fallback so a glyph missing from the web font
    // (a curly quote, an accent) still draws instead of becoming a blank box.
    const fonts = webFont ? [...webFont, ...brandCardFonts] : brandCardFonts;
    const fontFamily = webFont ? `${webFont[0].name}, ${BRAND_CARD_FONT_FAMILY}` : BRAND_CARD_FONT_FAMILY;

    // Built as plain satori element objects rather than JSX: these functions are compiled by
    // esbuild without a JSX runtime configured, and one renderer is not worth a build-config change.
    const el = (style: Record<string, unknown>, children: unknown) => ({ type: 'div', props: { style, children } });

    // The furniture is positioned absolutely rather than flowed, because the reviewer can now drag
    // it: a flex column can express "top, middle, bottom" and nothing in between. The headline
    // keeps the full safe area and stays optically centred, which is where space-between put it
    // anyway when the name and website were still pinned to the edges.
    const rail = width - pad * 2;
    const logoHeight = Math.round(pad * 0.62);
    const eyebrowSize = Math.round(width * 0.024);
    const websiteSize = Math.round(width * 0.026);

    const wordmarkAvailable = !!(logoSrc || eyebrowText);
    const websiteAvailable = !!opts.kit.website;
    const wordmarkHeight = logoSrc ? logoHeight : Math.round(eyebrowSize * 1.3);
    const websiteHeight = Math.round(websiteSize * 1.3);

    /** Clamp an element's top edge into the safe area, so no `y` can push it off the canvas. */
    const topFor = (y: number, elHeight: number) =>
        Math.round(Math.min(Math.max(y * height, pad), Math.max(pad, height - pad - elHeight)));

    const justify = (align: CardAlign) =>
        align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';

    /** One full-width rail at `top`; the child anchors left/centre/right inside it. */
    const placed = (top: number, elHeight: number, align: CardAlign, child: unknown) => el({
        position: 'absolute', left: pad, top, width: rail, height: elHeight,
        display: 'flex', alignItems: 'center', justifyContent: justify(align),
    }, child);

    const children: unknown[] = [
        el({
            position: 'absolute', left: pad, top: pad, width: rail, height: height - pad * 2,
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            fontSize: headlineFontSize(headline.length, width),
            lineHeight: 1.14, fontWeight: 800, color: palette.headline,
            // Long single words (a URL-ish product name) would otherwise print past the edge.
            overflow: 'hidden',
        }, headline),
    ];

    const elements: BrandCardResult['elements'] = {
        wordmark: { available: wordmarkAvailable, shown: false, box: null },
        website: { available: websiteAvailable, shown: false, box: null },
    };

    if (wordmarkAvailable && layout.wordmark.show) {
        const top = topFor(layout.wordmark.y, wordmarkHeight);
        children.push(placed(top, wordmarkHeight, layout.wordmark.align, logoSrc
            ? { type: 'img', props: { src: logoSrc, style: { height: logoHeight, objectFit: 'contain' } } }
            : el({
                display: 'flex', fontSize: eyebrowSize, fontWeight: 800,
                letterSpacing: Math.round(width * 0.004), color: palette.eyebrow,
            }, eyebrowText)));
        elements.wordmark = { available: true, shown: true, box: { left: pad, top, width: rail, height: wordmarkHeight } };
    }

    if (websiteAvailable && layout.website.show) {
        const top = topFor(layout.website.y, websiteHeight);
        children.push(placed(top, websiteHeight, layout.website.align, el({
            display: 'flex', fontSize: websiteSize, fontWeight: 400, color: palette.footer, opacity: 0.75,
        }, opts.kit.website)));
        elements.website = { available: true, shown: true, box: { left: pad, top, width: rail, height: websiteHeight } };
    }

    const svg = await satori(
        // satori accepts this lightweight VNode at runtime (its own JSX shape). Since @remotion pulled
        // @types/react into the tree, satori's `ReactNode` param now resolves to React's strict node
        // type, which this hand-built element doesn't structurally match — assert satori's own
        // parameter type rather than reshape a working call.
        el({
            display: 'flex', position: 'relative',
            width: '100%', height: '100%', backgroundColor: palette.background, fontFamily,
        }, children) as unknown as Parameters<typeof satori>[0],
        { width, height, fonts },
    );

    const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
    return { png, width, height, variant, headline, layout, elements };
}
