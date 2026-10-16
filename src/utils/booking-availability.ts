// src/utils/booking-availability.ts — which times can be booked. PURE. tests/bookings.test.ts.
//
// Inputs are what the database holds (settings, resources, the bookings already taken) and the
// clock; the answer is the list of start times a customer may choose, each with the resources free
// at it. The SAME function runs twice for every booking: once to draw the times, and again inside
// the lock when the booking is made (bookings.ts) — so a time shown a minute ago that has since gone
// is refused, never double-booked.
//
//   appointment / consultation — a service of N minutes, done by one member of staff (or room) at a
//       time. No staff set up → the business itself is the one resource: one booking at a time.
//   table — a party of P for the table duration; a table / area holds up to its capacity in guests
//       at once. No tables set up → the owner confirms each request (no capacity is invented).

import { addDays, dayOf, fromMinutes, toMinutes, utcToZoned, zonedToUtc, type DayKey } from './booking-time';

export type BookingKind = 'appointment' | 'consultation' | 'table';
export type Interval = { start: string; end: string };
export type WeeklyHours = Partial<Record<DayKey, Interval[]>>;

export interface AvailabilitySettings {
    timezone: string;
    weeklyHours: WeeklyHours;
    closures: Array<{ date: string; note?: string | null }>;
    minNoticeMinutes: number;
    maxAdvanceDays: number;
    slotIntervalMinutes: number;
    bufferMinutes: number;
    tableMinutes: number;
    maxPartySize: number;
}

export interface AvailabilityResource { id: number; name: string; capacity: number; weeklyHours: WeeklyHours | null; serviceIds: number[] | null; }
export interface TakenBooking { resourceId: number | null; startsAt: Date; endsAt: Date; partySize: number; }
/**
 * A busy time from the owner's own calendar (calendar-sync.ts). resourceId null = the business's
 * calendar, which blocks appointments for everyone; a person's blocks only them. Tables are never blocked.
 */
export interface BusyBlock { resourceId: number | null; startsAt: Date; endsAt: Date; }

export interface SlotQuery {
    date: string;
    kind: BookingKind;
    /** Service length in minutes (appointments); tables use settings.tableMinutes. */
    durationMinutes: number;
    serviceId: number | null;
    /** A chosen resource, or null for "anyone available". */
    resourceId: number | null;
    partySize: number;
    now: Date;
}

export interface Slot { time: string; startsAt: Date; endsAt: Date; resourceIds: Array<number | null>; }

/** Whether the date can be booked at all: inside the window, not closed, open that day. */
export function dateIsBookable(settings: AvailabilitySettings, date: string, now: Date): boolean {
    const today = utcToZoned(now, settings.timezone).date;
    if (date < today || date > addDays(today, settings.maxAdvanceDays)) return false;
    if (settings.closures.some((c) => c.date === date)) return false;
    return (settings.weeklyHours[dayOf(date)] ?? []).length > 0;
}

/** The next `count` bookable dates from today — what the date step offers. */
export function bookableDates(settings: AvailabilitySettings, now: Date, count = 14): string[] {
    const out: string[] = [];
    const today = utcToZoned(now, settings.timezone).date;
    for (let i = 0; i <= settings.maxAdvanceDays && out.length < count; i++) {
        const d = addDays(today, i);
        if (dateIsBookable(settings, d, now)) out.push(d);
    }
    return out;
}

const within = (hours: Interval[] | undefined, startMin: number, endMin: number) =>
    (hours ?? []).some((h) => toMinutes(h.start) <= startMin && endMin <= toMinutes(h.end));

export function availableSlots(settings: AvailabilitySettings, resources: AvailabilityResource[], taken: TakenBooking[], q: SlotQuery, busy: BusyBlock[] = []): Slot[] {
    if (!dateIsBookable(settings, q.date, q.now)) return [];
    if (q.kind === 'table' && (q.partySize < 1 || q.partySize > settings.maxPartySize)) return [];
    const length = q.kind === 'table' ? settings.tableMinutes : q.durationMinutes;
    if (!(length > 0)) return [];
    const day = dayOf(q.date);
    const earliest = q.now.getTime() + settings.minNoticeMinutes * 60000;
    const buffer = settings.bufferMinutes * 60000;

    // Who can take it: suitable for the service, and (when one was chosen) the one chosen. No
    // resources at all → the business itself (null): one at a time for appointments, unlimited
    // (owner confirms) for tables.
    let pool: Array<AvailabilityResource | null> = resources
        .filter((r) => q.kind === 'table' ? r.capacity >= q.partySize : (!r.serviceIds || q.serviceId === null || r.serviceIds.includes(q.serviceId)))
        .filter((r) => q.resourceId === null || r.id === q.resourceId);
    if (!resources.length) pool = [null];
    if (!pool.length) return [];

    const slots: Slot[] = [];
    for (const open of settings.weeklyHours[day] ?? []) {
        for (let m = toMinutes(open.start); m + length <= toMinutes(open.end); m += settings.slotIntervalMinutes) {
            const time = fromMinutes(m);
            const startsAt = zonedToUtc(q.date, time, settings.timezone);
            if (startsAt.getTime() < earliest) continue;
            const endsAt = new Date(startsAt.getTime() + length * 60000);
            const free: Array<number | null> = [];
            for (const r of pool) {
                // A resource with its own hours must be working the whole time.
                if (r && r.weeklyHours && !within(r.weeklyHours[day], m, m + length)) continue;
                // Busy in the owner's calendar (theirs, or the business's): not bookable then.
                if (q.kind !== 'table' && busy.some((x) => (x.resourceId === null || x.resourceId === (r ? r.id : null))
                    && x.startsAt.getTime() < endsAt.getTime() && startsAt.getTime() < x.endsAt.getTime())) continue;
                const overlapping = taken.filter((b) => b.resourceId === (r ? r.id : null)
                    && b.startsAt.getTime() < endsAt.getTime() + buffer && startsAt.getTime() < b.endsAt.getTime() + buffer);
                if (r === null) {
                    if (q.kind === 'table' || !overlapping.length) free.push(null);
                } else if (q.kind === 'table') {
                    const seated = overlapping.reduce((sum, b) => sum + b.partySize, 0);
                    if (seated + q.partySize <= r.capacity) free.push(r.id);
                } else if (overlapping.length < r.capacity) {
                    free.push(r.id);
                }
            }
            if (free.length) slots.push({ time, startsAt, endsAt, resourceIds: free });
        }
    }
    // Two opening periods can produce the same time; keep the first.
    return slots.filter((s, i) => slots.findIndex((x) => x.time === s.time) === i);
}
