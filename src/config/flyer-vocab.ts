// src/config/flyer-vocab.ts
// A printed flyer's words and paper — docs/brand-designer-flyers-plan.md §3.1. One normaliser, shared
// by the Briefs tab, the chat card and the word-drafting job, so a flyer means the same thing
// whichever door it came in by (the same rule as normaliseBrief in visual-brief-vocab.ts).
//
// Pure: no DB, no renderer. src/lib/flyer.ts draws what this returns.

export const PAPER_SIZES = ['A5', 'A4', 'A6', 'DL'] as const;
export type PaperSize = typeof PAPER_SIZES[number];

/** Trim size in millimetres (portrait) and what the form calls it. */
export const PAPER_SPECS: Record<PaperSize, { widthMm: number; heightMm: number; label: string }> = {
    A5: { widthMm: 148, heightMm: 210, label: 'A5 (148 × 210 mm) — the usual handout' },
    A4: { widthMm: 210, heightMm: 297, label: 'A4 (210 × 297 mm) — a poster or notice' },
    A6: { widthMm: 105, heightMm: 148, label: 'A6 (105 × 148 mm) — a postcard' },
    DL: { widthMm: 99, heightMm: 210, label: 'DL (99 × 210 mm) — a slim leaflet' },
};

export const DEFAULT_PAPER_SIZE: PaperSize = 'A5';

/** What a print shop asks for: 3 mm of picture past every trimmed edge. */
export const PRINT_BLEED_MM = 3;

export const FLYER_LAYOUTS = ['photo_top', 'photo_full', 'type_only'] as const;
export type FlyerLayout = typeof FLYER_LAYOUTS[number];

export const FLYER_LAYOUT_LABELS: Record<FlyerLayout, string> = {
    photo_top: 'Photo at the top',
    photo_full: 'Full-page photo',
    type_only: 'Words only',
};

/** Layouts that need a photo. A round with no photo still draws the rest. */
export const PHOTO_LAYOUTS: readonly FlyerLayout[] = ['photo_top', 'photo_full'];

/** Field limits — what the form enforces and the normaliser clips to. */
export const FLYER_LIMITS = {
    headline: 80,
    subheading: 160,
    point: 110,
    points: 3,
    offer: 100,
    callToAction: 80,
    dateLine: 80,
    phone: 40,
    email: 120,
    website: 120,
    address: 160,
    qrUrl: 500,
    qrLabel: 60,
} as const;

export interface FlyerContact { phone: string | null; email: string | null; website: string | null; address: string | null }

export interface FlyerContent {
    headline: string;
    subheading: string | null;
    /** At most FLYER_LIMITS.points — a flyer with six bullet points is a leaflet nobody reads. */
    points: string[];
    offer: string | null;
    callToAction: string | null;
    /** An event date or opening times, as the user wrote it. Never parsed. */
    dateLine: string | null;
    contact: FlyerContact;
    /** Where the QR code points, or null for no QR. Only http(s). */
    qr: { url: string; label: string | null } | null;
}

/** The fields the drafting model may write. Contact details and the QR never come from a model. */
export const MODEL_WRITTEN_FIELDS = ['headline', 'subheading', 'points', 'callToAction'] as const;

function text(v: unknown, max: number): string | null {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
}

/** An http(s) URL, or null. A bare host ("lovecat.co.uk") is given https://. Nothing else is guessed. */
export function cleanQrUrl(v: unknown): string | null {
    const raw = text(v, FLYER_LIMITS.qrUrl);
    if (!raw) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    try {
        const u = new URL(withScheme);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (!u.hostname.includes('.')) return null;
        return u.toString();
    } catch { return null; }
}

/**
 * Turn untrusted flyer words (a form, a chat card, the drafting model) into ones the renderer can
 * draw. Returns an error instead when there is nothing to draw — a flyer needs a headline.
 */
export function normaliseFlyerContent(raw: unknown): { ok: true; content: FlyerContent } | { ok: false; error: string } {
    const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const headline = text(r.headline, FLYER_LIMITS.headline);
    if (!headline) return { ok: false, error: 'A flyer needs a headline.' };
    const points = (Array.isArray(r.points) ? r.points : [])
        .map((p) => text(p, FLYER_LIMITS.point))
        .filter((p): p is string => !!p)
        .slice(0, FLYER_LIMITS.points);
    const c = r.contact && typeof r.contact === 'object' ? r.contact as Record<string, unknown> : {};
    const q = r.qr && typeof r.qr === 'object' ? r.qr as Record<string, unknown> : null;
    const qrUrl = q ? cleanQrUrl(q.url) : null;
    return {
        ok: true,
        content: {
            headline,
            subheading: text(r.subheading, FLYER_LIMITS.subheading),
            points,
            offer: text(r.offer, FLYER_LIMITS.offer),
            callToAction: text(r.callToAction, FLYER_LIMITS.callToAction),
            dateLine: text(r.dateLine, FLYER_LIMITS.dateLine),
            contact: {
                phone: text(c.phone, FLYER_LIMITS.phone),
                email: text(c.email, FLYER_LIMITS.email),
                website: text(c.website, FLYER_LIMITS.website),
                address: text(c.address, FLYER_LIMITS.address),
            },
            qr: qrUrl ? { url: qrUrl, label: text(q?.label, FLYER_LIMITS.qrLabel) } : null,
        },
    };
}

export function paperSizeOf(v: unknown): PaperSize | null {
    return (PAPER_SIZES as readonly string[]).includes(String(v)) ? v as PaperSize : null;
}

/** Everything the browser needs for the flyer form — sent with `list`, never hand-copied. */
export function flyerVocabForClient() {
    return {
        paperSizes: PAPER_SIZES.map((k) => ({ key: k, ...PAPER_SPECS[k] })),
        defaultPaperSize: DEFAULT_PAPER_SIZE,
        layouts: FLYER_LAYOUTS.map((k) => ({ key: k, label: FLYER_LAYOUT_LABELS[k] })),
        limits: FLYER_LIMITS,
    };
}
