// src/utils/booking-links.ts — the link in a booking email that lets the customer cancel or move it.
// docs/booking-plan.md phase 2. tests/bookings.test.ts.
//
// https://<their site>/_book?manage=<bookingId>&t=<signature>. The signature is an HMAC of the booking
// id under the app's secret (the same pattern as newsletter-media-url.ts): unguessable, so the id
// space cannot be walked, and stable, so every email about one booking carries the same link. It is
// a capability like the email itself — whoever holds the email can manage that one booking, nothing else.

import { createHmac, timingSafeEqual } from 'crypto';
import { BOOK_PATH } from './site-render';

function secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not set — cannot sign booking links.');
    return s;
}

/** 20 hex characters: 80 bits. */
export function signBookingId(id: number, key = secret()): string {
    return createHmac('sha256', key).update(`booking-manage:${id}`).digest('hex').slice(0, 20);
}

export function verifyBookingToken(id: number, token: string, key?: string): boolean {
    let expected: Buffer;
    try { expected = Buffer.from(signBookingId(id, key ?? secret())); } catch { return false; }
    const given = Buffer.from(String(token || ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The manage link on the site the booking was made on. Null when links cannot be signed here. */
export function manageBookingUrl(siteOrigin: string, id: number): string | null {
    try { return `${siteOrigin.replace(/\/+$/, '')}${BOOK_PATH}?manage=${id}&t=${signBookingId(id)}`; } catch { return null; }
}
