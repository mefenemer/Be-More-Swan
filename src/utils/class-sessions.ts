// src/utils/class-sessions.ts — classes and events (docs/booking-plan.md phase 5).
// A session is one dated occurrence of a class (a Business Information product) with a number of
// places; a weekly class is several sessions sharing a series_key. A place is an ordinary booking
// (kind 'class', party_size = places), made under the same per-workspace lock as every booking, so
// two people can never take the last place. db/z-classes.sql. tests/classes.test.ts.

import { randomUUID } from 'crypto';
import { and, asc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookableResources, bookings, classSessions, classWaitlist, orgProducts } from '../../db/schema';
import { addDays, DATE_RE, formatDate, formatTime, TIME_RE, toMinutes, utcToZoned, zonedToUtc } from './booking-time';
import { loadBookingSetup, type BookingRow } from './bookings';
import { sendEmail } from './email';
import { esc } from './site-render';

type Db = ReturnType<typeof getDb>;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const CLASS_LIMITS = { repeatWeeks: 26, capacity: 500, minMinutes: 10, maxMinutes: 12 * 60, waitlistPerSession: 200, notes: 300 } as const;
const HELD = ['pending', 'confirmed'];

export type SessionRow = typeof classSessions.$inferSelect;
export interface SessionView {
    id: number; title: string; serviceId: number | null; resourceName: string | null; startsAt: string; endsAt: string;
    date: string; dateText: string; timeText: string; capacity: number; taken: number; left: number; status: string; seriesKey: string | null; price: string | null;
}

// ── Adding sessions ─────────────────────────────────────────────────────────────────────────────

export interface NewSessions {
    serviceId: number; date: string; start: string; end: string; capacity: number;
    resourceId: number | null; repeatWeeks: number; notes: string | null;
}

/** What the owner (or the chat's card) sent, checked. `repeatWeeks` 0 = a one-off (an event). */
export function cleanNewSessions(raw: Record<string, unknown>, today: string): Result<NewSessions> {
    const serviceId = Number(raw.serviceId);
    if (!Number.isInteger(serviceId) || serviceId <= 0) return { ok: false, error: 'Choose which class or event it is (from your Products & Services).' };
    const date = String(raw.date ?? '').trim();
    if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, error: 'Choose the date.' };
    if (date < today) return { ok: false, error: 'The date has already passed.' };
    const start = String(raw.start ?? '').trim();
    const end = String(raw.end ?? '').trim();
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { ok: false, error: 'Times are written like 18:00 and 19:15.' };
    const mins = toMinutes(end) - toMinutes(start);
    if (mins < CLASS_LIMITS.minMinutes) return { ok: false, error: 'It must end after it starts (at least 10 minutes).' };
    const capacity = Number(raw.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > CLASS_LIMITS.capacity) return { ok: false, error: 'Places must be between 1 and 500.' };
    const res = raw.resourceId === null || raw.resourceId === undefined || raw.resourceId === '' ? null : Number(raw.resourceId);
    if (res !== null && (!Number.isInteger(res) || res <= 0)) return { ok: false, error: 'Choose who teaches it, or leave it empty.' };
    const repeat = raw.repeatWeeks === undefined || raw.repeatWeeks === null || raw.repeatWeeks === '' ? 0 : Number(raw.repeatWeeks);
    if (!Number.isInteger(repeat) || repeat < 0 || repeat > CLASS_LIMITS.repeatWeeks) return { ok: false, error: `Repeat for up to ${CLASS_LIMITS.repeatWeeks} weeks.` };
    const notes = typeof raw.notes === 'string' && raw.notes.trim() ? raw.notes.trim().slice(0, CLASS_LIMITS.notes) : null;
    return { ok: true, value: { serviceId, date, start, end, capacity, resourceId: res, repeatWeeks: repeat, notes } };
}

/** The dates a new class falls on: the first, then the same weekday for `repeatWeeks` more weeks. */
export function sessionDates(first: string, repeatWeeks: number): string[] {
    return Array.from({ length: repeatWeeks + 1 }, (_, i) => addDays(first, i * 7));
}

/** Add one session, or a weekly series. The class and teacher must be this workspace's own. */
export async function addSessions(db: Db, orgId: number, n: NewSessions): Promise<Result<SessionRow[]>> {
    const [svc] = await db.select({ id: orgProducts.id, name: orgProducts.name }).from(orgProducts)
        .where(and(eq(orgProducts.id, n.serviceId), eq(orgProducts.organisationId, orgId), eq(orgProducts.status, 'active'))).limit(1);
    if (!svc) return { ok: false, error: 'That class isn\'t in your Products & Services any more.' };
    const [res] = n.resourceId ? await db.select({ id: bookableResources.id, name: bookableResources.name }).from(bookableResources)
        .where(and(eq(bookableResources.id, n.resourceId), eq(bookableResources.organisationId, orgId))).limit(1) : [];
    if (n.resourceId && !res) return { ok: false, error: 'That teacher or room isn\'t set up any more.' };
    const setup = await loadBookingSetup(db, orgId);
    const tz = setup.settings.timezone;
    const seriesKey = n.repeatWeeks > 0 ? randomUUID() : null;
    const rows = await db.insert(classSessions).values(sessionDates(n.date, n.repeatWeeks).map((d) => ({
        organisationId: orgId, serviceId: svc.id, title: svc.name, resourceId: res?.id ?? null, resourceName: res?.name ?? null,
        startsAt: zonedToUtc(d, n.start, tz), endsAt: zonedToUtc(d, n.end, tz), capacity: n.capacity, seriesKey, notes: n.notes,
    }))).returning();
    return { ok: true, value: rows };
}

// ── Reading the timetable ───────────────────────────────────────────────────────────────────────

/** Places held per session (pending + confirmed bookings). */
async function takenBySession(db: Db | Parameters<Parameters<Db['transaction']>[0]>[0], ids: number[]): Promise<Map<number, number>> {
    if (!ids.length) return new Map();
    const rows = await db.select({ id: bookings.sessionId, n: sql<number>`coalesce(sum(${bookings.partySize}), 0)::int` })
        .from(bookings).where(and(inArray(bookings.sessionId, ids), inArray(bookings.status, HELD))).groupBy(bookings.sessionId);
    return new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
}

export function viewOf(s: SessionRow, taken: number, tz: string, price: string | null = null): SessionView {
    const a = utcToZoned(new Date(s.startsAt), tz);
    const b = utcToZoned(new Date(s.endsAt), tz);
    return {
        id: s.id, title: s.title, serviceId: s.serviceId, resourceName: s.resourceName,
        startsAt: new Date(s.startsAt).toISOString(), endsAt: new Date(s.endsAt).toISOString(),
        date: a.date, dateText: formatDate(a.date), timeText: `${formatTime(a.time)}–${formatTime(b.time)}`,
        capacity: s.capacity, taken, left: Math.max(0, s.capacity - taken), status: s.status, seriesKey: s.seriesKey, price,
    };
}

/**
 * Upcoming sessions a customer may book: scheduled, starting after the notice the business needs and
 * within how far ahead it takes bookings. `serviceIds` empty = every class.
 */
export async function bookableSessions(db: Db, orgId: number, now: Date, serviceIds: number[] = [], limit = 200): Promise<SessionView[]> {
    const setup = await loadBookingSetup(db, orgId);
    const from = new Date(now.getTime() + setup.settings.minNoticeMinutes * 60000);
    const to = new Date(now.getTime() + setup.settings.maxAdvanceDays * 86_400_000);
    const rows = await db.select({ s: classSessions, price: orgProducts.price }).from(classSessions)
        .leftJoin(orgProducts, eq(orgProducts.id, classSessions.serviceId))
        .where(and(eq(classSessions.organisationId, orgId), eq(classSessions.status, 'scheduled'), gte(classSessions.startsAt, from), lte(classSessions.startsAt, to),
            ...(serviceIds.length ? [inArray(classSessions.serviceId, serviceIds)] : [])))
        .orderBy(asc(classSessions.startsAt)).limit(limit);
    const taken = await takenBySession(db, rows.map((r) => r.s.id));
    return rows.map((r) => viewOf(r.s, taken.get(r.s.id) ?? 0, setup.settings.timezone, r.price));
}

/** The owner's timetable: from `sinceDays` ago onwards, cancelled ones included, with who is booked. */
export async function ownerTimetable(db: Db, orgId: number, now: Date, sinceDays = 7) {
    const setup = await loadBookingSetup(db, orgId);
    const rows = await db.select().from(classSessions)
        .where(and(eq(classSessions.organisationId, orgId), gte(classSessions.startsAt, new Date(now.getTime() - sinceDays * 86_400_000))))
        .orderBy(asc(classSessions.startsAt)).limit(400);
    const ids = rows.map((r) => r.id);
    const taken = await takenBySession(db, ids);
    const people = ids.length ? await db.select({ sessionId: bookings.sessionId, id: bookings.id, name: bookings.customerName, email: bookings.customerEmail, places: bookings.partySize, status: bookings.status })
        .from(bookings).where(and(inArray(bookings.sessionId, ids), inArray(bookings.status, HELD))).orderBy(asc(bookings.createdAt)) : [];
    const waiting = ids.length ? await db.select({ sessionId: classWaitlist.sessionId, n: sql<number>`count(*)::int` }).from(classWaitlist)
        .where(inArray(classWaitlist.sessionId, ids)).groupBy(classWaitlist.sessionId) : [];
    return rows.map((r) => ({
        ...viewOf(r, taken.get(r.id) ?? 0, setup.settings.timezone),
        people: people.filter((p) => p.sessionId === r.id).map((p) => ({ id: p.id, name: p.name, email: p.email, places: p.places, status: p.status })),
        waiting: Number(waiting.find((w) => w.sessionId === r.id)?.n ?? 0),
    }));
}

export async function loadSession(db: Db, orgId: number, id: number): Promise<SessionRow | null> {
    if (!Number.isInteger(id) || id <= 0) return null;
    const [row] = await db.select().from(classSessions).where(and(eq(classSessions.id, id), eq(classSessions.organisationId, orgId))).limit(1);
    return row ?? null;
}

// ── Booking a place ─────────────────────────────────────────────────────────────────────────────

export interface NewClassBooking { sessionId: number; places: number; siteId: number | null; customerName: string; customerEmail: string; customerPhone: string | null; notes: string | null; now: Date; }
export type ClassBookResult = { ok: true; booking: BookingRow } | { ok: false; reason: 'full' | 'gone'; message: string; left: number };

/** Book places on a session: re-count under the lock, then hold them. Never overbooks. */
export async function bookSession(db: Db, orgId: number, b: NewClassBooking): Promise<ClassBookResult> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`bookings:${orgId}`}))`);
        const [s] = await tx.select().from(classSessions).where(and(eq(classSessions.id, b.sessionId), eq(classSessions.organisationId, orgId))).limit(1);
        const setup = await loadBookingSetup(tx as unknown as Db, orgId);
        const earliest = b.now.getTime() + setup.settings.minNoticeMinutes * 60000;
        if (!s || s.status !== 'scheduled' || new Date(s.startsAt).getTime() < earliest) {
            return { ok: false, reason: 'gone', message: 'Sorry — that session can\'t be booked any more.', left: 0 } as ClassBookResult;
        }
        const taken = (await takenBySession(tx, [s.id])).get(s.id) ?? 0;
        const left = s.capacity - taken;
        if (b.places > left) {
            return { ok: false, reason: 'full', left: Math.max(0, left), message: left > 0 ? `Sorry — only ${left} place${left === 1 ? ' is' : 's are'} left now.` : 'Sorry — it has just filled up.' } as ClassBookResult;
        }
        const instant = setup.settings.mode === 'instant';
        const [row] = await tx.insert(bookings).values({
            organisationId: orgId, siteId: b.siteId, serviceId: s.serviceId, resourceId: s.resourceId, sessionId: s.id, kind: 'class',
            startsAt: s.startsAt, endsAt: s.endsAt, partySize: b.places,
            customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone, notes: b.notes,
            serviceName: s.title, resourceName: s.resourceName,
            status: instant ? 'confirmed' : 'pending', decidedAt: instant ? new Date() : null,
        }).returning();
        return { ok: true, booking: row as BookingRow } as ClassBookResult;
    });
}

// ── The waitlist ────────────────────────────────────────────────────────────────────────────────

export async function joinWaitlist(db: Db, orgId: number, sessionId: number, w: { name: string; email: string; places: number }): Promise<Result<true>> {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(classWaitlist).where(eq(classWaitlist.sessionId, sessionId));
    if (Number(n) >= CLASS_LIMITS.waitlistPerSession) return { ok: false, error: 'The waitlist for this session is full.' };
    await db.insert(classWaitlist).values({ organisationId: orgId, sessionId, name: w.name, email: w.email, places: w.places }).onConflictDoNothing();
    return { ok: true, value: true };
}

/**
 * Places have freed up: email the earliest people on the waitlist whose places now fit, each once.
 * First come, first served — nothing is held, the link simply takes them to the booking form.
 */
export async function offerFreedPlaces(db: Db, orgId: number, sessionId: number | null, p: { business: string; siteOrigin: string | null; bookPath: (sessionId: number) => string }): Promise<number> {
    if (!sessionId || !p.siteOrigin) return 0;
    try {
        const s = await loadSession(db, orgId, sessionId);
        if (!s || s.status !== 'scheduled' || new Date(s.startsAt).getTime() < Date.now()) return 0;
        let left = s.capacity - ((await takenBySession(db, [s.id])).get(s.id) ?? 0);
        if (left <= 0) return 0;
        const setup = await loadBookingSetup(db, orgId);
        const v = viewOf(s, s.capacity - left, setup.settings.timezone);
        const queue = await db.select().from(classWaitlist).where(and(eq(classWaitlist.sessionId, s.id), isNull(classWaitlist.offeredAt))).orderBy(asc(classWaitlist.createdAt));
        let sent = 0;
        for (const w of queue) {
            if (left <= 0) break;
            if (w.places > left) continue;
            const [claimed] = await db.update(classWaitlist).set({ offeredAt: new Date() }).where(and(eq(classWaitlist.id, w.id), isNull(classWaitlist.offeredAt))).returning({ id: classWaitlist.id });
            if (!claimed) continue;
            const link = `${p.siteOrigin.replace(/\/+$/, '')}${p.bookPath(s.id)}`;
            await sendEmail({
                to: w.email, from: `${p.business.replace(/[<>"\\\r\n]/g, '').slice(0, 60)} (via Be More Swan) <noreply@bemoreswan.com>`,
                subject: `A place has opened up — ${s.title}, ${v.dateText}`,
                html: `<p>Hi ${esc(w.name.split(/\s+/)[0])},</p><p>A place has opened up on <strong>${esc(s.title)}</strong>, ${esc(v.dateText)}, ${esc(v.timeText)}. You were on the waitlist.</p><p><a href="${esc(link)}">Book your place</a> — it isn't held, so the first to book gets it.</p>`,
            }).catch((err: unknown) => console.error('[class-sessions] waitlist email failed', err instanceof Error ? err.message : err));
            left -= w.places;
            sent++;
        }
        return sent;
    } catch (err) {
        console.error('[class-sessions] offering freed places failed', err);
        return 0;
    }
}

// ── Cancelling a session ────────────────────────────────────────────────────────────────────────

/** Cancel a session (or it and every later one in its series): its bookings are cancelled too. */
export async function cancelSessions(db: Db, orgId: number, id: number, wholeSeries: boolean, now: Date): Promise<{ sessions: SessionRow[]; bookings: BookingRow[] }> {
    const s = await loadSession(db, orgId, id);
    if (!s || s.status !== 'scheduled') return { sessions: [], bookings: [] };
    const target = wholeSeries && s.seriesKey
        ? and(eq(classSessions.organisationId, orgId), eq(classSessions.seriesKey, s.seriesKey), eq(classSessions.status, 'scheduled'), gte(classSessions.startsAt, s.startsAt.getTime() > now.getTime() ? s.startsAt : now))
        : and(eq(classSessions.id, s.id), eq(classSessions.organisationId, orgId));
    const sessions = await db.update(classSessions).set({ status: 'cancelled', updatedAt: new Date() }).where(target).returning();
    const ids = sessions.map((x) => x.id);
    const cancelled = ids.length ? await db.update(bookings).set({ status: 'cancelled', cancelledBy: 'owner', decidedAt: new Date() })
        .where(and(inArray(bookings.sessionId, ids), inArray(bookings.status, HELD))).returning() : [];
    if (ids.length) await db.delete(classWaitlist).where(inArray(classWaitlist.sessionId, ids));
    return { sessions, bookings: cancelled as BookingRow[] };
}

