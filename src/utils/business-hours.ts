// src/utils/business-hours.ts — "Are you open now?", in the business's own timezone. PURE.
// The website's "Opening hours & contact" section (site-render.ts) and its search data.
// tests/business-hours.test.ts.
//
// The hours are the ones in Business Information ▸ Hours, Location & Bookings (booking_settings),
// the same ones bookings use — set once, used everywhere.

import { addDays, DAY_KEYS, dayOf, formatTime, toMinutes, utcToZoned, type DayKey } from './booking-time';
import type { WeeklyHours } from './booking-availability';

export interface OpenStatus { open: boolean; text: string; }

const DAY_NAME: Record<DayKey, string> = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const closedOn = (closures: Array<{ date: string }>, date: string) => closures.some((c) => c.date === date);

/**
 * "Open now · closes 6pm", "Closed · opens 9am", "Closed · opens tomorrow at 9am",
 * "Closed · opens Monday at 9am". Looks up to a week ahead; null when there are no hours at all.
 */
export function openStatus(hours: WeeklyHours, closures: Array<{ date: string }>, timeZone: string, now: Date): OpenStatus | null {
    if (!DAY_KEYS.some((d) => (hours[d] ?? []).length)) return null;
    const here = utcToZoned(now, timeZone);
    const nowMin = toMinutes(here.time);
    const today = closedOn(closures, here.date) ? [] : (hours[here.day] ?? []);
    const current = today.find((p) => toMinutes(p.start) <= nowMin && nowMin < toMinutes(p.end));
    if (current) return { open: true, text: `Open now · closes ${formatTime(current.end)}` };
    const laterToday = today.find((p) => toMinutes(p.start) > nowMin);
    if (laterToday) return { open: false, text: `Closed · opens ${formatTime(laterToday.start)}` };
    for (let i = 1; i <= 7; i++) {
        const date = addDays(here.date, i);
        if (closedOn(closures, date)) continue;
        const first = (hours[dayOf(date)] ?? [])[0];
        if (first) return { open: false, text: `Closed · opens ${i === 1 ? 'tomorrow' : DAY_NAME[dayOf(date)]} at ${formatTime(first.start)}` };
    }
    return { open: false, text: 'Closed' };
}

/** The week as rows, Monday first: [{ day: 'Monday', text: '9am–5pm' | '9am–1pm, 6pm–10pm' | 'Closed', today }]. */
export function weekRows(hours: WeeklyHours, timeZone: string, now: Date): Array<{ day: string; text: string; today: boolean }> {
    const todayKey = utcToZoned(now, timeZone).day;
    return (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as DayKey[]).map((d) => ({
        day: DAY_NAME[d],
        text: (hours[d] ?? []).length ? hours[d]!.map((p) => `${formatTime(p.start)}–${formatTime(p.end)}`).join(', ') : 'Closed',
        today: d === todayKey,
    }));
}

/** Closed days in the next `days` days (a bank holiday this week matters; one in July does not yet). */
export function upcomingClosures(closures: Array<{ date: string; note?: string | null }>, timeZone: string, now: Date, days = 21): Array<{ date: string; note: string | null }> {
    const today = utcToZoned(now, timeZone).date;
    const until = addDays(today, days);
    return closures.filter((c) => c.date >= today && c.date <= until).map((c) => ({ date: c.date, note: c.note ?? null }));
}

/** wa.me wants the number in international form with digits only; a UK 07… number becomes 447…. */
export function whatsappUrl(number: string): string | null {
    let digits = number.replace(/[^0-9+]/g, '');
    if (digits.startsWith('+')) digits = digits.slice(1);
    else if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = `44${digits.slice(1)}`;
    return /^[1-9][0-9]{7,14}$/.test(digits) ? `https://wa.me/${digits}` : null;
}

/** Directions in Google Maps (opens the Maps app on a phone). */
export function directionsUrl(address: string): string {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address.replace(/\n/g, ', '))}`;
}

/** schema.org openingHoursSpecification — what lets a search engine show "Open · closes 6pm". */
export function openingHoursSpecification(hours: WeeklyHours): Array<Record<string, string>> {
    return (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as DayKey[]).flatMap((d) => (hours[d] ?? []).map((p) => ({
        '@type': 'OpeningHoursSpecification', dayOfWeek: `https://schema.org/${DAY_NAME[d]}`, opens: p.start, closes: p.end,
    })));
}
