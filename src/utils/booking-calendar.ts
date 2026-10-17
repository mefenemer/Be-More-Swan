// src/utils/booking-calendar.ts
// The Website Assistant's Calendar tab (owner, 2026-10-17): availability and bookings on one grid, so
// "am I full?" is a glance. For each day: the hours bookings are taken, how many are booked and how
// many times are still free (appointments and tables); each class or event with its places taken of
// its places (n of N); and every booking, which the owner can open and confirm, decline or cancel.
//
// Reads only — the decisions go through sites.ts booking_decide like the Bookings tab, so a booking
// decided here is told to the customer in exactly the same way.

import { and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { bookings, classSessions } from '../../db/schema';
import { addDays, DATE_RE, dayOf, formatTime, utcToZoned, zonedToUtc } from './booking-time';
import { loadBookingSetup, slotsForDay, type BookingSetup } from './bookings';
import { takenBySession, viewOf } from './class-sessions';
import { depositNote } from './booking-deposits';

type Db = ReturnType<typeof getDb>;

/** At most six weeks at once: a month view, with the days either side. */
export const MAX_CALENDAR_DAYS = 42;
const SHOWN = ['pending', 'confirmed', 'awaiting_payment'];

export interface CalendarDay {
    date: string;
    /** '9:00am–5:00pm', or several spans joined; null when closed. */
    hours: string | null;
    closedNote: string | null;
    /** Appointments/tables that day (not class places). */
    booked: number;
    /** Start times still free for the shortest service (or a table for two); null when not counted. */
    free: number | null;
}

/**
 * What the free count is counted in: the shortest appointment service, else a table for two. A day
 * with free = 0 and hours is fully booked. Null when the business takes neither (classes only).
 */
function countBasis(setup: BookingSetup): { kind: 'appointment' | 'table'; serviceId: number | null; label: string } | null {
    const timed = setup.services.filter((s) => s.durationMinutes && s.durationMinutes > 0)
        .sort((a, b) => (a.durationMinutes ?? 0) - (b.durationMinutes ?? 0));
    if (timed.length) return { kind: 'appointment', serviceId: timed[0].id, label: `${timed[0].durationMinutes}-minute times` };
    if (setup.resources.some((r) => r.kind === 'table')) return { kind: 'table', serviceId: null, label: 'tables for two' };
    return null;
}

export function cleanRange(from: unknown, to: unknown): { from: string; to: string } | null {
    if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to) || to < from) return null;
    const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    return days > MAX_CALENDAR_DAYS ? null : { from, to };
}

export async function bookingCalendar(db: Db, orgId: number, range: { from: string; to: string }, now: Date) {
    const setup = await loadBookingSetup(db, orgId);
    const tz = setup.settings.timezone;
    const start = zonedToUtc(range.from, '00:00', tz);
    const end = zonedToUtc(addDays(range.to, 1), '00:00', tz);
    const basis = countBasis(setup);
    const today = utcToZoned(now, tz).date;

    const rows = await db.select().from(bookings)
        .where(and(eq(bookings.organisationId, orgId), isNull(bookings.sessionId), inArray(bookings.status, SHOWN), gte(bookings.startsAt, start), lt(bookings.startsAt, end)))
        .orderBy(asc(bookings.startsAt));
    const items = rows
        // An unpaid deposit hold that lapsed was never a booking.
        .filter((b) => b.paymentStatus !== 'expired')
        .map((b) => {
            const a = utcToZoned(new Date(b.startsAt), tz);
            const z = utcToZoned(new Date(b.endsAt), tz);
            return {
                id: b.id, date: a.date, time: formatTime(a.time), endTime: formatTime(z.time), status: b.status, kind: b.kind,
                what: b.serviceName || (b.kind === 'table' ? `Table for ${b.partySize}` : 'Booking'), with: b.resourceName,
                customerName: b.customerName, customerEmail: b.customerEmail, customerPhone: b.customerPhone, notes: b.notes,
                partySize: b.partySize, deposit: depositNote(b), startsAt: new Date(b.startsAt).toISOString(),
            };
        });

    const sessionRows = await db.select().from(classSessions)
        .where(and(eq(classSessions.organisationId, orgId), gte(classSessions.startsAt, start), lt(classSessions.startsAt, end)))
        .orderBy(asc(classSessions.startsAt));
    const taken = await takenBySession(db, sessionRows.map((s) => s.id));
    const sessions = sessionRows.map((s) => viewOf(s, taken.get(s.id) ?? 0, tz));

    const days: CalendarDay[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
        const closure = setup.settings.closures.find((c) => c.date === d);
        const spans = closure ? [] : (setup.settings.weeklyHours[dayOf(d)] ?? []);
        const booked = items.filter((b) => b.date === d).length;
        let free: number | null = null;
        // Counted only where it means something: open, today or later, inside how far ahead bookings go.
        if (basis && spans.length && d >= today && d <= addDays(today, setup.settings.maxAdvanceDays)) {
            free = (await slotsForDay(db, orgId, setup, { kind: basis.kind, date: d, serviceId: basis.serviceId, resourceId: null, partySize: basis.kind === 'table' ? 2 : 1, now })).length;
        }
        days.push({
            date: d,
            hours: spans.length ? spans.map((s) => `${formatTime(s.start)}–${formatTime(s.end)}`).join(', ') : null,
            closedNote: closure ? (closure.note || 'Closed') : null,
            booked, free,
        });
    }
    return { timezone: tz, today, countedIn: basis?.label ?? null, days, sessions, bookings: items };
}
