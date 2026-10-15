// src/utils/booking-time.ts — clock-on-the-wall times in the BUSINESS's timezone, and the instants
// they are. PURE (Intl only, no libraries). tests/bookings.test.ts.
//
// Opening hours are written as the business reads them ("Mon 09:00–17:00", Europe/London). A booking
// is stored as an instant (UTC). Converting between the two must survive the clocks changing: "09:00"
// on the last Sunday of October is a different UTC hour from "09:00" the day before.

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = typeof DAY_KEYS[number];
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Minutes the zone is ahead of UTC at this instant (London in summer: +60). */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
    return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** "2026-10-16" + "09:30" in Europe/London → the instant. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    // Twice: the offset at the guess can differ from the offset at the answer across a clock change.
    let at = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
    at = guess - tzOffsetMinutes(new Date(at), timeZone) * 60000;
    return new Date(at);
}

/** The instant as the business's wall clock: { date: '2026-10-16', time: '09:30', day: 'fri' }. */
export function utcToZoned(at: Date, timeZone: string): { date: string; time: string; day: DayKey } {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(at);
    const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const day = v('weekday').toLowerCase().slice(0, 3) as DayKey;
    return { date: `${v('year')}-${v('month')}-${v('day')}`, time: `${v('hour')}:${v('minute')}`, day };
}

/** The weekday of a calendar date (no timezone involved: a date is a date). */
export function dayOf(date: string): DayKey {
    const [y, m, d] = date.split('-').map(Number);
    return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function addDays(date: string, n: number): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const fromMinutes = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "Friday 16 October" — how a date reads to a customer. */
export function formatDate(date: string): string {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** "09:30" → "9:30am", "14:00" → "2pm". */
export function formatTime(time: string): string {
    const h = Number(time.slice(0, 2));
    const m = time.slice(3, 5);
    const suffix = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m === '00' ? '' : `:${m}`}${suffix}`;
}
