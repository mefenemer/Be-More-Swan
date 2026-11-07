// src/lib/render-libs.ts
//
// The picture and print libraries (satori, the native resvg renderer, pdf-lib, qrcode and the
// ~170KB of embedded brand-card fonts), loaded on the FIRST render instead of at cold start.
//
// Why (measured 2026-11-06): brand-card.ts, design-render.ts, flyer.ts and bake-words.ts imported
// these at the top, and visual-briefs.ts imports those, so every function that touches briefs
// loaded them on every cold start, including chat-orchestrator (12.4 MB bundle) and brand-briefs
// (8.4 MB). On staging a cold chat-orchestrator took 3–3.9 s to answer even a 405, and a cold
// brand-briefs 2.9 s, against ~200 ms warm. Most of those calls never draw a picture.
//
// esbuild keeps a module that is only reached through import() behind a lazy initialiser, so it
// costs nothing until a render asks for it. ⚠️ That only holds while NOTHING imports these packages
// (or brand-card-fonts) statically: one top-level import anywhere in a bundle puts the cold-start
// cost back. Import BRAND_CARD_FONT_FAMILY from here, not from brand-card-fonts.

import type { Resvg as ResvgClass } from '@resvg/resvg-js';

/** The bundled fallback family's name: a plain string, so it needs no font data loaded. */
export const BRAND_CARD_FONT_FAMILY = 'Plus Jakarta Sans';

type Satori = typeof import('satori').default;
type BrandFonts = typeof import('./brand-card-fonts').brandCardFonts;

export interface RasterLibs {
    satori: Satori;
    Resvg: typeof ResvgClass;
    brandCardFonts: BrandFonts;
}

// CommonJS packages arrive on `default` or as named exports depending on the bundler; accept both.
const pick = <T>(m: unknown, name: string): T => {
    const mod = m as Record<string, unknown> & { default?: Record<string, unknown> };
    return (mod[name] ?? mod.default?.[name]) as T;
};

let raster: Promise<RasterLibs> | null = null;
/** satori + resvg + the bundled fonts: everything a PNG render needs. Loaded once per instance. */
export function rasterLibs(): Promise<RasterLibs> {
    raster ??= Promise.all([import('satori'), import('@resvg/resvg-js'), import('./brand-card-fonts')])
        .then(([s, r, f]) => ({
            satori: ((s as { default?: Satori }).default ?? (s as unknown as Satori)),
            Resvg: pick<typeof ResvgClass>(r, 'Resvg'),
            brandCardFonts: f.brandCardFonts,
        }))
        .catch((err) => { raster = null; throw err; });
    return raster;
}

type PdfLib = typeof import('pdf-lib');
let pdf: Promise<PdfLib> | null = null;
/** pdf-lib, for the print PDFs. */
export function pdfLib(): Promise<PdfLib> {
    pdf ??= import('pdf-lib')
        .then((m) => ((m as { PDFDocument?: unknown }).PDFDocument ? m : (m as unknown as { default: PdfLib }).default) as PdfLib)
        .catch((err) => { pdf = null; throw err; });
    return pdf;
}

type QrToDataUrl = (text: string, opts?: Record<string, unknown>) => Promise<string>;
/** qrcode's toDataURL, for the QR on a flyer. */
export async function qrToDataURL(text: string, opts?: Record<string, unknown>): Promise<string> {
    const m = await import('qrcode');
    const toDataURL = pick<QrToDataUrl>(m, 'toDataURL');
    return toDataURL(text, opts);
}
