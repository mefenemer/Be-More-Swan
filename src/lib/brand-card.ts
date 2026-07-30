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
 * Both axes are free. `x` used to snap to three anchors because a freely-positioned x needs the
 * rendered TEXT WIDTH to clamp against and satori only knows that after layout — so a right-dragged
 * wordmark could print off the edge, discovered only once published. The snap made overhang
 * impossible by construction, and it made dragging feel broken: the block jumped between thirds.
 *
 * Overhang is now impossible by a different construction, in two independent layers:
 *   1. the block's width is ESTIMATED here and `x` is clamped so its right edge lands inside the
 *      CANVAS, and
 *   2. the rendered block is capped to the space actually remaining to its right, with
 *      `overflow: hidden` — so even a bad estimate wraps or clips instead of printing off the card.
 * Layer 2 is what makes layer 1 safe to be an estimate rather than a measurement.
 *
 * The clamp is the canvas, not the safe area, ONLY for an element that has been dragged. Springing a
 * hand-placed block back to an invisible margin is the other thing that made this feel like it was
 * snapping. An element still on its default position keeps the safe area, so no existing card moves.
 */
export interface CardElementLayout {
    show: boolean;
    /**
     * The anchor `x: null` falls back to. Kept as its own field rather than folded into `x` so the
     * alignment buttons stay meaningful ("pin this to the left rail") and so every card saved before
     * `x` existed renders EXACTLY as it did — see `x`.
     */
    align: CardAlign;
    /**
     * Top edge as a fraction of canvas height.
     *
     * Clamped at render time to the CANVAS once the element has been dragged (`x !== null`), and to
     * the safe area until then — so an untouched card's y:0 still means "at the top padding", while
     * a dragged one can sit flush to the edge if that is where it was put. Never off the card either
     * way.
     */
    y: number;
    /**
     * Centre of the block as a fraction of canvas width, or `null` for "anchor to `align` instead".
     *
     * Null is the migration: a card stored before dragging was free has no `x`, and must keep
     * rendering off `align` alone. Nothing back-fills it — an x is only ever written by someone
     * actually dragging the block, and the alignment buttons clear it back to null.
     *
     * The centre (not the left edge) is the anchor so that dragging matches the overlay editor,
     * which is the gesture this is being made to feel like.
     */
    x: number | null;
}

/**
 * The placeable pieces of a card.
 *
 * `headline` joined wordmark and website so the words can be dragged like everything else. It keeps
 * the same shape for one reason — every consumer (normalizeCardElement, the drag handles, the
 * clamp) already works on that shape — but its `show` is meaningless: a card with no headline is
 * not a card, so the renderer ignores it and nothing offers to hide it.
 */
export interface CardLayout {
    headline: CardElementLayout;
    wordmark: CardElementLayout;
    website: CardElementLayout;
}

/**
 * Name top-left, website bottom-left, headline centred.
 *
 * The headline's default y of 0.5 reproduces exactly where it used to be pinned — the old renderer
 * gave it the whole safe area with justifyContent:center — so a card saved before it became
 * draggable renders identically after.
 */
export const DEFAULT_CARD_LAYOUT: CardLayout = {
    headline: { show: true, align: 'left', y: 0.5, x: null },
    wordmark: { show: true, align: 'left', y: 0, x: null },
    website: { show: true, align: 'left', y: 1, x: null },
};

function normalizeCardElement(raw: unknown, fallback: CardElementLayout): CardElementLayout {
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const align = o.align === 'left' || o.align === 'center' || o.align === 'right' ? o.align : fallback.align;
    const y = Number(o.y);
    // ABSENT and NULL are the same answer here — "no free x, use the anchor" — but junk is too: an
    // unparseable x must not become 0, which would silently drag the block to the left edge of a
    // card nobody touched.
    const x = o.x === null || o.x === undefined ? null : Number(o.x);
    return {
        show: typeof o.show === 'boolean' ? o.show : fallback.show,
        align,
        y: Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : fallback.y,
        x: x !== null && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null,
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
        headline: normalizeCardElement(o.headline, DEFAULT_CARD_LAYOUT.headline),
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

/**
 * How many lines this text will occupy when wrapped at `perLine` characters.
 *
 * Simulates GREEDY WORD WRAP, which is what satori actually does. The previous estimate was
 * `ceil(text.length / perLine)` — character packing with no regard for word boundaries — and it
 * under-counts every time a word straddles the wrap point. That is not a rare edge: a 66-character
 * headline at 23 chars/line estimated 3 lines and rendered 4.
 *
 * Under-counting is destructive rather than merely untidy, because the headline block is sized from
 * this number and drawn with justifyContent:center + overflow:hidden — so a box one line short does
 * not spill off the bottom, it clips the text at BOTH ends and eats the first and last lines.
 *
 * A word longer than `perLine` (a URL-ish product name) gets its own line and is left to the
 * renderer's own overflow rule; counting the sub-lines it would break into would over-count far more
 * often than that case occurs.
 */
export function estimateWrappedLines(text: string, perLine: number): number {
    const width = Math.max(1, perLine);
    let lines = 0;
    for (const paragraph of text.split('\n')) {
        const words = paragraph.split(/\s+/).filter(Boolean);
        if (words.length === 0) { lines += 1; continue; }
        lines += 1;
        let used = 0;
        for (const word of words) {
            const candidate = used === 0 ? word.length : used + 1 + word.length;
            if (candidate <= width || used === 0) {
                used = candidate;
            } else {
                lines += 1;
                used = word.length;
            }
        }
    }
    return lines;
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
    elements: { headline: CardElementRender; wordmark: CardElementRender; website: CardElementRender };
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

    /**
     * Where an element's top edge lands.
     *
     * Two rules, chosen by whether the reviewer has ever placed this element by hand (`free`).
     *
     * NOT free — the element still sits on its default y (0, 0.5, 1) — keeps the safe-area clamp
     * exactly as it was. That is what makes y:0 mean "at the top padding" rather than "flush to the
     * edge", and it is the placement every card drafted so far already has. Widening this branch
     * would move the furniture on every existing card at once.
     *
     * Free — the reviewer dragged it — clamps only to the CANVAS. Being unable to put the company
     * name in the margin is the "snap" people hit: you drag to the edge and it springs back to the
     * padding. The safe area is good advice about where text stays legible, not a rule the card
     * gets to enforce over an explicit instruction.
     */
    const topFor = (y: number, elHeight: number, free: boolean) =>
        free
            ? Math.round(Math.min(Math.max(y * height, 0), Math.max(0, height - elHeight)))
            : Math.round(Math.min(Math.max(y * height, pad), Math.max(pad, height - pad - elHeight)));

    const justify = (align: CardAlign) =>
        align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';

    /**
     * Where a block of estimated width `w` actually lands, and how wide its box may be.
     *
     * With no free `x` this is the old behaviour exactly: the full safe-area rail, with the child
     * anchored inside it by `justifyContent`. That is the path every card saved before dragging was
     * free still takes, so none of them move by a pixel.
     *
     * With a free `x` the block becomes its own box, centred on `x` and then clamped to the CANVAS —
     * not to the safe area. Clamping a hand-placed block to the padding is the "snap" people run
     * into: you drag the website into the corner and it springs back to an invisible margin. The
     * safe area is where text is guaranteed legible, which is the right DEFAULT and the wrong veto
     * over somebody who has deliberately dragged something into the corner.
     *
     * The canvas edge itself is still enforced, and `w` is only an estimate, so the returned width
     * is capped to the room actually left to the right of `left` — the second, independent guard
     * that makes an estimate safe to clamp with. Overflow is hidden by the callers, so the worst a
     * bad estimate can do is wrap or clip text INSIDE the card, never print it off the edge.
     */
    const place = (x: number | null, w: number) => {
        if (x === null) return { left: pad, width: rail, free: false };
        // The estimate is deliberately GENEROUS. It decides how much room the block gets, and the
        // two errors are not symmetric: over-estimating costs a few px of position, while
        // under-estimating loses letters — which is exactly what dropping a block in a corner used
        // to expose, once the safe area stopped holding it back from the edge. A long wordmark wrapped
        // and had its second line cut off by `overflow: hidden`, and a long website lost its last
        // character. Both were the estimate being ~7% short with no slack to absorb it.
        const wide = Math.min(Math.ceil(w * 1.15), width);
        const left = Math.round(Math.min(Math.max(x * width - wide / 2, 0), Math.max(0, width - wide)));
        return { left, width: Math.min(wide, width - left), free: true };
    };

    /** One rail (or one free block) at `top`; the child anchors inside it. */
    const placed = (top: number, elHeight: number, e: CardElementLayout, w: number, child: unknown) => {
        const p = place(e.x, w);
        return el({
            position: 'absolute', left: p.left, top, width: p.width, height: elHeight,
            display: 'flex', alignItems: 'center',
            // A freely-placed block IS its own width, so there is nothing left to anchor within it.
            justifyContent: p.free ? 'flex-start' : justify(e.align),
            // The furniture is single-line by design, and its box is exactly one line tall. Letting it
            // wrap therefore does not shrink the text, it HIDES the second line — so a name too wide
            // for where it was dropped silently lost half of itself. Refusing the wrap makes the
            // failure a slight clip at the edge instead of a missing word, and the generous estimate
            // above is what stops it reaching even that.
            whiteSpace: 'nowrap',
            overflow: 'hidden',
        }, child);
    };

    // ── Estimating how wide a block will print ───────────────────────────────────────────────────
    // satori knows the true advance only after layout, and the clamp has to happen before it. These
    // are the same per-character approximations the headline already used to count its wraps, so
    // they are no less trustworthy than the box the drag handle is drawn on — and `place` caps the
    // result either way.
    const textWidth = (text: string, size: number, perChar: number, tracking = 0) =>
        Math.ceil(text.length * (size * perChar + tracking));

    // ── The headline, placed like everything else ────────────────────────────────────────────
    // It used to be given the whole safe area with justifyContent:center — which is why it could not
    // be dragged: "centred in the remaining space" has no y to move. It now gets a measured block at
    // a y like the other elements, and the box it occupies is reported back so the editor can put a
    // drag handle exactly over the words.
    //
    // The height is ESTIMATED, because satori only knows the true wrap after it lays the card out
    // and the box has to be decided before that. It only has to be self-consistent: the handle is
    // positioned from this same number, so the band the user grabs is the band the text occupies.
    // ~0.52em average advance for this weight at display sizes — close enough to count wraps.
    const charsPerLine = (size: number) => Math.max(1, Math.floor(rail / (size * 0.52)));
    const blockHeight = (lines: number, size: number) => Math.round(lines * size * 1.14);

    // Shrink to fit. satori has no such thing, so it is done here: pick the banded size, and while
    // the wrapped block would be taller than the safe area, step down. Without this the height was
    // simply CLAMPED to the safe area while the text kept its size — the overflow then clipped away
    // the first and last lines (see estimateWrappedLines). Clamping hides the symptom; shrinking is
    // the only thing that actually makes the words fit.
    const maxHeadlineHeight = height - pad * 2;
    const minHeadlineSize = Math.round(width * 0.03);
    let headlineSize = headlineFontSize(headline.length, width);
    let perLine = charsPerLine(headlineSize);
    let wrapped = estimateWrappedLines(headline, perLine);
    while (headlineSize > minHeadlineSize && blockHeight(wrapped, headlineSize) > maxHeadlineHeight) {
        headlineSize = Math.max(minHeadlineSize, Math.round(headlineSize * 0.94));
        perLine = charsPerLine(headlineSize);
        wrapped = estimateWrappedLines(headline, perLine);
    }
    const headlineHeight = Math.min(maxHeadlineHeight, blockHeight(wrapped, headlineSize));
    // `free` is simply "has this ever been dragged": a drag writes both axes at once (see
    // _pceDragEnd), so a non-null x is the reliable marker that the reviewer placed this element
    // themselves — and therefore that the safe-area clamp should not overrule them.
    const headlineTop = topFor(layout.headline.y - (headlineHeight / height) / 2, headlineHeight, layout.headline.x !== null);
    // A wrapped headline fills the rail; a short one is only as wide as its longest line. Using the
    // longest line (not the whole string) is what stops a two-word headline being clamped as though
    // it were a paragraph, which would stop it reaching the right-hand side of the card at all.
    const longestLine = headline.split('\n').reduce((n, l) => Math.max(n, Math.min(l.length, perLine)), 0);
    const headlinePlace = place(layout.headline.x, textWidth(' '.repeat(longestLine), headlineSize, 0.52));

    const children: unknown[] = [
        el({
            position: 'absolute', left: headlinePlace.left, top: headlineTop,
            width: headlinePlace.width, height: headlineHeight,
            display: 'flex', flexDirection: 'column',
            justifyContent: 'center',
            alignItems: headlinePlace.free ? 'flex-start' : justify(layout.headline.align),
            textAlign: headlinePlace.free ? 'left' : layout.headline.align,
            fontSize: headlineSize,
            lineHeight: 1.14, fontWeight: 800, color: palette.headline,
            // Long single words (a URL-ish product name) would otherwise print past the edge.
            overflow: 'hidden',
        }, headline),
    ];

    const elements: BrandCardResult['elements'] = {
        // `show` is not offered for the headline, so it is always shown and always has a box.
        headline: {
            available: true, shown: true,
            box: { left: headlinePlace.left, top: headlineTop, width: headlinePlace.width, height: headlineHeight },
        },
        wordmark: { available: wordmarkAvailable, shown: false, box: null },
        website: { available: websiteAvailable, shown: false, box: null },
    };

    if (wordmarkAvailable && layout.wordmark.show) {
        const top = topFor(layout.wordmark.y, wordmarkHeight, layout.wordmark.x !== null);
        // A logo has no glyphs to count. 3:1 is the ordinary wordmark-lockup aspect, and `place`
        // caps whatever this returns — a wrong guess costs position, never an overhang.
        const wordmarkWidth = logoSrc
            ? logoHeight * 3
            : textWidth(eyebrowText, eyebrowSize, 0.62, Math.round(width * 0.004));
        const p = place(layout.wordmark.x, wordmarkWidth);
        children.push(placed(top, wordmarkHeight, layout.wordmark, wordmarkWidth, logoSrc
            ? { type: 'img', props: { src: logoSrc, style: { height: logoHeight, objectFit: 'contain' } } }
            : el({
                display: 'flex', fontSize: eyebrowSize, fontWeight: 800,
                letterSpacing: Math.round(width * 0.004), color: palette.eyebrow,
            }, eyebrowText)));
        elements.wordmark = { available: true, shown: true, box: { left: p.left, top, width: p.width, height: wordmarkHeight } };
    }

    if (websiteAvailable && layout.website.show) {
        const top = topFor(layout.website.y, websiteHeight, layout.website.x !== null);
        const websiteWidth = textWidth(String(opts.kit.website), websiteSize, 0.5);
        const p = place(layout.website.x, websiteWidth);
        children.push(placed(top, websiteHeight, layout.website, websiteWidth, el({
            display: 'flex', fontSize: websiteSize, fontWeight: 400, color: palette.footer, opacity: 0.75,
        }, opts.kit.website)));
        elements.website = { available: true, shown: true, box: { left: p.left, top, width: p.width, height: websiteHeight } };
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
