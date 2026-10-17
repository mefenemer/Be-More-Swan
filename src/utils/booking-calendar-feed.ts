// src/utils/booking-calendar-feed.ts — the owner's bookings as a calendar they subscribe to
// (docs/booking-plan.md phase 3). Served by netlify/functions/booking-calendar-feed.ts at
// /api/bookings/calendar.ics?t=<token>. tests/calendar-sync.test.ts.
//
// PRIVATE: it carries customers' names, emails and phone numbers, for the owner's own diary. The
// token (booking_settings.calendar_feed_token, 32 hex) is the only key; resetting it retires every
// copy of the old link. Google refreshes a subscribed calendar every few hours (up to a day),
// Apple and Outlook more often — the emails stay the instant notice.

import { randomBytes } from 'crypto';
import { formatPounds } from './product-price';

export const newFeedToken = () => randomBytes(16).toString('hex');
export const FEED_TOKEN_RE = /^[0-9a-f]{32}$/;
export const feedUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/+$/, '')}/api/bookings/calendar.ics?t=${token}`;
/** webcal:// makes Apple Calendar and Outlook offer to subscribe in one click. */
export const webcalUrl = (httpsUrl: string) => httpsUrl.replace(/^https?:\/\//, 'webcal://');

const text = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** RFC 5545 line folding: no line longer than 75 octets; continuations start with a space. */
export function fold(line: string): string {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length <= 75) return line;
    const parts: string[] = [];
    let start = 0;
    let limit = 75;
    while (start < bytes.length) {
        let end = Math.min(start + limit, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;   // never split a UTF-8 character
        parts.push(bytes.subarray(start, end).toString('utf8'));
        start = end;
        limit = 74;
    }
    return parts.join('\r\n ');
}

export interface FeedBooking {
    id: number; kind: string; status: string; startsAt: Date; endsAt: Date; what: string;
    customerName: string; customerEmail: string; customerPhone: string | null; notes: string | null; partySize: number;
    depositPence: number | null; paymentStatus: string | null;
}
export interface FeedSession { id: number; title: string; status: string; startsAt: Date; endsAt: Date; resourceName: string | null; capacity: number; taken: number; people: string[]; }

/** The whole calendar. Class places appear once, as their session; other bookings one by one. */
export function buildOwnerFeed(p: { business: string; bookings: FeedBooking[]; sessions: FeedSession[]; now: Date }): string {
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Be More Swan//Bookings feed//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        `X-WR-CALNAME:${text(`${p.business} — bookings`)}`, 'X-WR-CALDESC:Bookings from your website (Be More Swan). Private — don\'t share this link.',
        'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M',
    ];
    const event = (uid: string, start: Date, end: Date, summary: string, description: string, status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED') => {
        lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(p.now)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
            `SUMMARY:${text(summary)}`, `DESCRIPTION:${text(description)}`, `STATUS:${status}`, 'TRANSP:OPAQUE', 'END:VEVENT');
    };
    for (const b of p.bookings) {
        if (b.kind === 'class' || b.status === 'awaiting_payment' || b.status === 'declined') continue;
        const pending = b.status === 'pending';
        const money = b.depositPence ? `${formatPounds(b.depositPence)} deposit ${b.paymentStatus === 'paid' ? 'paid' : b.paymentStatus === 'refunded' ? 'refunded' : b.paymentStatus ?? ''}`.trim() : '';
        event(`owner-booking-${b.id}@bemoreswan.com`, b.startsAt, b.endsAt,
            `${b.status === 'cancelled' ? 'Cancelled: ' : ''}${b.what} — ${b.customerName}${pending ? ' (to confirm)' : ''}`,
            [b.customerName, b.customerEmail, b.customerPhone, b.kind === 'table' ? `Party of ${b.partySize}` : '', money, b.notes ? `Notes: ${b.notes}` : '',
                pending ? 'Confirm or decline it on the Bookings tab.' : ''].filter(Boolean).join('\n'),
            b.status === 'cancelled' ? 'CANCELLED' : pending ? 'TENTATIVE' : 'CONFIRMED');
    }
    for (const s of p.sessions) {
        event(`owner-session-${s.id}@bemoreswan.com`, s.startsAt, s.endsAt,
            `${s.status === 'cancelled' ? 'Cancelled: ' : ''}${s.title}${s.resourceName ? ` with ${s.resourceName}` : ''} — ${s.taken}/${s.capacity} booked`,
            s.people.length ? `Booked: ${s.people.join(', ')}` : 'Nobody booked yet.',
            s.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED');
    }
    lines.push('END:VCALENDAR');
    return `${lines.map(fold).join('\r\n')}\r\n`;
}
