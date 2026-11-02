// src/lib/flyer.ts — printable flyers in the org's brand (docs/brand-designer-flyers-plan.md §3.4).
//
// Built from the brand card's pieces (src/lib/brand-card.ts): satori lays out real fonts, resvg
// rasterises, the palette and contrast rule are the card's. A flyer is mostly words, and the reason
// cards are not AI-painted applies twice over here — a misspelt phone number on 500 printed copies is
// worse than no flyer.
//
// ── Two outputs ─────────────────────────────────────────────────────────────────────────────────
// • A PREVIEW: the whole page as one PNG at PREVIEW_DPI, photo included — what the review grid shows.
// • A PDF (flyerPdf): the photo is embedded as ITSELF (a JPEG stays a JPEG) and the words are drawn
//   over it as a transparent PNG at PRINT_DPI. Flattening a full-page photo into a 300 dpi PNG made an
//   A4 PDF of ~20 MB; layered, it is the photo's own size plus a mostly-empty overlay.
//
// ── Text never gets cut off ─────────────────────────────────────────────────────────────────────
// satori has no "shrink to fit", so sizes are chosen up front from estimated wraps (the card's
// estimateWrappedLines, with a deliberately WIDE per-character estimate so a guess errs towards a
// spare line, not a lost one). Every block shrinks together towards a print minimum; if the words
// still do not fit, renderFlyer throws FlyerFitError naming the field, and the round says which field
// to shorten. It never draws a flyer with words missing.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { PDFDocument, clip, endPath, popGraphicsState, pushGraphicsState, rectangle } from 'pdf-lib';
import { brandCardFonts, BRAND_CARD_FONT_FAMILY } from './brand-card-fonts';
import { loadWebFont } from './brand-card-webfont';
import { estimateWrappedLines, inlineLogo, resolveCardPalette } from './brand-card';
import { readableInkOn, type BrandKit } from '../utils/brand-kit';
import { PAPER_SPECS, type FlyerContent, type FlyerLayout, type PaperSize } from '../config/flyer-vocab';

export const PREVIEW_DPI = 150;
export const PRINT_DPI = 300;
/** Below this a photo prints visibly soft. The option says so; it is not refused. */
export const MIN_PHOTO_DPI = 150;

export type FitField = 'headline' | 'subheading' | 'points' | 'offer' | 'callToAction' | 'dateLine' | 'contact';

const FIELD_WORDS: Record<FitField, string> = {
    headline: 'The headline is', subheading: 'The subheading is', points: 'The points are', offer: 'The offer is',
    callToAction: 'The call to action is', dateLine: 'The date line is', contact: 'The contact details are',
};

/** The words do not fit this paper even at the smallest print size. `message` is for the user. */
export class FlyerFitError extends Error {
    constructor(public readonly field: FitField, public readonly paperSize: PaperSize) {
        super(`${FIELD_WORDS[field]} too long to fit on ${paperSize}. Shorten it, or choose a bigger paper size.`);
        this.name = 'FlyerFitError';
    }
}

export interface FlyerPhoto { bytes: Buffer; mimeType: string; width: number | null; height: number | null }

/** A rectangle in canvas pixels (the canvas includes any bleed). */
export interface Box { left: number; top: number; width: number; height: number }

export interface FlyerGeometry {
    dpi: number;
    pxPerMm: number;
    /** sizes relative to A5 — type is set for A5 and scaled by width. */
    scale: number;
    trimWidth: number; trimHeight: number; bleed: number;
    canvasWidth: number; canvasHeight: number;
    pad: number;
    photo: Box | null;
    /** Where the words and footer go. */
    text: Box;
    /** The coloured panel the words sit on in the full-photo layout. */
    panel: Box | null;
}

/** Page geometry for a layout — pure, so the tests can check boxes without rendering. */
export function flyerGeometry(layout: FlyerLayout, paperSize: PaperSize, dpi: number, bleedMm = 0): FlyerGeometry {
    const spec = PAPER_SPECS[paperSize];
    const pxPerMm = dpi / 25.4;
    const mm = (n: number) => Math.round(n * pxPerMm);
    const trimWidth = mm(spec.widthMm);
    const trimHeight = mm(spec.heightMm);
    const bleed = mm(bleedMm);
    const canvasWidth = trimWidth + bleed * 2;
    const canvasHeight = trimHeight + bleed * 2;
    const pad = mm(Math.max(6, spec.widthMm * 0.068));
    const scale = spec.widthMm / 148;

    let photo: Box | null = null;
    let panel: Box | null = null;
    let text: Box;
    if (layout === 'photo_top') {
        const photoTrim = Math.round(trimHeight * 0.42);
        // The photo runs into the bleed on three sides; the words start below it.
        photo = { left: 0, top: 0, width: canvasWidth, height: bleed + photoTrim };
        const top = bleed + photoTrim + Math.round(pad * 0.8);
        text = { left: bleed + pad, top, width: trimWidth - pad * 2, height: bleed + trimHeight - pad - top };
    } else if (layout === 'photo_full') {
        photo = { left: 0, top: 0, width: canvasWidth, height: canvasHeight };
        const inset = Math.round(pad * 0.6);
        const panelTop = bleed + Math.round(trimHeight * 0.38);
        panel = { left: bleed + inset, top: panelTop, width: trimWidth - inset * 2, height: bleed + trimHeight - inset - panelTop };
        const inner = Math.round(pad * 0.8);
        text = { left: panel.left + inner, top: panel.top + inner, width: panel.width - inner * 2, height: panel.height - inner * 2 };
    } else {
        text = { left: bleed + pad, top: bleed + pad, width: trimWidth - pad * 2, height: trimHeight - pad * 2 };
    }
    return { dpi, pxPerMm, scale, trimWidth, trimHeight, bleed, canvasWidth, canvasHeight, pad, photo, text, panel };
}

/**
 * The dpi a photo prints at when it covers `box` — the lower of its two axes, since "cover" scales to
 * fill both. Null when the photo's size is unknown.
 */
export function effectivePhotoDpi(photo: { width: number | null; height: number | null }, box: Box, dpi: number): number | null {
    if (!photo.width || !photo.height) return null;
    const s = Math.max(box.width / photo.width, box.height / photo.height);
    return Math.round(dpi / s);
}

// ── Sizing the words ────────────────────────────────────────────────────────────────────────────

interface BlockSpec {
    field: FitField;
    /** Point size on A5, and the floor (scaled, then never below `absMin`). */
    base: number; min: number; absMin: number;
    weight: 400 | 800; lineHeight: number;
    texts: string[];
    /** Width lost to a bullet or a box's padding, in multiples of the font size. */
    insetEm: number;
    /** Extra vertical padding, in multiples of the font size (the offer's box). */
    padEm: number;
    /** Space between this block's own items (points), in multiples of the font size. */
    itemGapEm: number;
}

// Wide on purpose: an over-estimate costs a spare line of space, an under-estimate a lost word.
const CHAR_EM: Record<400 | 800, number> = { 400: 0.56, 800: 0.62 };

export function blockSpecs(content: FlyerContent, layout: FlyerLayout): BlockSpec[] {
    const specs: BlockSpec[] = [];
    const add = (s: Omit<BlockSpec, 'insetEm' | 'padEm' | 'itemGapEm'> & Partial<BlockSpec>) =>
        specs.push({ insetEm: 0, padEm: 0, itemGapEm: 0, ...s });
    if (content.dateLine) add({ field: 'dateLine', base: 13, min: 9, absMin: 8, weight: 800, lineHeight: 1.25, texts: [content.dateLine] });
    add({ field: 'headline', base: layout === 'type_only' ? 44 : 34, min: 16, absMin: 14, weight: 800, lineHeight: 1.1, texts: [content.headline] });
    if (content.subheading) add({ field: 'subheading', base: 15, min: 9, absMin: 8, weight: 400, lineHeight: 1.3, texts: [content.subheading] });
    if (content.points.length) add({ field: 'points', base: 13, min: 8.5, absMin: 8, weight: 400, lineHeight: 1.3, texts: content.points, insetEm: 1.1, itemGapEm: 0.4 });
    if (content.offer) add({ field: 'offer', base: 15, min: 9, absMin: 8, weight: 800, lineHeight: 1.25, texts: [content.offer], insetEm: 1.6, padEm: 1.0 });
    if (content.callToAction) add({ field: 'callToAction', base: 16, min: 10, absMin: 8, weight: 800, lineHeight: 1.25, texts: [content.callToAction] });
    return specs;
}

function blockHeight(b: BlockSpec, sizePx: number, width: number): number {
    const perLine = Math.max(1, Math.floor((width - b.insetEm * sizePx) / (sizePx * CHAR_EM[b.weight])));
    const lines = b.texts.reduce((n, t) => n + estimateWrappedLines(t, perLine), 0);
    return Math.ceil(lines * sizePx * b.lineHeight + b.padEm * sizePx + Math.max(0, b.texts.length - 1) * b.itemGapEm * sizePx);
}

export interface FittedBlock { spec: BlockSpec; sizePx: number; height: number }

/**
 * Shrink every block together until the stack fits `available`. Throws FlyerFitError naming the
 * block taking the most room when even the print minimum does not fit.
 */
export function fitBlocks(specs: BlockSpec[], width: number, available: number, g: Pick<FlyerGeometry, 'dpi' | 'scale'>, gap: number, paperSize: PaperSize): FittedBlock[] {
    const pt = (n: number) => n * g.dpi / 72;
    const minPx = (b: BlockSpec) => pt(Math.max(b.absMin, b.min * g.scale));
    const total = (blocks: FittedBlock[]) => blocks.reduce((n, b) => n + b.height, 0) + gap * Math.max(0, blocks.length - 1);
    let s = 1;
    for (;;) {
        const blocks = specs.map((spec) => {
            const sizePx = Math.max(minPx(spec), pt(spec.base * g.scale) * s);
            return { spec, sizePx, height: blockHeight(spec, sizePx, width) };
        });
        if (total(blocks) <= available) return blocks;
        if (blocks.every((b) => b.sizePx <= minPx(b.spec) + 0.01)) {
            const worst = blocks.reduce((a, b) => (b.height > a.height ? b : a), blocks[0]);
            throw new FlyerFitError(worst?.spec.field ?? 'headline', paperSize);
        }
        s *= 0.94;
    }
}

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────

export interface FlyerRender {
    png: Buffer;
    width: number; height: number;
    geometry: FlyerGeometry;
    /** The photo's printed dpi at this layout, or null (no photo / size unknown). */
    photoDpi: number | null;
}

type Node = { type: string; props: Record<string, unknown> };
const el = (style: Record<string, unknown>, children?: unknown): Node => ({ type: 'div', props: { style, children } });

function dataUri(bytes: Buffer, mimeType: string): string {
    return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

/**
 * Draw one flyer page. `drawPhoto: false` leaves the photo's box transparent — the PDF's word layer,
 * laid over the photo embedded as itself (flyerPdf). Throws FlyerFitError when the words do not fit.
 */
export async function renderFlyer(opts: {
    content: FlyerContent;
    kit: BrandKit;
    paperSize: PaperSize;
    layout: FlyerLayout;
    photo: FlyerPhoto | null;
    orgName?: string | null;
    dpi?: number;
    bleedMm?: number;
    drawPhoto?: boolean;
}): Promise<FlyerRender> {
    const { content, kit, paperSize, layout } = opts;
    const dpi = opts.dpi ?? PREVIEW_DPI;
    const g = flyerGeometry(layout, paperSize, dpi, opts.bleedMm ?? 0);
    if (g.photo && !opts.photo) throw new Error('flyer_needs_photo');
    const pt = (n: number) => n * dpi / 72;
    const mm = (n: number) => Math.round(n * g.pxPerMm);

    // Words on the light page in photo_top; on a brand-colour field everywhere else.
    const palette = resolveCardPalette(kit, layout === 'photo_top' ? 'light' : 'bold');
    const fieldColour = layout === 'photo_top' ? kit.backgroundColor : kit.primaryColor;
    const accent = palette.eyebrow;
    const ink = palette.footer;
    const offerBg = layout === 'photo_top' ? kit.primaryColor : kit.backgroundColor;
    const offerInk = readableInkOn(offerBg, kit.textColor);

    const [logoSrc, webFont, qrSrc] = await Promise.all([
        kit.logoUrl ? inlineLogo(kit.logoUrl) : Promise.resolve(null),
        loadWebFont(kit.fontFamily),
        content.qr ? QRCode.toDataURL(content.qr.url, {
            // Black on white whatever the brand: a QR in brand colours is the one that will not scan.
            errorCorrectionLevel: 'M', margin: 4, width: mm(Math.max(22, PAPER_SPECS[paperSize].widthMm * 0.17)),
            color: { dark: '#000000', light: '#ffffff' },
        }) : Promise.resolve(null),
    ]);
    const fonts = webFont ? [...webFont, ...brandCardFonts] : brandCardFonts;
    const fontFamily = webFont ? `${webFont[0].name}, ${BRAND_CARD_FONT_FAMILY}` : BRAND_CARD_FONT_FAMILY;

    const box = g.text;
    const gap = mm(3.5 * g.scale);

    // ── Wordmark row ──
    const eyebrowText = (kit.wordmark || opts.orgName || '').trim().toUpperCase().slice(0, 32);
    const eyebrowSize = pt(Math.max(8, 10 * g.scale));
    const logoHeight = mm(9 * g.scale);
    const wordmarkHeight = logoSrc ? logoHeight : eyebrowText ? Math.round(eyebrowSize * 1.3) : 0;

    // ── Footer: contact lines beside the QR ──
    const qrSize = qrSrc ? mm(Math.max(22, PAPER_SPECS[paperSize].widthMm * 0.17)) : 0;
    const contactLines = [
        content.qr?.label ? { text: content.qr.label, weight: 800 as const, wrap: true } : null,
        content.contact.phone ? { text: content.contact.phone, weight: 800 as const, wrap: false } : null,
        content.contact.email ? { text: content.contact.email, weight: 400 as const, wrap: false } : null,
        content.contact.website ? { text: content.contact.website, weight: 400 as const, wrap: false } : null,
        content.contact.address ? { text: content.contact.address, weight: 400 as const, wrap: true } : null,
    ].filter((l): l is { text: string; weight: 400 | 800; wrap: boolean } => !!l);
    const contactWidth = box.width - (qrSize ? qrSize + gap : 0);
    let contactSize = pt(Math.max(7, 9 * g.scale));
    const contactHeight = (size: number) => contactLines.reduce((n, l) => {
        const perLine = Math.max(1, Math.floor(contactWidth / (size * CHAR_EM[l.weight])));
        // A phone number, email or web address must never wrap mid-way: it is shrunk to fit one line.
        return n + (l.wrap ? estimateWrappedLines(l.text, perLine) : 1) * size * 1.3;
    }, 0);
    const longestUnwrapped = (size: number) => contactLines.filter((l) => !l.wrap)
        .reduce((w, l) => Math.max(w, l.text.length * size * CHAR_EM[l.weight]), 0);
    while (contactSize > pt(6.5) && longestUnwrapped(contactSize) > contactWidth) contactSize *= 0.94;
    if (contactLines.length && (contactWidth <= 0 || longestUnwrapped(contactSize) > contactWidth)) throw new FlyerFitError('contact', paperSize);
    const footerHeight = Math.ceil(Math.max(qrSize, contactLines.length ? contactHeight(contactSize) : 0));

    const available = box.height - (wordmarkHeight ? wordmarkHeight + gap : 0) - (footerHeight ? footerHeight + gap : 0);
    if (available <= 0) throw new FlyerFitError('contact', paperSize);
    const blocks = fitBlocks(blockSpecs(content, layout), box.width, available, g, gap, paperSize);

    // ── Building the page ──
    const textNode = (s: string, style: Record<string, unknown>) => el({ display: 'flex', wordBreak: 'break-word', ...style }, s);
    const stackChildren: Node[] = blocks.map(({ spec, sizePx }) => {
        const common = { fontSize: sizePx, lineHeight: spec.lineHeight, fontWeight: spec.weight };
        switch (spec.field) {
            case 'dateLine': return textNode(spec.texts[0], { ...common, color: accent, textTransform: 'uppercase', letterSpacing: Math.round(sizePx * 0.04) });
            case 'headline': return textNode(spec.texts[0], { ...common, color: palette.headline });
            case 'subheading': return textNode(spec.texts[0], { ...common, color: ink });
            case 'callToAction': return textNode(spec.texts[0], { ...common, color: palette.headline });
            case 'offer': return el({
                display: 'flex', alignSelf: 'flex-start', maxWidth: '100%', backgroundColor: offerBg, color: offerInk,
                padding: `${Math.round(sizePx * 0.5)}px ${Math.round(sizePx * 0.8)}px`, borderRadius: Math.round(sizePx * 0.4), ...common,
            }, textNode(spec.texts[0], {}));
            case 'points': return el({ display: 'flex', flexDirection: 'column', gap: Math.round(sizePx * spec.itemGapEm) },
                spec.texts.map((p) => el({ display: 'flex', flexDirection: 'row', alignItems: 'flex-start' }, [
                    el({
                        width: Math.round(sizePx * 0.38), height: Math.round(sizePx * 0.38), borderRadius: 999, backgroundColor: accent,
                        marginTop: Math.round(sizePx * 0.46), marginRight: Math.round(sizePx * 0.72), flexShrink: 0,
                    }),
                    textNode(p, { ...common, color: ink, flex: 1 }),
                ])));
            default: return el({});
        }
    });

    const column: Node[] = [];
    if (wordmarkHeight) {
        column.push(el({ display: 'flex', height: wordmarkHeight, alignItems: 'center', marginBottom: gap },
            logoSrc
                ? { type: 'img', props: { src: logoSrc, style: { height: logoHeight, objectFit: 'contain' } } }
                : textNode(eyebrowText, { fontSize: eyebrowSize, fontWeight: 800, letterSpacing: Math.round(eyebrowSize * 0.12), color: accent })));
    }
    column.push(el({
        display: 'flex', flexDirection: 'column', gap, height: available, overflow: 'hidden',
        justifyContent: layout === 'photo_top' ? 'flex-start' : 'center',
    }, stackChildren));
    if (footerHeight) {
        column.push(el({ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', height: footerHeight, marginTop: gap }, [
            el({ display: 'flex', flexDirection: 'column', flex: 1, justifyContent: 'flex-end' },
                contactLines.map((l) => textNode(l.text, {
                    fontSize: contactSize, lineHeight: 1.3, fontWeight: l.weight, color: l.weight === 800 ? palette.headline : ink,
                    ...(l.wrap ? {} : { whiteSpace: 'nowrap' }),
                }))),
            ...(qrSrc ? [{ type: 'img', props: { src: qrSrc, width: qrSize, height: qrSize, style: { width: qrSize, height: qrSize, marginLeft: gap } } }] : []),
        ]));
    }

    const layers: Node[] = [];
    // The background field: everything except the photo's box, which is left clear for the photo
    // (or for the PDF to lay the photo under this layer).
    if (layout === 'photo_top' && g.photo) {
        layers.push(el({ position: 'absolute', left: 0, top: g.photo.height, width: g.canvasWidth, height: g.canvasHeight - g.photo.height, backgroundColor: fieldColour }));
    } else if (layout === 'type_only') {
        layers.push(el({ position: 'absolute', left: 0, top: 0, width: g.canvasWidth, height: g.canvasHeight, backgroundColor: fieldColour }));
    }
    if (g.photo && opts.photo && opts.drawPhoto !== false) {
        layers.unshift({ type: 'img', props: {
            src: dataUri(opts.photo.bytes, opts.photo.mimeType), width: g.photo.width, height: g.photo.height,
            style: { position: 'absolute', left: g.photo.left, top: g.photo.top, width: g.photo.width, height: g.photo.height, objectFit: 'cover' },
        } });
    }
    if (g.panel) {
        layers.push(el({ position: 'absolute', left: g.panel.left, top: g.panel.top, width: g.panel.width, height: g.panel.height, backgroundColor: fieldColour, borderRadius: mm(2.5) }));
    }
    layers.push(el({ position: 'absolute', left: box.left, top: box.top, width: box.width, height: box.height, display: 'flex', flexDirection: 'column' }, column));

    const svg = await satori(
        // The same lightweight VNode the brand card hands satori — see the note in brand-card.ts.
        el({ display: 'flex', position: 'relative', width: '100%', height: '100%', fontFamily }, layers) as unknown as Parameters<typeof satori>[0],
        { width: g.canvasWidth, height: g.canvasHeight, fonts },
    );
    const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: g.canvasWidth } }).render().asPng());
    return {
        png, width: g.canvasWidth, height: g.canvasHeight, geometry: g,
        photoDpi: g.photo && opts.photo ? effectivePhotoDpi(opts.photo, g.photo, dpi) : null,
    };
}

// ── The PDF ─────────────────────────────────────────────────────────────────────────────────────

/** Photos the PDF can embed as themselves. Anything else is flattened into the word layer. */
export function pdfCanEmbed(mimeType: string | null | undefined): boolean {
    return /^image\/(jpe?g|png)$/i.test(String(mimeType ?? '').split(';')[0].trim());
}

/**
 * A print PDF at the exact paper size (plus bleed, when asked). The photo is drawn cover-cropped into
 * its box, then the word layer over the whole page. With bleed, the TrimBox/BleedBox are set, which is
 * how a print shop's software finds the cut line.
 */
export async function flyerPdf(opts: {
    words: FlyerRender;
    photo: FlyerPhoto | null;
    title: string;
}): Promise<Buffer> {
    const { words } = opts;
    const g = words.geometry;
    const k = 72 / g.dpi;   // canvas px → PDF points
    const doc = await PDFDocument.create();
    doc.setTitle(opts.title.slice(0, 200));
    doc.setCreator('Be More Swan');
    doc.setProducer('Be More Swan');
    const W = g.canvasWidth * k;
    const H = g.canvasHeight * k;
    const page = doc.addPage([W, H]);

    if (g.photo && opts.photo && pdfCanEmbed(opts.photo.mimeType)) {
        const img = /png/i.test(opts.photo.mimeType) ? await doc.embedPng(opts.photo.bytes) : await doc.embedJpg(opts.photo.bytes);
        const bx = g.photo.left * k;
        const bw = g.photo.width * k;
        const bh = g.photo.height * k;
        const by = H - (g.photo.top * k) - bh;
        const s = Math.max(bw / img.width, bh / img.height);
        const dw = img.width * s;
        const dh = img.height * s;
        page.pushOperators(pushGraphicsState(), rectangle(bx, by, bw, bh), clip(), endPath());
        page.drawImage(img, { x: bx + (bw - dw) / 2, y: by + (bh - dh) / 2, width: dw, height: dh });
        page.pushOperators(popGraphicsState());
    }
    const layer = await doc.embedPng(words.png);
    page.drawImage(layer, { x: 0, y: 0, width: W, height: H });

    if (g.bleed > 0) {
        const b = g.bleed * k;
        page.setBleedBox(0, 0, W, H);
        page.setTrimBox(b, b, W - b * 2, H - b * 2);
    }
    return Buffer.from(await doc.save());
}

/**
 * Both print files for an approved flyer: the exact page for home printing, and the print-shop page
 * with 3 mm bleed. A photo the PDF cannot embed (webp) is flattened into the words layer instead.
 */
export async function renderFlyerPdfs(opts: {
    content: FlyerContent; kit: BrandKit; paperSize: PaperSize; layout: FlyerLayout;
    photo: FlyerPhoto | null; orgName?: string | null; title: string; bleedMm: number;
}): Promise<{ home: Buffer; printShop: Buffer }> {
    const layered = !opts.photo || pdfCanEmbed(opts.photo.mimeType);
    const one = async (bleedMm: number) => {
        const words = await renderFlyer({ ...opts, dpi: PRINT_DPI, bleedMm, drawPhoto: !layered });
        return flyerPdf({ words, photo: layered ? opts.photo : null, title: opts.title });
    };
    const home = await one(0);
    const printShop = await one(opts.bleedMm);
    return { home, printShop };
}
