// src/lib/design-render.ts — draws a Design (src/utils/design-doc.ts) as a PNG or print PDF, and makes the first Design
// for a flyer page or a picture. The same numbers as the browser's studio (design-studio.js): what is dragged there is
// what prints here. The flyer's first layout comes from src/lib/flyer.ts, so a page opened in the studio starts where
// the round drew it.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import QRCode from 'qrcode';
import { PDFDocument, clip, endPath, popGraphicsState, pushGraphicsState, rectangle, rgb } from 'pdf-lib';
import { brandCardFonts, BRAND_CARD_FONT_FAMILY } from './brand-card-fonts';
import { loadWebFont, type SatoriFont } from './brand-card-webfont';
import { inlineLogo } from './brand-card';
import { PREVIEW_DPI, PRINT_DPI, blockSpecs, fitBlocks, flyerGeometry, flyerPageStyle, olderPageStyle, pdfCanEmbed, type FlyerPageStyle, type FlyerPhoto } from './flyer';
import { PAPER_SPECS, type FlyerContent, type FlyerLayout, type PaperSize } from '../config/flyer-vocab';
import { BOX_PAD_RATIO, LINE_HEIGHT, type Design, type DesignLayer, type DesignPhotoRef, type TextLayer } from '../utils/design-doc';
import type { BrandKit } from '../utils/brand-kit';

type Node = { type: string; props: Record<string, unknown> };
const el = (style: Record<string, unknown>, children?: unknown): Node => ({ type: 'div', props: { style, children } });

function rgba(hex: string, alpha: number): string {
    const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})` : hex;
}

export interface DesignRender { png: Buffer; width: number; height: number }

/**
 * The page at `width` × `height` px of TRIMMED page, plus `bleedPx` all round. `words: true` draws only the layers on
 * a transparent page, which the PDF lays over the page colour and the picture embedded as itself.
 */
export async function renderDesign(opts: { design: Design; photo: FlyerPhoto | null; width: number; height: number; bleedPx?: number; words?: boolean }): Promise<DesignRender> {
    const { design, width: W, height: H } = opts;
    const bleed = opts.bleedPx ?? 0;
    const canvasW = W + bleed * 2;
    const canvasH = H + bleed * 2;
    const X = (f: number) => Math.round(bleed + f * W);
    const Y = (f: number) => Math.round(bleed + f * H);

    const families = [...new Set(design.layers.filter((l): l is TextLayer => l.kind === 'text').map((l) => l.fontFamily).filter((f): f is string => !!f))];
    const loaded = (await Promise.all(families.map((f) => loadWebFont(f)))).filter((f): f is SatoriFont[] => !!f);
    const fonts = [...loaded.flat(), ...brandCardFonts];
    const familyOf = (name: string | null) => {
        const hit = name ? loaded.find((f) => f[0].name.toLowerCase() === name.toLowerCase()) : null;
        return hit ? `${hit[0].name}, ${BRAND_CARD_FONT_FAMILY}` : BRAND_CARD_FONT_FAMILY;
    };

    const nodes: Node[] = [];
    if (!opts.words) nodes.push(el({ position: 'absolute', left: 0, top: 0, width: canvasW, height: canvasH, backgroundColor: design.pageColor }));
    if (design.photo && opts.photo && !opts.words) {
        const b = photoBox(design, W, H, bleed);
        nodes.push({ type: 'img', props: {
            src: `data:${opts.photo.mimeType};base64,${opts.photo.bytes.toString('base64')}`, width: b.width, height: b.height,
            style: { position: 'absolute', left: b.left, top: b.top, width: b.width, height: b.height, objectFit: 'cover', opacity: design.photo.opacity },
        } });
    }
    for (const l of design.layers) {
        const node = await layerNode(l, { X, Y, W, H, familyOf });
        if (node) nodes.push(node);
    }
    const svg = await satori(
        el({ display: 'flex', position: 'relative', width: '100%', height: '100%', fontFamily: BRAND_CARD_FONT_FAMILY }, nodes) as unknown as Parameters<typeof satori>[0],
        { width: canvasW, height: canvasH, fonts },
    );
    return { png: Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: canvasW } }).render().asPng()), width: canvasW, height: canvasH };
}

/** The picture's box in canvas px. A picture touching an edge of the page runs on through the bleed. */
function photoBox(design: Design, W: number, H: number, bleed: number) {
    const p = design.photo!;
    let left = bleed + p.x * W;
    let top = bleed + p.y * H;
    let right = left + p.w * W;
    let bottom = top + p.h * H;
    if (p.x <= 0.001) left = 0;
    if (p.y <= 0.001) top = 0;
    if (p.x + p.w >= 0.999) right = W + bleed * 2;
    if (p.y + p.h >= 0.999) bottom = H + bleed * 2;
    return { left: Math.round(left), top: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

async function layerNode(l: DesignLayer, g: { X: (f: number) => number; Y: (f: number) => number; W: number; H: number; familyOf: (n: string | null) => string }): Promise<Node | null> {
    if (l.kind === 'shape') {
        return el({ position: 'absolute', left: g.X(l.x), top: g.Y(l.y), width: Math.round(l.w * g.W), height: Math.round(l.h * g.H), backgroundColor: l.color, opacity: l.opacity, borderRadius: l.round ? 99999 : 0 });
    }
    if (l.kind !== 'text') {
        const src = l.kind === 'logo' && !l.src.startsWith('data:') ? await inlineLogo(l.src) : l.src;
        if (!src) return null;
        const width = Math.round(l.w * g.W);
        const height = Math.round(l.h * g.H);
        return { type: 'img', props: { src, width, height, style: { position: 'absolute', left: g.X(l.x), top: g.Y(l.y), width, height, objectFit: 'contain' } } };
    }
    return textNode(l, g);
}

function textNode(l: TextLayer, g: { X: (f: number) => number; Y: (f: number) => number; W: number; H: number; familyOf: (n: string | null) => string }): Node | null {
    if (!l.text.trim()) return null;
    const size = l.fontSizePct * g.H;
    const pad = l.boxFill ? Math.round(size * BOX_PAD_RATIO) : 0;
    const justify = l.align === 'center' ? 'center' : l.align === 'right' ? 'flex-end' : 'flex-start';
    return el({
        position: 'absolute', left: g.X(l.x), top: g.Y(l.y), width: Math.round(l.w * g.W), display: 'flex', flexDirection: 'column',
        padding: pad, borderRadius: l.boxFill ? Math.round(size * 0.25) : 0, backgroundColor: l.boxFill ? rgba(l.boxFill, l.boxOpacity) : 'transparent',
        fontFamily: g.familyOf(l.fontFamily),
    }, l.text.split('\n').map((row) => el({
        display: 'flex', width: '100%', justifyContent: justify, textAlign: l.align, wordBreak: 'break-word',
        fontSize: size, lineHeight: LINE_HEIGHT, fontWeight: l.bold ? 800 : 400, color: l.color,
        minHeight: Math.round(size * LINE_HEIGHT),
    }, row)));
}

// ── The print PDF ───────────────────────────────────────────────────────────────────────────────

function hexRgb(hex: string) {
    return rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}

/** A PDF at the paper size plus bleed: page colour, the picture embedded as itself, the layers over it. */
async function onePdf(opts: { design: Design; photo: FlyerPhoto | null; title: string; bleedMm: number }): Promise<Buffer> {
    const { design } = opts;
    const spec = PAPER_SPECS[(design.paperSize as PaperSize) ?? 'A5'] ?? PAPER_SPECS.A5;
    const px = (mm: number) => Math.round(mm * PRINT_DPI / 25.4);
    const W = px(spec.widthMm);
    const H = px(spec.heightMm);
    const bleed = px(opts.bleedMm);
    const layered = !opts.photo || pdfCanEmbed(opts.photo.mimeType);
    const words = await renderDesign({ design, photo: opts.photo, width: W, height: H, bleedPx: bleed, words: layered });

    const k = 72 / PRINT_DPI;
    const doc = await PDFDocument.create();
    doc.setTitle(opts.title.slice(0, 200));
    doc.setCreator('Be More Swan');
    doc.setProducer('Be More Swan');
    const pageW = words.width * k;
    const pageH = words.height * k;
    const page = doc.addPage([pageW, pageH]);
    if (layered) {
        page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: hexRgb(design.pageColor) });
        if (design.photo && opts.photo) {
            const img = /png/i.test(opts.photo.mimeType) ? await doc.embedPng(opts.photo.bytes) : await doc.embedJpg(opts.photo.bytes);
            const b = photoBox(design, W, H, bleed);
            const bx = b.left * k;
            const bw = b.width * k;
            const bh = b.height * k;
            const by = pageH - b.top * k - bh;
            const s = Math.max(bw / img.width, bh / img.height);
            const dw = img.width * s;
            const dh = img.height * s;
            page.pushOperators(pushGraphicsState(), rectangle(bx, by, bw, bh), clip(), endPath());
            page.drawImage(img, { x: bx + (bw - dw) / 2, y: by + (bh - dh) / 2, width: dw, height: dh, opacity: design.photo.opacity });
            page.pushOperators(popGraphicsState());
        }
    }
    const layer = await doc.embedPng(words.png);
    page.drawImage(layer, { x: 0, y: 0, width: pageW, height: pageH });
    if (bleed > 0) {
        const b = bleed * k;
        page.setBleedBox(0, 0, pageW, pageH);
        page.setTrimBox(b, b, pageW - b * 2, pageH - b * 2);
    }
    return Buffer.from(await doc.save());
}

export async function renderDesignPdfs(opts: { design: Design; photo: FlyerPhoto | null; title: string; bleedMm: number }): Promise<{ home: Buffer; printShop: Buffer }> {
    return { home: await onePdf({ ...opts, bleedMm: 0 }), printShop: await onePdf(opts) };
}

/** The preview: a flyer at PREVIEW_DPI, a picture at its own size (capped, so a save stays quick). */
export async function renderDesignPreview(design: Design, photo: FlyerPhoto | null): Promise<DesignRender> {
    const { width, height } = designPixels(design, PREVIEW_DPI, 1600);
    return renderDesign({ design, photo, width, height });
}

export function designPixels(design: Design, dpi: number, maxImageWidth: number): { width: number; height: number } {
    if (design.kind === 'flyer') {
        const spec = PAPER_SPECS[(design.paperSize as PaperSize) ?? 'A5'] ?? PAPER_SPECS.A5;
        return { width: Math.round(spec.widthMm * dpi / 25.4), height: Math.round(spec.heightMm * dpi / 25.4) };
    }
    const scale = Math.min(1, maxImageWidth / design.pageW);
    return { width: Math.round(design.pageW * scale), height: Math.round(design.pageH * scale) };
}

// ── A first design ──────────────────────────────────────────────────────────────────────────────

/** A picture as a design: the picture filling the page, nothing on it yet. */
export function imageDesign(ref: DesignPhotoRef, width: number, height: number, pageColor: string): Design {
    return { v: 1, kind: 'image', pageW: width, pageH: height, paperSize: null, pageColor, photo: { x: 0, y: 0, w: 1, h: 1, opacity: 1, ref }, layers: [] };
}

/**
 * A flyer page as a design: the words and sizes the renderer chose, each now its own layer. Throws FlyerFitError when
 * the words do not fit, as drawing the page would.
 */
export async function flyerDesign(args: {
    content: FlyerContent; kit: BrandKit; paperSize: PaperSize; layout: FlyerLayout; photo: DesignPhotoRef | null;
    orgName?: string | null; style?: FlyerPageStyle | null;
}): Promise<Design> {
    const { content, kit, paperSize, layout } = args;
    const style = args.style ?? olderPageStyle(layout, kit);
    const g = flyerGeometry(layout, paperSize, PREVIEW_DPI, 0);
    const W = g.canvasWidth;
    const H = g.canvasHeight;
    const mm = (n: number) => Math.round(n * g.pxPerMm);
    const pt = (n: number) => n * g.dpi / 72;
    const box = g.text;
    const gap = mm(3.5 * g.scale);
    const layers: DesignLayer[] = [];

    if (style.decor) {
        const big = Math.round(W * 0.8);
        const small = Math.round(W * 0.5);
        layers.push({ id: 'circle1', kind: 'shape', role: 'circle', x: (W - big * 0.6) / W, y: (-big * 0.4) / H, w: big / W, h: big / H, color: style.decor, round: true, opacity: 1 });
        layers.push({ id: 'circle2', kind: 'shape', role: 'circle', x: (-small * 0.45) / W, y: (H - small * 0.6) / H, w: small / W, h: small / H, color: style.decor, round: true, opacity: 1 });
    }
    const words = (id: string, text: string, x: number, y: number, w: number, sizePx: number, over: Partial<TextLayer> = {}): TextLayer => ({
        id, kind: 'text', role: id, text, x: x / W, y: y / H, w: w / W, fontFamily: kit.fontFamily, fontSizePct: sizePx / H, bold: false, align: 'left', color: style.ink, boxFill: null, boxOpacity: 1, ...over,
    });

    // ── The footer first: it sets the room the words have. ──
    const qrSize = content.qr ? mm(Math.max(22, PAPER_SPECS[paperSize].widthMm * 0.17)) : 0;
    const contactLines = [content.qr?.label, content.contact.phone, content.contact.email, content.contact.website, content.contact.address].filter((l): l is string => !!l);
    const contactSize = pt(Math.max(7, 9 * g.scale));
    const footerH = Math.ceil(Math.max(qrSize, contactLines.length * contactSize * LINE_HEIGHT));
    const bottom = box.top + box.height;
    if (contactLines.length) {
        const h = contactLines.length * contactSize * LINE_HEIGHT;
        layers.push(words('contact', contactLines.join('\n'), box.left, bottom - h, box.width - (qrSize ? qrSize + gap : 0), contactSize));
    }
    if (content.qr) {
        const src = await QRCode.toDataURL(content.qr.url, { errorCorrectionLevel: 'M', margin: 4, width: 400, color: { dark: '#000000', light: '#ffffff' } });
        layers.push({ id: 'qr', kind: 'qr', role: 'qr', x: (box.left + box.width - qrSize) / W, y: (bottom - qrSize) / H, w: qrSize / W, h: qrSize / H, src });
    }

    // ── The wordmark or logo at the top. ──
    const mark = (kit.wordmark || args.orgName || '').trim().toUpperCase().slice(0, 32);
    const markSize = pt(Math.max(8, 10 * g.scale));
    const logoH = mm(9 * g.scale);
    const markH = kit.logoUrl ? logoH : mark ? Math.round(markSize * 1.3) : 0;
    if (kit.logoUrl) layers.push({ id: 'logo', kind: 'logo', role: 'logo', x: box.left / W, y: box.top / H, w: Math.min(box.width, logoH * 4) / W, h: logoH / H, src: kit.logoUrl });
    else if (mark) layers.push(words('wordmark', mark, box.left, box.top, box.width, markSize, { bold: true, color: style.accent }));

    // ── The words, stacked as the round's page stacks them. ──
    const top = box.top + (markH ? markH + gap : 0);
    const available = box.height - (markH ? markH + gap : 0) - (footerH ? footerH + gap : 0);
    const blocks = fitBlocks(blockSpecs(content, layout), box.width, available, g, gap, paperSize);
    const total = blocks.reduce((n, b) => n + b.height, 0) + gap * Math.max(0, blocks.length - 1);
    let y = layout === 'photo_top' || layout === 'photo_framed' ? top : top + Math.max(0, (available - total) / 2);
    for (const { spec, sizePx, height } of blocks) {
        const texts = spec.field === 'points' ? spec.texts.map((t) => `•  ${t}`).join('\n') : spec.texts[0];
        const over: Partial<TextLayer> = spec.field === 'headline' || spec.field === 'callToAction' ? { bold: true, color: style.headline }
            : spec.field === 'dateLine' ? { bold: true, color: style.accent }
                : spec.field === 'offer' ? { bold: true, color: style.offerInk, boxFill: style.offerBg, boxOpacity: 1 } : {};
        layers.push(words(spec.field, texts, box.left, y, box.width, sizePx, over));
        y += height + gap;
    }

    const photo = args.photo && g.photo
        ? { x: g.photo.left / W, y: g.photo.top / H, w: g.photo.width / W, h: g.photo.height / H, opacity: 1, ref: args.photo }
        : null;
    // The old full-page layout had a panel behind the words: as a design, that is the page's colour on each text box.
    if (layout === 'photo_full') {
        for (const l of layers) if (l.kind === 'text' && !l.boxFill) { l.boxFill = style.field; l.boxOpacity = 0.9; }
    }
    return { v: 1, kind: 'flyer', pageW: PAPER_SPECS[paperSize].widthMm, pageH: PAPER_SPECS[paperSize].heightMm, paperSize, pageColor: style.field, photo, layers };
}

export { flyerPageStyle };
