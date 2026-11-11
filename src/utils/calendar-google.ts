// src/utils/calendar-google.ts — the owner's Google calendar, signed in (docs/booking-calendly-gaps-plan.md C).
// The twin of calendar-microsoft.ts: the same events (eventForBooking / eventForSession), the same
// reconcile plan, the same calendar_events table (provider 'google'). tests/calendar-google.test.ts.
//
// Workspace integration 'google_calendar' on its OWN Google Cloud project (owner, 2026-11-08 — kept
// apart from YouTube and Gmail so a calendar review can't touch them): GOOGLE_CALENDAR_CLIENT_ID /
// _SECRET. Offered only where those are set. Scopes (GOOGLE_CALENDAR_SCOPE) — ⚠️ the Google console
// must list EXACTLY these, or verification fails (memory: google-oauth-verification-submission):
//   openid, email                                   — the account's address for the card (non-sensitive)
//   https://www.googleapis.com/auth/calendar.events — read event times, write our events, make Meet links (sensitive, no CASA)
//
//   IN  — busy times: events.list on the primary calendar, start/end/transparency/status only
//         (fields= keeps titles and guests out) → calendar_busy for the business, replacing the iCal
//         address (booking_settings.busy_source = 'google'). Free ("transparent"), cancelled and OUR
//         events (extendedProperties.private.bms) are skipped.
//   OUT — bookings and class dates become events, created / changed / deleted only where they differ,
//         within moments of a change (reconcileGoogleSoon) and every 15 minutes.
//   MEET — a video booking can get its own Google Meet (booking-meeting.ts ensureMeetingLink).
//
// Never throws to a caller on the booking path: a calendar problem must not fail a booking.

import { and, eq, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookingSettings, calendarBusy, calendarEvents, workspaceIntegrations } from '../../db/schema';
import { getFreshAccessToken, IntegrationError } from './workspace-integrations';
import { settingsFromRow } from './booking-settings';
import { setBusyCalendar } from './calendar-sync';
import { eventForBooking, MS_LIMITS, planReconcile, wantedFor, wantedHash, type WantedEvent } from './calendar-microsoft';
import type { OnlineMeetingResult } from './booking-meeting';
import type { BookingRow } from './bookings';

type Db = ReturnType<typeof getDb>;
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary';
export const GOOGLE_LIMITS = { writesPerRun: 60, pages: 10 } as const;

/** Sent identically on authorize, exchange and refresh. ⚠️ Must match the Google console exactly. */
export const GOOGLE_CALENDAR_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events';

/** Whether this deployment can offer the Google sign-in at all (its own Google Cloud project's keys). */
export const googleCalendarAvailable = (env: Record<string, string | undefined> = process.env) => !!env.GOOGLE_CALENDAR_CLIENT_ID && !!env.GOOGLE_CALENDAR_CLIENT_SECRET;

export async function googleConnected(db: Db, orgId: number): Promise<{ connected: boolean; account: string | null; status: string | null }> {
    const [row] = await db.select({ status: workspaceIntegrations.status, account: workspaceIntegrations.externalAccountName })
        .from(workspaceIntegrations).where(and(eq(workspaceIntegrations.organisationId, orgId), eq(workspaceIntegrations.provider, 'google_calendar'))).limit(1);
    return { connected: row?.status === 'active', account: row?.account ?? null, status: row?.status ?? null };
}

async function gapi(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(10_000) });
        if (res.status !== 429 && res.status !== 503) return res;
        await new Promise((r) => setTimeout(r, (attempt + 1) * 1000));
    }
    return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

// ── Busy times (pure parts testable) ──────────────────────────────────────────────────────────

export interface GoogleEventLite {
    start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
    status?: string; transparency?: string; extendedProperties?: { private?: Record<string, string> };
}

/** The busy ones as start/end. All-day events count only when marked busy (Google's default for them is free). Pure. */
export function busyFromGoogle(events: GoogleEventLite[]): Array<{ start: Date; end: Date }> {
    const out: Array<{ start: Date; end: Date }> = [];
    for (const e of events) {
        if (e.status === 'cancelled' || e.transparency === 'transparent' || e.extendedProperties?.private?.bms) continue;
        const s = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
        const f = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
        if (!s || !f) continue;
        const start = new Date(s);
        const end = new Date(f);
        if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && end > start) out.push({ start, end });
    }
    return out;
}

/** The Google event for one of our wanted events. Pure. */
export function googleEventJson(w: WantedEvent, orgId: number) {
    return {
        summary: w.subject, description: w.body,
        start: { dateTime: w.start.toISOString() }, end: { dateTime: w.end.toISOString() },
        status: w.tentative ? 'tentative' : 'confirmed', transparency: 'opaque',
        reminders: { useDefault: false },
        extendedProperties: { private: { bms: `${orgId}-${w.key}` } },
        // A Google Meet of its own (booking-meeting.ts): asked for once; Google keeps it on later changes.
        ...(w.online ? { conferenceData: { createRequest: { requestId: `bms-${orgId}-${w.key}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
    };
}

/** The Meet link Google gave an event, if it has finished making it. Pure. */
export function meetLinkOf(ev: { hangoutLink?: string | null; conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> } } | null | undefined): string | null {
    const uri = ev?.hangoutLink || ev?.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || null;
    return uri && /^https:\/\/meet\.google\.com\//.test(uri) ? uri : null;
}

/** For a Google calendar a video booking with meeting_source 'meet' carries a Meet (not a Teams meeting). */
function forGoogle(w: WantedEvent, online: boolean): WantedEvent {
    const teamsLine = 'Video call: the Teams meeting in this event';
    return { ...w, online, body: w.body.replace(teamsLine, online ? 'Video call: the Google Meet in this event' : 'Video call: a Teams meeting (in your Outlook calendar)') };
}

async function wantedForGoogle(db: Db, orgId: number, now: Date): Promise<WantedEvent[]> {
    const wanted = await wantedFor(db, orgId, now);
    // eventForBooking marks Teams meetings online; on Google the online ones are those given a Meet.
    const { bookings } = await import('../../db/schema');
    const { inArray } = await import('drizzle-orm');
    const ids = wanted.filter((w) => w.key.startsWith('b:')).map((w) => Number(w.key.slice(2)));
    const meet = ids.length ? new Set((await db.select({ id: bookings.id }).from(bookings)
        .where(and(eq(bookings.organisationId, orgId), inArray(bookings.id, ids), eq(bookings.meetingSource, 'meet')))).map((r) => `b:${r.id}`)) : new Set<string>();
    return wanted.map((w) => forGoogle({ ...w, online: undefined }, meet.has(w.key)));
}

// ── Out: their calendar in line with bookings ───────────────────────────────────────────────────

export async function reconcileGoogleOut(db: Db, orgId: number, token: string, now: Date): Promise<number> {
    const wanted = await wantedForGoogle(db, orgId, now);
    const have = await db.select().from(calendarEvents).where(and(eq(calendarEvents.organisationId, orgId), eq(calendarEvents.provider, 'google')));
    const plan = planReconcile(wanted, have.map((h) => ({ ...h, endsAt: new Date(h.endsAt) })), now);
    let writes = 0;
    const budget = () => writes < GOOGLE_LIMITS.writesPerRun;
    for (const w of plan.create) {
        if (!budget()) break;
        const res = await gapi(token, '/events?conferenceDataVersion=1', { method: 'POST', body: JSON.stringify(googleEventJson(w, orgId)) });
        writes++;
        if (!res.ok) { console.error('[calendar-google] create failed', { orgId, status: res.status }); continue; }
        const ev = await res.json() as { id: string };
        await db.insert(calendarEvents).values({ organisationId: orgId, provider: 'google', itemKey: w.key, externalId: ev.id, contentHash: wantedHash(w), endsAt: w.end })
            .onConflictDoUpdate({ target: [calendarEvents.organisationId, calendarEvents.provider, calendarEvents.itemKey], set: { externalId: ev.id, contentHash: wantedHash(w), endsAt: w.end, updatedAt: new Date() } });
    }
    for (const w of plan.update) {
        if (!budget()) break;
        const h = have.find((x) => x.itemKey === w.key)!;
        const res = await gapi(token, `/events/${encodeURIComponent(h.externalId)}?conferenceDataVersion=1`, { method: 'PATCH', body: JSON.stringify(googleEventJson(w, orgId)) });
        writes++;
        if (res.status === 404 || res.status === 410) { await db.delete(calendarEvents).where(eq(calendarEvents.id, h.id)); continue; }
        if (!res.ok) { console.error('[calendar-google] update failed', { orgId, status: res.status }); continue; }
        await db.update(calendarEvents).set({ contentHash: wantedHash(w), endsAt: w.end, updatedAt: new Date() }).where(eq(calendarEvents.id, h.id));
    }
    for (const h of plan.remove) {
        if (!budget()) break;
        const res = await gapi(token, `/events/${encodeURIComponent(h.externalId)}`, { method: 'DELETE' });
        writes++;
        if (res.ok || res.status === 404 || res.status === 410) await db.delete(calendarEvents).where(and(eq(calendarEvents.provider, 'google'), eq(calendarEvents.externalId, h.externalId)));
        else console.error('[calendar-google] delete failed', { orgId, status: res.status });
    }
    for (const f of plan.forget) await db.delete(calendarEvents).where(and(eq(calendarEvents.organisationId, orgId), eq(calendarEvents.provider, 'google'), eq(calendarEvents.itemKey, f.itemKey)));
    return writes;
}

// ── In: busy times ────────────────────────────────────────────────────────────────────────────

export async function readGoogleBusyIn(db: Db, orgId: number, token: string, now: Date): Promise<number> {
    const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
    const st = settingsFromRow(row as Record<string, unknown> | undefined);
    const timeMin = new Date(now.getTime() - 86_400_000).toISOString();
    const timeMax = new Date(now.getTime() + Math.min(MS_LIMITS.horizonCapDays, st.maxAdvanceDays + 2) * 86_400_000).toISOString();
    const fields = 'nextPageToken,items(start,end,status,transparency,extendedProperties/private)';
    const events: GoogleEventLite[] = [];
    let pageToken: string | null = null;
    for (let page = 0; page < GOOGLE_LIMITS.pages; page++) {
        const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', maxResults: '250', fields, ...(pageToken ? { pageToken } : {}) });
        const res = await gapi(token, `/events?${q.toString()}`);
        if (!res.ok) throw new IntegrationError('provider_error', `Google Calendar answered ${res.status}.`, 502);
        const data = await res.json() as { items?: GoogleEventLite[]; nextPageToken?: string };
        events.push(...(data.items ?? []));
        pageToken = data.nextPageToken ?? null;
        if (!pageToken) break;
    }
    const busy = busyFromGoogle(events);
    await db.transaction(async (tx) => {
        await tx.delete(calendarBusy).where(and(eq(calendarBusy.organisationId, orgId), isNull(calendarBusy.resourceId)));
        for (let i = 0; i < busy.length; i += 500) await tx.insert(calendarBusy).values(busy.slice(i, i + 500).map((b) => ({ organisationId: orgId, resourceId: null, startsAt: b.start, endsAt: b.end })));
    });
    return busy.length;
}

/** Both directions for one workspace. Records the outcome on booking_settings. Never throws. */
export async function syncGoogle(db: Db, orgId: number, now: Date): Promise<boolean> {
    try {
        const { accessToken } = await getFreshAccessToken(db, orgId, 'google_calendar');
        const [row] = await db.select({ host: bookingSettings.busyCalendarHost, source: bookingSettings.busySource }).from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
        if (row?.host && row.source !== 'google') await setBusyCalendar(db, orgId, { resourceId: null }, null);
        const count = await readGoogleBusyIn(db, orgId, accessToken, now);
        await reconcileGoogleOut(db, orgId, accessToken, now);
        await db.insert(bookingSettings).values({ organisationId: orgId, busySource: 'google', busySyncedAt: now, busySyncError: null, busyCount: count })
            .onConflictDoUpdate({ target: bookingSettings.organisationId, set: { busySource: 'google', busySyncedAt: now, busySyncError: null, busyCount: count } });
        return true;
    } catch (err) {
        const msg = err instanceof IntegrationError && (err.code === 'not_connected' || err.code === 'refresh_failed')
            ? 'Your Google calendar needs connecting again — Google stopped accepting the sign-in.'
            : 'We couldn\'t reach your Google calendar just now. We\'ll try again shortly.';
        console.error('[calendar-google] sync failed', { orgId, code: err instanceof IntegrationError ? err.code : 'error', message: err instanceof Error ? err.message : String(err) });
        await db.update(bookingSettings).set({ busySyncedAt: now, busySyncError: msg }).where(eq(bookingSettings.organisationId, orgId)).catch(() => undefined);
        return false;
    }
}

/** After a booking changes: bring their Google calendar up to date now. Silent if not connected. */
export async function reconcileGoogleSoon(db: Db, orgId: number): Promise<void> {
    try {
        if (!(await googleConnected(db, orgId)).connected) return;
        const { accessToken } = await getFreshAccessToken(db, orgId, 'google_calendar');
        await Promise.race([reconcileGoogleOut(db, orgId, accessToken, new Date()), new Promise((r) => setTimeout(r, 6000))]);
    } catch (err) {
        console.error('[calendar-google] immediate update failed (the 15-minute sync will catch up)', err instanceof Error ? err.message : err);
    }
}

/** Every workspace with the Google calendar connected (for the 15-minute sync). */
export async function googleOrgs(db: Db): Promise<number[]> {
    const rows = await db.select({ orgId: workspaceIntegrations.organisationId }).from(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.provider, 'google_calendar'), eq(workspaceIntegrations.status, 'active'))).limit(500);
    return rows.map((r) => r.orgId);
}

/** Disconnected: its busy times stop counting (the events already written stay theirs). */
export async function forgetGoogle(db: Db, orgId: number): Promise<void> {
    await db.delete(calendarBusy).where(and(eq(calendarBusy.organisationId, orgId), isNull(calendarBusy.resourceId)));
    await db.delete(calendarEvents).where(and(eq(calendarEvents.organisationId, orgId), eq(calendarEvents.provider, 'google')));
    await db.update(bookingSettings).set({ busySource: null, busySyncedAt: null, busySyncError: null, busyCount: null }).where(eq(bookingSettings.organisationId, orgId));
}

// ── A Google Meet for one booking (booking-meeting.ts ensureMeetingLink) ──────────────────────────

export async function meetMeetingFor(db: Db, b: BookingRow): Promise<OnlineMeetingResult> {
    const { accessToken } = await getFreshAccessToken(db, b.organisationId, 'google_calendar');
    const [st] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, b.organisationId)).limit(1);
    const tz = settingsFromRow(st as Record<string, unknown> | undefined).timezone;
    const { describeBooking } = await import('./bookings');
    const w = forGoogle(eventForBooking({ ...b, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt), meetingSource: 'teams' }, describeBooking(b, tz).what), true);
    const [have] = await db.select().from(calendarEvents)
        .where(and(eq(calendarEvents.organisationId, b.organisationId), eq(calendarEvents.provider, 'google'), eq(calendarEvents.itemKey, w.key))).limit(1);
    type Ev = { id?: string; hangoutLink?: string | null; conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> } };
    let ev: Ev | null = null;
    const failed = (status: number): OnlineMeetingResult => ({ ok: false, error: `Google didn't make the Meet link (it answered ${status}), so your own video link was sent.` });
    if (have) {
        const res = await gapi(accessToken, `/events/${encodeURIComponent(have.externalId)}?conferenceDataVersion=1`, { method: 'PATCH', body: JSON.stringify(googleEventJson(w, b.organisationId)) });
        if (res.ok) ev = await res.json();
        else if (res.status === 404 || res.status === 410) await db.delete(calendarEvents).where(eq(calendarEvents.id, have.id));
        else return failed(res.status);
    }
    if (!ev) {
        const res = await gapi(accessToken, '/events?conferenceDataVersion=1', { method: 'POST', body: JSON.stringify(googleEventJson(w, b.organisationId)) });
        if (!res.ok) return failed(res.status);
        ev = await res.json();
    }
    if (!ev?.id) return { ok: false, error: 'Google didn\'t make the Meet link, so your own video link was sent.' };
    await db.insert(calendarEvents).values({ organisationId: b.organisationId, provider: 'google', itemKey: w.key, externalId: ev.id, contentHash: wantedHash(w), endsAt: w.end })
        .onConflictDoUpdate({ target: [calendarEvents.organisationId, calendarEvents.provider, calendarEvents.itemKey], set: { externalId: ev.id, contentHash: wantedHash(w), endsAt: w.end, updatedAt: new Date() } });
    let url = meetLinkOf(ev);
    // Google makes the Meet a moment after the event: look again once.
    for (let i = 0; !url && i < 2; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        const again = await gapi(accessToken, `/events/${encodeURIComponent(ev.id)}?fields=hangoutLink,conferenceData`);
        if (again.ok) url = meetLinkOf(await again.json() as Ev);
    }
    return url ? { ok: true, url } : { ok: false, error: 'Google didn\'t finish making the Meet link in time, so your own video link was sent.' };
}
