// src/lib/bake-words.ts
// Draw requested words onto an AI picture, server-side (owner, 2026-11-02: "picture first, words second").
//
// A post keeps its words as editable text layers (image-overlay-editor.js, baked in the browser on
// approve). A picture made from "Create with AI" in My Content, Blog Studio or the media picker has no
// post to hold layers, so the words the person asked for (planImage in image-prompt.ts) are drawn onto
// the chosen picture here instead — by satori + resvg, the same renderer as branded cards and flyers,
// so they are spelt exactly as typed. Box geometry copies the overlay editor's ratios, so a picture
// made here looks like one whose text layers were baked from the post editor.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { brandCardFonts, BRAND_CARD_FONT_FAMILY } from './brand-card-fonts';

// Same ratios as image-overlay-editor.js — keep them in step.
const PAD_RATIO = 0.30;
const LINE_HEIGHT = 1.25;
const RADIUS_RATIO = 0.15;

export interface WordLayer {
    text: string;
    x: number; y: number;
    fontSizePct: number;
    color?: string;
    boxFill?: string | null;
    boxOpacity?: number;
}

/** Pictures satori can embed. Anything else is saved without words rather than failing the save. */
export function canBakeOnto(mimeType: string | null | undefined): boolean {
    return /^image\/(jpe?g|png)$/i.test(String(mimeType ?? '').split(';')[0].trim());
}

function rgba(hex: string | null | undefined, alpha: number): string {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/** The picture with `layers` drawn on, as a PNG at the picture's own size. */
export async function bakeWordsOnImage(opts: {
    bytes: Buffer; mimeType: string; width: number; height: number; layers: WordLayer[];
}): Promise<Buffer> {
    const { width: W, height: H } = opts;
    const el = (style: Record<string, unknown>, children: unknown) => ({ type: 'div', props: { style, children } });
    const nodes: unknown[] = [{
        type: 'img',
        props: {
            src: `data:${opts.mimeType};base64,${opts.bytes.toString('base64')}`, width: W, height: H,
            style: { position: 'absolute', left: 0, top: 0, width: W, height: H, objectFit: 'cover' },
        },
    }];
    for (const l of opts.layers) {
        const fontSize = Math.round(Math.min(0.5, Math.max(0.005, l.fontSizePct)) * H);
        const pad = Math.round(fontSize * PAD_RATIO);
        const rows = String(l.text || '').split('\n');
        const boxH = Math.round(rows.length * fontSize * LINE_HEIGHT + pad * 2);
        const top = Math.round(Math.min(Math.max(l.y * H - boxH / 2, 0), Math.max(0, H - boxH)));
        // A full-width row with the box centred on x: satori has no translate(-50%), so centring is
        // done by the row. x other than 0.5 shifts the row, clamped to the picture.
        const shift = Math.round((Math.min(1, Math.max(0, l.x)) - 0.5) * W);
        nodes.push(el({ position: 'absolute', left: shift, top, width: W, height: boxH, display: 'flex', justifyContent: 'center' },
            el({
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                padding: pad, borderRadius: Math.round(fontSize * RADIUS_RATIO),
                backgroundColor: l.boxFill ? rgba(l.boxFill, l.boxOpacity ?? 1) : 'transparent',
                color: l.color || '#ffffff', fontSize, lineHeight: LINE_HEIGHT,
            }, rows.map((r) => el({ display: 'flex', whiteSpace: 'nowrap' }, r || ' ')))));
    }
    const svg = await satori(
        el({ display: 'flex', position: 'relative', width: '100%', height: '100%', fontFamily: BRAND_CARD_FONT_FAMILY }, nodes) as unknown as Parameters<typeof satori>[0],
        { width: W, height: H, fonts: brandCardFonts },
    );
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng());
}
