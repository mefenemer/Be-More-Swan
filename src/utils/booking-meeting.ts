// src/utils/booking-meeting.ts — WHERE a booking happens: in person, a phone call, or a video call
// with the owner's own reusable link (docs/booking-calendly-gaps-plan.md, B step 1).
// db/z-booking-meeting-links.sql. tests/booking-meeting.test.ts.
//
// The location is per service (org_products.meeting_location; NULL = in person). The video link is
// pasted by the owner — a Zoom personal room, a fixed Google Meet or Teams link — for the business
// (booking_settings.meeting_url) or one person (bookable_resources.meeting_url, which wins). Both are
// COPIED onto the booking when it is made, so every email, invite and calendar event reads the
// booking alone. The customer is given the link only once the booking is confirmed: a request that
// is declined never had it.
//
// When the owner changes a link, refreshMeetingLinks puts the new one on upcoming video bookings.
// (B step 2 — a Teams meeting made per booking — will need a source column so that refresh leaves
// generated links alone.)

import { sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { esc } from './site-render';

type Db = ReturnType<typeof getDb>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const MEETING_LOCATIONS = ['in_person', 'phone', 'video'] as const;
export type MeetingLocation = typeof MEETING_LOCATIONS[number];
export const MEETING_LOCATION_LABEL: Record<MeetingLocation, string> = { in_person: 'In person', phone: 'Phone call', video: 'Video call' };
export const MEETING_URL_MAX = 500;

/** A service's location from a save: '' / null / undefined = in person (stored as NULL). */
export function cleanMeetingLocation(raw: unknown): Result<MeetingLocation | null> {
    if (raw === null || raw === undefined || raw === '' || raw === 'in_person') return { ok: true, value: null };
    if (raw === 'phone' || raw === 'video') return { ok: true, value: raw };
    return { ok: false, error: 'Choose in person, a phone call or a video call.' };
}

/** What a stored value means (NULL and anything unknown = in person). */
export const meetingLocationOf = (v: unknown): MeetingLocation => (v === 'phone' || v === 'video' ? v : 'in_person');

/**
 * A pasted meeting link: https only, a real host, no user name or password in it, at most 500
 * characters. '' / null = no link. Returned as the URL parser writes it.
 */
export function cleanMeetingUrl(raw: unknown): Result<string | null> {
    const s = typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? '' : null;
    if (s === null) return { ok: false, error: 'The meeting link should be a web address.' };
    if (!s) return { ok: true, value: null };
    const bad: Result<string | null> = { ok: false, error: 'The meeting link should start with https:// — copy it from Zoom, Google Meet or Teams.' };
    if (s.length > MEETING_URL_MAX || /\s/.test(s)) return bad;
    let u: URL;
    try { u = new URL(s); } catch { return bad; }
    if (u.protocol !== 'https:' || u.username || u.password) return bad;
    const host = u.hostname.toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || host.endsWith('.local') || host === 'localhost') return bad;
    const out = u.toString();
    return out.length <= MEETING_URL_MAX ? { ok: true, value: out } : bad;
}

/** Where a new booking happens and its link: the service's location; for video, the person's link, else the business's. */
export function meetingForNewBooking(
    service: { meetingLocation?: string | null } | null | undefined,
    resource: { meetingUrl?: string | null } | null | undefined,
    settings: { meetingUrl?: string | null },
): { meetingLocation: MeetingLocation | null; meetingUrl: string | null } {
    const loc = service ? meetingLocationOf(service.meetingLocation) : 'in_person';
    if (loc === 'in_person') return { meetingLocation: service ? 'in_person' : null, meetingUrl: null };
    if (loc === 'phone') return { meetingLocation: 'phone', meetingUrl: null };
    return { meetingLocation: 'video', meetingUrl: resource?.meetingUrl || settings.meetingUrl || null };
}

type MeetingBooking = { status: string; meetingLocation: string | null; meetingUrl: string | null; customerPhone: string | null };

/** For the customer's emails and their manage page. '' for in person. HTML. */
export function customerMeetingHtml(b: MeetingBooking, business: string): string {
    const loc = meetingLocationOf(b.meetingLocation);
    if (loc === 'phone') return `<p>It's a phone call: ${esc(business)} will call you${b.customerPhone ? ` on ${esc(b.customerPhone)}` : ''}.</p>`;
    if (loc !== 'video') return '';
    if (b.status !== 'confirmed') return '<p>It\'s a video call — you\'ll get the link to join once it\'s confirmed.</p>';
    return b.meetingUrl
        // A Zoom link with its password is one long word: let it wrap, or it pushes a phone's page sideways.
        ? `<p style="overflow-wrap:anywhere;word-break:break-word">It's a video call. <strong><a href="${esc(b.meetingUrl)}">Join the call</a></strong> at the time — ${esc(b.meetingUrl)}</p>`
        : `<p>It's a video call — ${esc(business)} will send you the link to join.</p>`;
}

/** One line for the owner (their email, calendar events, the Bookings tab). '' for in person. Plain text. */
export function ownerMeetingLine(b: MeetingBooking): string {
    const loc = meetingLocationOf(b.meetingLocation);
    if (loc === 'phone') return b.customerPhone ? `Phone call — call them on ${b.customerPhone}` : 'Phone call — they left no number; reply to their email';
    if (loc !== 'video') return '';
    return b.meetingUrl ? `Video call: ${b.meetingUrl}` : 'Video call — no link yet: add one in Business Information ▸ Bookings';
}

/** For the customer's calendar invite: LOCATION and URL lines (already escaped by the caller's rules). */
export function icsMeeting(b: MeetingBooking): { location: string | null; url: string | null } {
    const loc = meetingLocationOf(b.meetingLocation);
    if (loc === 'phone') return { location: 'Phone call', url: null };
    if (loc === 'video' && b.status === 'confirmed' && b.meetingUrl) return { location: b.meetingUrl, url: b.meetingUrl };
    if (loc === 'video') return { location: 'Video call', url: null };
    return { location: null, url: null };
}

/**
 * Put the current link on every upcoming video booking that would get a different one if made now
 * (the person's link, else the business's). Run after the owner changes either. Returns how many
 * bookings changed. Tenant-scoped.
 */
export async function refreshMeetingLinks(db: Db, orgId: number, now: Date): Promise<number> {
    const res = await db.execute(sql`
        UPDATE bookings b SET meeting_url = want.url
        FROM (
            SELECT bk.id, COALESCE(r.meeting_url, s.meeting_url) AS url
            FROM bookings bk
            LEFT JOIN bookable_resources r ON r.id = bk.resource_id AND r.organisation_id = bk.organisation_id
            LEFT JOIN booking_settings s ON s.organisation_id = bk.organisation_id
            WHERE bk.organisation_id = ${orgId} AND bk.meeting_location = 'video'
              AND bk.status IN ('pending', 'confirmed', 'awaiting_payment') AND bk.starts_at > ${now.toISOString()}
        ) want
        WHERE b.id = want.id AND b.organisation_id = ${orgId} AND b.meeting_url IS DISTINCT FROM want.url
        RETURNING b.id`);
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
    return rows.length;
}
