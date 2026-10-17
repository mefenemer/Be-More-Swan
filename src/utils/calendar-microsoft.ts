// src/utils/calendar-microsoft.ts — the owner's Outlook / Microsoft 365 calendar, signed in
// (docs/booking-plan.md phase 3, the optional faster upgrade to the no-sign-in links).
// db/z-calendar-microsoft.sql. tests/calendar-microsoft.test.ts.
//
// The connection is a workspace integration, provider 'outlook_calendar' (Calendars.ReadWrite on the
// same Azure app as Outlook email). Two jobs, both against the signed-in owner's own calendar:
//
//   IN  — busy times: Graph calendarView (start/end/showAs only) → calendar_busy for the business,
//         replacing the private iCal address (booking_settings.busy_source = 'microsoft'). "free" and
//         "working elsewhere" are not busy; cancelled ones and OUR events (transactionId 'bms-…') skipped.
//   OUT — bookings and class dates become events in it. A reconciler compares what should be there
//         with calendar_events and creates / changes / deletes only the difference, so it is safe to
//         run any number of times: within moments of a change (reconcileSoon) and every 15 minutes.
//
// Never throws to a caller on the booking path: a calendar problem must not fail a booking.

import { createHash } from 'crypto';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookingSettings, bookings, calendarBusy, calendarEvents, classSessions, workspaceIntegrations } from '../../db/schema';
import { getFreshAccessToken, IntegrationError } from './workspace-integrations';
import { settingsFromRow } from './booking-settings';
import { setBusyCalendar } from './calendar-sync';
import { formatPounds } from './product-price';

type Db = ReturnType<typeof getDb>;
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const MS_LIMITS = { writesPerRun: 60, pages: 10, horizonCapDays: 120 } as const;

/** What counts as busy in Outlook's own terms. */
export const BUSY_SHOW_AS = new Set(['busy', 'tentative', 'oof']);

export async function microsoftConnected(db: Db, orgId: number): Promise<{ connected: boolean; account: string | null; status: string | null }> {
    const [row] = await db.select({ status: workspaceIntegrations.status, account: workspaceIntegrations.externalAccountName })
        .from(workspaceIntegrations).where(and(eq(workspaceIntegrations.organisationId, orgId), eq(workspaceIntegrations.provider, 'outlook_calendar'))).limit(1);
    return { connected: row?.status === 'active', account: row?.account ?? null, status: row?.status ?? null };
}

async function graph(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${GRAPH}${path}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'outlook.timezone="UTC"', ...(init.headers || {}) }, signal: AbortSignal.timeout(10_000) });
        if (res.status !== 429 && res.status !== 503) return res;
        const wait = Math.min(5, Number(res.headers.get('Retry-After')) || attempt + 1);
        await new Promise((r) => setTimeout(r, wait * 1000));
    }
    return fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
}

/** Graph's UTC "2026-10-20T09:00:00.0000000" (Prefer: outlook.timezone="UTC") → a Date. */
export const graphTime = (dt: string) => new Date(/Z$|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt.replace(/\.\d+$/, '')}Z`);
const graphWhen = (d: Date) => ({ dateTime: d.toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' });

export interface GraphEventLite { start?: { dateTime: string }; end?: { dateTime: string }; showAs?: string; isCancelled?: boolean; transactionId?: string | null; isAllDay?: boolean }

/** The busy ones, as start/end — pure, so the rules are testable. */
export function busyFromGraph(events: GraphEventLite[]): Array<{ start: Date; end: Date }> {
    return events
        .filter((e) => e.start?.dateTime && e.end?.dateTime && !e.isCancelled && BUSY_SHOW_AS.has(String(e.showAs || 'busy').toLowerCase()) && !String(e.transactionId || '').startsWith('bms-'))
        .map((e) => ({ start: graphTime(e.start!.dateTime), end: graphTime(e.end!.dateTime) }))
        .filter((b) => b.end > b.start);
}

// ── What should be in their calendar ────────────────────────────────────────────────────────────

export interface WantedEvent { key: string; subject: string; body: string; start: Date; end: Date; tentative: boolean; }

export const wantedHash = (w: WantedEvent) => createHash('sha256').update(JSON.stringify([w.subject, w.body, w.start.toISOString(), w.end.toISOString(), w.tentative])).digest('hex').slice(0, 32);

/** The event for a booking (not a class place — the class date carries those). Pure. */
export function eventForBooking(b: { id: number; status: string; startsAt: Date; endsAt: Date; customerName: string; customerEmail: string; customerPhone: string | null; notes: string | null; partySize: number; kind: string; depositPence: number | null; paymentStatus: string | null }, what: string): WantedEvent {
    const pending = b.status === 'pending';
    const money = b.depositPence && b.paymentStatus === 'paid' ? `${formatPounds(b.depositPence)} deposit paid` : '';
    return {
        key: `b:${b.id}`, start: new Date(b.startsAt), end: new Date(b.endsAt), tentative: pending,
        subject: `${what} — ${b.customerName}${pending ? ' (to confirm)' : ''}`,
        body: [b.customerName, b.customerEmail, b.customerPhone, b.kind === 'table' ? `Party of ${b.partySize}` : '', money, b.notes ? `Notes: ${b.notes}` : '',
            pending ? 'Confirm or decline it on the Bookings tab.' : '', 'Booked on your website (Be More Swan).'].filter(Boolean).join('\n'),
    };
}

export function eventForSession(s: { id: number; title: string; resourceName: string | null; startsAt: Date; endsAt: Date; capacity: number }, people: Array<{ name: string; places: number }>): WantedEvent {
    const taken = people.reduce((n, p) => n + p.places, 0);
    return {
        key: `s:${s.id}`, start: new Date(s.startsAt), end: new Date(s.endsAt), tentative: false,
        subject: `${s.title}${s.resourceName ? ` with ${s.resourceName}` : ''} — ${taken}/${s.capacity} booked`,
        body: [people.length ? `Booked: ${people.map((p) => `${p.name}${p.places > 1 ? ` ×${p.places}` : ''}`).join(', ')}` : 'Nobody booked yet.', 'From your website timetable (Be More Swan).'].join('\n'),
    };
}

async function wantedFor(db: Db, orgId: number, now: Date): Promise<WantedEvent[]> {
    const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
    const st = settingsFromRow(row as Record<string, unknown> | undefined);
    const from = new Date(now.getTime() - 86_400_000);
    const to = new Date(now.getTime() + Math.min(MS_LIMITS.horizonCapDays, st.maxAdvanceDays + 1) * 86_400_000);
    const { describeBooking } = await import('./bookings');
    const rows = await db.select().from(bookings)
        .where(and(eq(bookings.organisationId, orgId), inArray(bookings.status, ['pending', 'confirmed']), gte(bookings.endsAt, from), lte(bookings.startsAt, to))).orderBy(asc(bookings.startsAt)).limit(1000);
    const sessions = await db.select().from(classSessions)
        .where(and(eq(classSessions.organisationId, orgId), eq(classSessions.status, 'scheduled'), gte(classSessions.endsAt, from), lte(classSessions.startsAt, to))).orderBy(asc(classSessions.startsAt)).limit(500);
    return [
        ...rows.filter((b) => b.kind !== 'class').map((b) => eventForBooking({ ...b, startsAt: new Date(b.startsAt), endsAt: new Date(b.endsAt) }, describeBooking(b, st.timezone).what)),
        ...sessions.map((s) => eventForSession({ ...s, startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) },
            rows.filter((b) => b.sessionId === s.id).map((b) => ({ name: b.customerName, places: b.partySize })))),
    ];
}

/** The plan: create what's missing, change what differs, delete what should no longer be there. Pure. */
export function planReconcile(wanted: WantedEvent[], have: Array<{ itemKey: string; externalId: string; contentHash: string; endsAt: Date }>, now: Date) {
    const byKey = new Map(have.map((h) => [h.itemKey, h]));
    const wantKeys = new Set(wanted.map((w) => w.key));
    return {
        create: wanted.filter((w) => !byKey.has(w.key)),
        update: wanted.filter((w) => byKey.has(w.key) && byKey.get(w.key)!.contentHash !== wantedHash(w)),
        // A past event is left alone (it happened); only future ones are taken out.
        remove: have.filter((h) => !wantKeys.has(h.itemKey) && new Date(h.endsAt) > now),
        forget: have.filter((h) => !wantKeys.has(h.itemKey) && new Date(h.endsAt) <= now),
    };
}

const eventJson = (w: WantedEvent, orgId: number) => ({
    subject: w.subject, body: { contentType: 'text', content: w.body },
    start: graphWhen(w.start), end: graphWhen(w.end),
    showAs: w.tentative ? 'tentative' : 'busy', isReminderOn: false,
    transactionId: `bms-${orgId}-${w.key}`,
});

/** Bring their calendar in line with bookings and class dates. Returns how many writes were made. */
export async function reconcileOut(db: Db, orgId: number, token: string, now: Date): Promise<number> {
    const wanted = await wantedFor(db, orgId, now);
    const have = await db.select().from(calendarEvents).where(and(eq(calendarEvents.organisationId, orgId), eq(calendarEvents.provider, 'microsoft')));
    const plan = planReconcile(wanted, have.map((h) => ({ ...h, endsAt: new Date(h.endsAt) })), now);
    let writes = 0;
    const budget = () => writes < MS_LIMITS.writesPerRun;
    for (const w of plan.create) {
        if (!budget()) break;
        const res = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify(eventJson(w, orgId)) });
        writes++;
        if (!res.ok) { console.error('[calendar-microsoft] create failed', { orgId, status: res.status }); continue; }
        const ev = await res.json() as { id: string };
        await db.insert(calendarEvents).values({ organisationId: orgId, provider: 'microsoft', itemKey: w.key, externalId: ev.id, contentHash: wantedHash(w), endsAt: w.end })
            .onConflictDoUpdate({ target: [calendarEvents.organisationId, calendarEvents.provider, calendarEvents.itemKey], set: { externalId: ev.id, contentHash: wantedHash(w), endsAt: w.end, updatedAt: new Date() } });
    }
    for (const w of plan.update) {
        if (!budget()) break;
        const h = have.find((x) => x.itemKey === w.key)!;
        const { transactionId: _t, ...patch } = eventJson(w, orgId);
        const res = await graph(token, `/me/events/${encodeURIComponent(h.externalId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        writes++;
        if (res.status === 404) { await db.delete(calendarEvents).where(eq(calendarEvents.id, h.id)); continue; }   // they deleted it: made again next run
        if (!res.ok) { console.error('[calendar-microsoft] update failed', { orgId, status: res.status }); continue; }
        await db.update(calendarEvents).set({ contentHash: wantedHash(w), endsAt: w.end, updatedAt: new Date() }).where(eq(calendarEvents.id, h.id));
    }
    for (const h of plan.remove) {
        if (!budget()) break;
        const res = await graph(token, `/me/events/${encodeURIComponent(h.externalId)}`, { method: 'DELETE' });
        writes++;
        if (res.ok || res.status === 404) await db.delete(calendarEvents).where(eq(calendarEvents.externalId, h.externalId));
        else console.error('[calendar-microsoft] delete failed', { orgId, status: res.status });
    }
    if (plan.forget.length) await db.delete(calendarEvents).where(and(eq(calendarEvents.organisationId, orgId), inArray(calendarEvents.itemKey, plan.forget.map((f) => f.itemKey))));
    return writes;
}

/** Read their busy times into calendar_busy (the business's), replacing whatever was there. */
export async function readBusyIn(db: Db, orgId: number, token: string, now: Date): Promise<number> {
    const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
    const st = settingsFromRow(row as Record<string, unknown> | undefined);
    const start = new Date(now.getTime() - 86_400_000).toISOString();
    const end = new Date(now.getTime() + Math.min(MS_LIMITS.horizonCapDays, st.maxAdvanceDays + 2) * 86_400_000).toISOString();
    let next: string | null = `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$select=start,end,showAs,isCancelled,transactionId&$top=200`;
    const events: GraphEventLite[] = [];
    for (let page = 0; next && page < MS_LIMITS.pages; page++) {
        const res = await graph(token, next);
        if (!res.ok) throw new IntegrationError('provider_error', `Outlook calendar answered ${res.status}.`, 502);
        const data = await res.json() as { value?: GraphEventLite[]; '@odata.nextLink'?: string };
        events.push(...(data.value ?? []));
        next = data['@odata.nextLink'] ?? null;
    }
    const busy = busyFromGraph(events);
    await db.transaction(async (tx) => {
        await tx.delete(calendarBusy).where(and(eq(calendarBusy.organisationId, orgId), isNull(calendarBusy.resourceId)));
        for (let i = 0; i < busy.length; i += 500) await tx.insert(calendarBusy).values(busy.slice(i, i + 500).map((b) => ({ organisationId: orgId, resourceId: null, startsAt: b.start, endsAt: b.end })));
    });
    return busy.length;
}

/** Both directions for one workspace. Records the outcome on booking_settings. Never throws. */
export async function syncMicrosoft(db: Db, orgId: number, now: Date): Promise<boolean> {
    try {
        const { accessToken } = await getFreshAccessToken(db, orgId, 'outlook_calendar');
        // Signed in replaces the private iCal address for the business (one source of busy times).
        const [row] = await db.select({ host: bookingSettings.busyCalendarHost, source: bookingSettings.busySource }).from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
        if (row?.host && row.source !== 'microsoft') await setBusyCalendar(db, orgId, { resourceId: null }, null);
        const count = await readBusyIn(db, orgId, accessToken, now);
        await reconcileOut(db, orgId, accessToken, now);
        await db.insert(bookingSettings).values({ organisationId: orgId, busySource: 'microsoft', busySyncedAt: now, busySyncError: null, busyCount: count })
            .onConflictDoUpdate({ target: bookingSettings.organisationId, set: { busySource: 'microsoft', busySyncedAt: now, busySyncError: null, busyCount: count } });
        return true;
    } catch (err) {
        const msg = err instanceof IntegrationError && (err.code === 'not_connected' || err.code === 'refresh_failed')
            ? 'Your Outlook calendar needs connecting again — Microsoft stopped accepting the sign-in.'
            : 'We couldn\'t reach your Outlook calendar just now. We\'ll try again shortly.';
        console.error('[calendar-microsoft] sync failed', { orgId, code: err instanceof IntegrationError ? err.code : 'error', message: err instanceof Error ? err.message : String(err) });
        await db.update(bookingSettings).set({ busySyncedAt: now, busySyncError: msg }).where(eq(bookingSettings.organisationId, orgId)).catch(() => undefined);
        return false;
    }
}

/** After a booking changes: bring their calendar up to date now, quickly. Silent if not connected. */
export async function reconcileSoon(db: Db, orgId: number): Promise<void> {
    try {
        if (!(await microsoftConnected(db, orgId)).connected) return;
        const { accessToken } = await getFreshAccessToken(db, orgId, 'outlook_calendar');
        await Promise.race([reconcileOut(db, orgId, accessToken, new Date()), new Promise((r) => setTimeout(r, 6000))]);
    } catch (err) {
        console.error('[calendar-microsoft] immediate update failed (the 15-minute sync will catch up)', err instanceof Error ? err.message : err);
    }
}

/** Every workspace with the Outlook calendar connected (for the 15-minute sync). */
export async function microsoftOrgs(db: Db): Promise<number[]> {
    const rows = await db.select({ orgId: workspaceIntegrations.organisationId }).from(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.provider, 'outlook_calendar'), eq(workspaceIntegrations.status, 'active'))).limit(500);
    return rows.map((r) => r.orgId);
}

/** Disconnected: stop treating its busy times as current (the events already written stay theirs). */
export async function forgetMicrosoft(db: Db, orgId: number): Promise<void> {
    await db.delete(calendarBusy).where(and(eq(calendarBusy.organisationId, orgId), isNull(calendarBusy.resourceId)));
    await db.delete(calendarEvents).where(and(eq(calendarEvents.organisationId, orgId), eq(calendarEvents.provider, 'microsoft')));
    await db.update(bookingSettings).set({ busySource: null, busySyncedAt: null, busySyncError: null, busyCount: null }).where(eq(bookingSettings.organisationId, orgId));
}
