// src/utils/qr-link.ts — a QR code for a link the USER chooses, starting from a suggestion (owner, 2026-11-11:
// "the assistant should default the suggested url but the user can change it"). Used by the Website
// Assistant's booking link card, the Brand Designer's flyers and design editor, and both chats.
// tests/qr-link.test.ts.
//
// The suggestion is read from what the business recorded, in this order — never made up:
//   1. the introductory offer's link (a free trial, a first-visit offer) — what a flyer is usually for;
//   2. the online booking link (site-booking-page.ts), when bookings are set up;
//   3. the website (Business Information, else the brand kit).
// Any link the user types instead is checked with the flyers' own rule (cleanQrUrl: http(s), a real host;
// a bare "yourshop.co.uk" gets https://) and drawn as black on white, which every phone camera reads.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { cleanQrUrl } from '../config/flyer-vocab';
import { loadIntroOffer } from './intro-offer';
import { normalizeBrandKit } from './brand-kit';

type Db = ReturnType<typeof getDb>;

export { cleanQrUrl };

export type QrSuggestionSource = 'offer' | 'booking' | 'website';
export interface QrSuggestion { url: string; source: QrSuggestionSource; label: string }

const SOURCE_LABEL: Record<QrSuggestionSource, string> = {
    offer: 'your introductory offer\'s link',
    booking: 'your booking link',
    website: 'your website',
};

/** The suggestion from the three recorded links, first one present wins. Pure. */
export function pickQrSuggestion(links: { offer?: string | null; booking?: string | null; website?: string | null }): QrSuggestion | null {
    for (const source of ['offer', 'booking', 'website'] as const) {
        const url = cleanQrUrl(links[source]);
        if (url) return { url, source, label: SOURCE_LABEL[source] };
    }
    return null;
}

/**
 * What a QR code should point at unless the user says otherwise. `prefer` puts one source first — the
 * Website Assistant's booking card prefers the booking link. Never throws: no suggestion is null.
 */
export async function suggestedQrLink(db: Db, orgId: number, prefer?: QrSuggestionSource): Promise<QrSuggestion | null> {
    try {
        const [intro, booking, [org]] = await Promise.all([
            loadIntroOffer(db, orgId).catch(() => null),
            import('./site-booking-page').then((m) => m.bookingLinkFor(db, orgId)).catch(() => null),
            db.select({ website: organisations.websiteUrl, kit: organisations.brandKit }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
        ]);
        const links = {
            offer: intro && intro.has ? intro.url ?? null : null,
            booking,
            website: org?.website || normalizeBrandKit(org?.kit).website || null,
        };
        if (prefer) {
            const first = pickQrSuggestion({ [prefer]: links[prefer] });
            if (first) return first;
        }
        return pickQrSuggestion(links);
    } catch (err) {
        console.error('[qr-link] no suggestion', err instanceof Error ? err.message : err);
        return null;
    }
}

const QR_OPTIONS = { errorCorrectionLevel: 'M' as const, margin: 2, color: { dark: '#000000', light: '#ffffff' } };

async function qrLib(): Promise<typeof import('qrcode')> {
    const m = await import('qrcode') as unknown as typeof import('qrcode') & { default?: typeof import('qrcode') };
    return typeof m.toString === 'function' ? m : m.default!;
}

/** The QR code as SVG (scales to any print size) and PNG (for Canva, Word, a print shop's form). Null for a bad link. */
export async function drawQr(rawUrl: unknown): Promise<{ url: string; svg: string; png: string } | null> {
    const url = cleanQrUrl(rawUrl);
    if (!url) return null;
    const qr = await qrLib();
    const [svg, png] = await Promise.all([
        qr.toString(url, { ...QR_OPTIONS, type: 'svg' }),
        qr.toDataURL(url, { ...QR_OPTIONS, width: 1000 }),
    ]);
    return { url, svg, png };
}
