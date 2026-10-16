// src/utils/calendar-sync.ts — busy times from the owner's own calendar, with no sign-in
// (docs/booking-plan.md phase 3). db/z-calendar-sync.sql. tests/calendar-sync.test.ts.
//
// The owner pastes their calendar's PRIVATE iCal address (Google: Settings ▸ the calendar ▸
// "Secret address in iCal format"; Outlook: Publish calendar ▸ ICS; Apple: Public calendar link)
// for the business, or for one person (a bookable resource). Every 15 minutes
// (sync-busy-calendars.ts) it is fetched through the SSRF fence (safe-fetch.ts), read with
// ical-busy.ts, and only start/end times are kept (calendar_busy, replaced in full).
//
// ⚠️ The address is a SECRET — it reads their whole calendar. It is kept only in the vault
// (vault.ts, key aura/org-<id>/busy-calendar-<scope>), never in a column, a log or an error.

import { and, asc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { getDb } from '../../db/client';
import { bookableResources, bookingSettings, calendarBusy } from '../../db/schema';
import { deleteSecret, getSecret, storeSecret } from './vault';
import { safeFetchText, SafeFetchError, USER_AGENTS } from './safe-fetch';
import { busyTimes } from './ical-busy';
import { settingsFromRow } from './booking-settings';
import type { BusyBlock } from './booking-availability';

type Db = ReturnType<typeof getDb>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const CALENDAR_SYNC = { maxBytes: 4 * 1024 * 1024, timeoutMs: 10_000, horizonDays: 366 } as const;

/** Whose calendar: the business's, or one bookable person's / room's. */
export type CalendarScope = { resourceId: number | null };

export const vaultKeyFor = (orgId: number, s: CalendarScope) => `aura/org-${orgId}/busy-calendar-${s.resourceId ? `resource-${s.resourceId}` : 'business'}`;

/** A pasted address, checked: webcal:// becomes https://; https only; no user:password@. */
export function cleanCalendarUrl(raw: unknown): Result<{ url: string; host: string }> {
    let t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) return { ok: false, error: 'Paste your calendar\'s private iCal address.' };
    if (/^webcals?:\/\//i.test(t)) t = t.replace(/^webcals?:\/\//i, 'https://');
    let u: URL;
    try { u = new URL(t); } catch { return { ok: false, error: 'That doesn\'t look like a web address. It usually starts with https:// or webcal://.' }; }
    if (u.protocol !== 'https:') return { ok: false, error: 'The address must start with https:// or webcal://.' };
    if (u.username || u.password) return { ok: false, error: 'Addresses with a user name or password in them aren\'t supported.' };
    if (t.length > 2000) return { ok: false, error: 'That address is too long.' };
    return { ok: true, value: { url: u.toString(), host: u.hostname.toLowerCase() } };
}

const asVaultDb = (db: Db) => db as unknown as NodePgDatabase<Record<string, never>>;

/** Save (or, with null, forget) the address for the business or a person. Clears old busy times. */
export async function setBusyCalendar(db: Db, orgId: number, scope: CalendarScope, raw: unknown | null): Promise<Result<{ host: string | null }>> {
    const key = vaultKeyFor(orgId, scope);
    let host: string | null = null;
    if (raw === null || raw === '') {
        await deleteSecret(asVaultDb(db), key);
    } else {
        const c = cleanCalendarUrl(raw);
        if (!c.ok) return c;
        await storeSecret(asVaultDb(db), key, { url: c.value.url });
        host = c.value.host;
    }
    const status = { busyCalendarHost: host, busySyncedAt: null, busySyncError: null, busyCount: null };
    if (scope.resourceId) {
        await db.update(bookableResources).set(status).where(and(eq(bookableResources.id, scope.resourceId), eq(bookableResources.organisationId, orgId)));
    } else {
        await db.insert(bookingSettings).values({ organisationId: orgId, ...status }).onConflictDoUpdate({ target: bookingSettings.organisationId, set: status });
    }
    await db.delete(calendarBusy).where(and(eq(calendarBusy.organisationId, orgId), scope.resourceId ? eq(calendarBusy.resourceId, scope.resourceId) : isNull(calendarBusy.resourceId)));
    return { ok: true, value: { host } };
}

/** What went wrong, in words the owner can act on (never the address itself). */
export function syncErrorText(err: unknown): string {
    if (err instanceof SafeFetchError) {
        switch (err.reason) {
            case 'http_error': return /\((40[134]|410)\)/.test(err.message)
                ? 'Your calendar address was refused or not found — it may have been reset. Copy the private address again and paste it here.'
                : 'Your calendar service didn\'t answer properly just now. We\'ll try again shortly.';
            case 'private_address': case 'dns_failure': case 'invalid_url': case 'bad_scheme': case 'embedded_credentials': return 'That address can\'t be reached from the internet. Check you copied the whole private address.';
            case 'too_large': return 'Your calendar is too large to read (over 4 MB).';
            case 'timeout': return 'Your calendar took too long to answer. We\'ll try again shortly.';
            default: return 'We couldn\'t read your calendar just now. We\'ll try again shortly.';
        }
    }
    if (err instanceof Error && err.message === 'not_a_calendar') return 'That address didn\'t return a calendar. Use the private address "in iCal format".';
    return 'We couldn\'t read your calendar just now. We\'ll try again shortly.';
}

/** Read one calendar now and replace its busy times. Records the outcome on the row. */
export async function syncOne(db: Db, orgId: number, scope: CalendarScope, now: Date): Promise<{ ok: boolean; count: number }> {
    const write = async (v: { busySyncedAt: Date; busySyncError: string | null; busyCount?: number }) => {
        if (scope.resourceId) await db.update(bookableResources).set(v).where(and(eq(bookableResources.id, scope.resourceId), eq(bookableResources.organisationId, orgId)));
        else await db.update(bookingSettings).set(v).where(eq(bookingSettings.organisationId, orgId));
    };
    try {
        const secret = await getSecret(asVaultDb(db), vaultKeyFor(orgId, scope));
        const url = typeof secret?.url === 'string' ? secret.url : null;
        if (!url) { await write({ busySyncedAt: now, busySyncError: 'Paste your calendar\'s private address again — it couldn\'t be found.' }); return { ok: false, count: 0 }; }
        const res = await safeFetchText(url, { maxBytes: CALENDAR_SYNC.maxBytes, timeoutMs: CALENDAR_SYNC.timeoutMs, userAgent: USER_AGENTS.calendar });
        if (!/BEGIN:VCALENDAR/i.test(res.body.slice(0, 2000))) throw new Error('not_a_calendar');
        const [row] = await db.select().from(bookingSettings).where(eq(bookingSettings.organisationId, orgId)).limit(1);
        const st = settingsFromRow(row as Record<string, unknown> | undefined);
        const to = new Date(now.getTime() + Math.min(CALENDAR_SYNC.horizonDays, st.maxAdvanceDays + 2) * 86_400_000);
        const busy = busyTimes(res.body, st.timezone, new Date(now.getTime() - 86_400_000), to);
        await db.transaction(async (tx) => {
            await tx.delete(calendarBusy).where(and(eq(calendarBusy.organisationId, orgId), scope.resourceId ? eq(calendarBusy.resourceId, scope.resourceId) : isNull(calendarBusy.resourceId)));
            for (let i = 0; i < busy.length; i += 500) {
                await tx.insert(calendarBusy).values(busy.slice(i, i + 500).map((b) => ({ organisationId: orgId, resourceId: scope.resourceId, startsAt: b.start, endsAt: b.end })));
            }
        });
        await write({ busySyncedAt: now, busySyncError: null, busyCount: busy.length });
        return { ok: true, count: busy.length };
    } catch (err) {
        console.error('[calendar-sync] sync failed', { orgId, resourceId: scope.resourceId, reason: err instanceof SafeFetchError ? err.reason : err instanceof Error ? err.message : 'unknown' });
        await write({ busySyncedAt: now, busySyncError: syncErrorText(err) }).catch(() => undefined);
        return { ok: false, count: 0 };
    }
}

/** Every 15 minutes: the calendars read longest ago first, until the time budget runs out. */
export async function syncDueCalendars(db: Db, now: Date, budgetMs = 20_000): Promise<number> {
    const started = Date.now();
    const biz = await db.select({ orgId: bookingSettings.organisationId, at: bookingSettings.busySyncedAt }).from(bookingSettings)
        .where(isNotNull(bookingSettings.busyCalendarHost)).orderBy(sql`${bookingSettings.busySyncedAt} ASC NULLS FIRST`).limit(200);
    const people = await db.select({ orgId: bookableResources.organisationId, id: bookableResources.id, at: bookableResources.busySyncedAt }).from(bookableResources)
        .where(and(isNotNull(bookableResources.busyCalendarHost), eq(bookableResources.status, 'active'))).orderBy(sql`${bookableResources.busySyncedAt} ASC NULLS FIRST`).limit(400);
    const queue = [
        ...biz.map((b) => ({ orgId: b.orgId, scope: { resourceId: null } as CalendarScope, at: b.at })),
        ...people.map((p) => ({ orgId: p.orgId, scope: { resourceId: p.id } as CalendarScope, at: p.at })),
    ].sort((a, b) => (a.at ? new Date(a.at).getTime() : 0) - (b.at ? new Date(b.at).getTime() : 0));
    let done = 0;
    for (const q of queue) {
        if (Date.now() - started > budgetMs) break;
        await syncOne(db, q.orgId, q.scope, now);
        done++;
    }
    return done;
}

/** Busy times overlapping [from, to) — what availability needs. */
export async function loadBusy(db: Db, orgId: number, from: Date, to: Date): Promise<BusyBlock[]> {
    const rows = await db.select({ resourceId: calendarBusy.resourceId, startsAt: calendarBusy.startsAt, endsAt: calendarBusy.endsAt }).from(calendarBusy)
        .where(and(eq(calendarBusy.organisationId, orgId), lt(calendarBusy.startsAt, to), gte(calendarBusy.endsAt, from))).orderBy(asc(calendarBusy.startsAt));
    return rows.map((r) => ({ resourceId: r.resourceId, startsAt: new Date(r.startsAt), endsAt: new Date(r.endsAt) }));
}
