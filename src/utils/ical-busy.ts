// src/utils/ical-busy.ts — the busy times in an iCalendar (.ics) file. PURE.
// Used by calendar-sync.ts to read the owner's own calendar from its private iCal address
// (Google, Outlook, Apple all publish one), so times they're busy can't be booked.
// tests/calendar-sync.test.ts.
//
// Reads only what it needs: when each event starts and ends. Titles, places and attendees are never
// kept. Skipped: events marked free (TRANSP:TRANSPARENT — e.g. Google's default for all-day events),
// cancelled ones, and our own bookings (UIDs @bemoreswan.com — they block already).
//
// Repeats (RRULE): DAILY, WEEKLY (with BYDAY), MONTHLY (same day of the month, or BYDAY with a week
// number like 1MO / -1FR) and YEARLY, with INTERVAL, COUNT, UNTIL and EXDATE; a moved or cancelled
// single occurrence (RECURRENCE-ID) replaces the one it overrides. Anything rarer is read as its
// first occurrence only. Times are expanded in the event's own timezone, so a weekly 9am stays 9am
// across a clock change.

import { addDays, DAY_KEYS, dayOf, zonedToUtc, type DayKey } from './booking-time';
import { isValidTimezone } from './newsletter-schedule';

export interface BusyTime { start: Date; end: Date; }

const MAX_EVENTS = 5000;
const MAX_OCCURRENCES_PER_EVENT = 1000;

/** Outlook writes Windows zone names; the common UK / EU / US ones, mapped to IANA. */
const WINDOWS_ZONES: Record<string, string> = {
    'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Europe/London', 'W. Europe Standard Time': 'Europe/Berlin',
    'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
    'E. Europe Standard Time': 'Europe/Bucharest', 'GTB Standard Time': 'Europe/Athens', 'Irish Standard Time': 'Europe/Dublin',
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
    'Pacific Standard Time': 'America/Los_Angeles', 'AUS Eastern Standard Time': 'Australia/Sydney', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};

interface Prop { name: string; params: Record<string, string>; value: string; }
interface When { date: string; time: string | null; tz: string | 'UTC'; }   // time null = an all-day date
interface VEvent { uid: string; start: When | null; end: When | null; durationMin: number | null; rrule: string | null; exdates: string[]; recurrenceId: When | null; transparent: boolean; cancelled: boolean; }

/** Lines unfolded (a line starting with a space or tab continues the one before). */
export function unfold(text: string): string[] {
    return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseProp(line: string): Prop | null {
    const colon = (() => {
        // The first colon outside a quoted parameter value.
        let q = false;
        for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ':' && !q) return i; }
        return -1;
    })();
    if (colon < 0) return null;
    const [name, ...params] = line.slice(0, colon).split(';');
    const out: Record<string, string> = {};
    for (const p of params) { const eq = p.indexOf('='); if (eq > 0) out[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ''); }
    return { name: name.toUpperCase(), params: out, value: line.slice(colon + 1).trim() };
}

function zoneOf(tzid: string | undefined, fallback: string): string {
    if (!tzid) return fallback;
    const clean = tzid.replace(/^\/[^/]*\//, '');   // "/mozilla.org/20050126_1/Europe/London"
    if (WINDOWS_ZONES[clean]) return WINDOWS_ZONES[clean];
    return isValidTimezone(clean) ? clean : fallback;
}

/** "20261020T090000Z" / "20261020T090000" (+TZID) / "20261020" (VALUE=DATE). */
export function parseWhen(value: string, params: Record<string, string>, fallbackTz: string): When | null {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
    if (!m) return null;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (!m[4] || params.VALUE === 'DATE') return { date, time: null, tz: zoneOf(params.TZID, fallbackTz) };
    return { date, time: `${m[4]}:${m[5]}`, tz: m[7] ? 'UTC' : zoneOf(params.TZID, fallbackTz) };
}

const instant = (w: When): Date => (w.tz === 'UTC' ? new Date(`${w.date}T${w.time ?? '00:00'}:00Z`) : zonedToUtc(w.date, w.time ?? '00:00', w.tz));
const dateKey = (w: When) => instant(w).toISOString();

/** "PT1H30M", "P1D" → minutes. */
export function parseDuration(v: string): number | null {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
    if (!m) return null;
    const mins = (Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 1440 + Number(m[4] || 0) * 60 + Number(m[5] || 0) + Math.round(Number(m[6] || 0) / 60);
    return m[1] === '-' ? null : mins;
}

function readEvents(text: string, fallbackTz: string): VEvent[] {
    const events: VEvent[] = [];
    let cur: VEvent | null = null;
    let depth = 0;   // nested components inside a VEVENT (VALARM) are skipped
    for (const line of unfold(text)) {
        if (line === 'BEGIN:VEVENT') { cur = { uid: '', start: null, end: null, durationMin: null, rrule: null, exdates: [], recurrenceId: null, transparent: false, cancelled: false }; depth = 0; continue; }
        if (!cur) continue;
        if (line.startsWith('BEGIN:')) { depth++; continue; }
        if (line === 'END:VEVENT') { if (cur.start) events.push(cur); cur = null; if (events.length >= MAX_EVENTS) break; continue; }
        if (line.startsWith('END:')) { depth = Math.max(0, depth - 1); continue; }
        if (depth) continue;
        const p = parseProp(line);
        if (!p) continue;
        switch (p.name) {
            case 'UID': cur.uid = p.value; break;
            case 'DTSTART': cur.start = parseWhen(p.value, p.params, fallbackTz); break;
            case 'DTEND': cur.end = parseWhen(p.value, p.params, fallbackTz); break;
            case 'DURATION': cur.durationMin = parseDuration(p.value); break;
            case 'RRULE': cur.rrule = p.value; break;
            case 'EXDATE': for (const v of p.value.split(',')) { const w = parseWhen(v, p.params, fallbackTz); if (w) cur.exdates.push(dateKey(w)); } break;
            case 'RECURRENCE-ID': cur.recurrenceId = parseWhen(p.value, p.params, fallbackTz); break;
            case 'TRANSP': cur.transparent = p.value.toUpperCase() === 'TRANSPARENT'; break;
            case 'STATUS': cur.cancelled = p.value.toUpperCase() === 'CANCELLED'; break;
        }
    }
    return events;
}

const BYDAY: Record<string, DayKey> = { MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat', SU: 'sun' };

/** The dates (in the event's own zone) a repeat falls on, from its first date, up to `until`. */
export function expandDates(first: string, rrule: string, untilDate: string): string[] {
    const r: Record<string, string> = {};
    for (const part of rrule.split(';')) { const [k, v] = part.split('='); if (k && v) r[k.toUpperCase()] = v; }
    const freq = r.FREQ;
    const interval = Math.max(1, Number(r.INTERVAL) || 1);
    const count = r.COUNT ? Math.max(1, Number(r.COUNT)) : Infinity;
    const ruleUntil = r.UNTIL ? `${r.UNTIL.slice(0, 4)}-${r.UNTIL.slice(4, 6)}-${r.UNTIL.slice(6, 8)}` : null;
    const last = ruleUntil && ruleUntil < untilDate ? ruleUntil : untilDate;
    const out: string[] = [];
    const push = (d: string) => { if (d >= first && d <= last && out.length < count && out.length < MAX_OCCURRENCES_PER_EVENT) out.push(d); };
    const days = (r.BYDAY || '').split(',').filter(Boolean);

    if (freq === 'DAILY') {
        for (let d = first; d <= last && out.length < count && out.length < MAX_OCCURRENCES_PER_EVENT; d = addDays(d, interval)) push(d);
    } else if (freq === 'WEEKLY') {
        const want = days.length ? days.map((x) => BYDAY[x.slice(-2)]).filter(Boolean) : [dayOf(first)];
        // Weeks start Monday (WKST default); walk week by week from the Monday of the first week.
        const offset = (DAY_KEYS.indexOf(dayOf(first)) + 6) % 7;
        for (let monday = addDays(first, -offset); monday <= last && out.length < count && out.length < MAX_OCCURRENCES_PER_EVENT; monday = addDays(monday, 7 * interval)) {
            for (let i = 0; i < 7; i++) { const d = addDays(monday, i); if (want.includes(dayOf(d))) push(d); }
        }
    } else if (freq === 'MONTHLY') {
        const [y0, m0] = first.split('-').map(Number);
        const dom = Number(first.slice(8, 10));
        for (let k = 0; out.length < count && out.length < MAX_OCCURRENCES_PER_EVENT; k += interval) {
            const y = y0 + Math.floor((m0 - 1 + k) / 12);
            const m = ((m0 - 1 + k) % 12) + 1;
            const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
            if (monthStart > last) break;
            const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
            if (days.length) {
                for (const spec of days) {
                    const mm = /^([+-]?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(spec);
                    if (!mm) continue;
                    const n = Number(mm[1] || 1);
                    const all = Array.from({ length: dim }, (_, i) => `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`).filter((d) => dayOf(d) === BYDAY[mm[2]]);
                    const pick = n > 0 ? all[n - 1] : all[all.length + n];
                    if (pick) push(pick);
                }
            } else if (dom <= dim) push(`${y}-${String(m).padStart(2, '0')}-${String(dom).padStart(2, '0')}`);
        }
    } else if (freq === 'YEARLY') {
        for (let y = Number(first.slice(0, 4)); out.length < count && out.length < MAX_OCCURRENCES_PER_EVENT; y += interval) {
            const d = `${y}${first.slice(4)}`;
            if (d > last) break;
            push(d);
        }
    } else {
        push(first);
    }
    return out.sort();
}

/**
 * The busy times between `from` and `to`. `fallbackTz` (the business's) is used for floating times
 * and all-day events.
 */
export function busyTimes(text: string, fallbackTz: string, from: Date, to: Date): BusyTime[] {
    const events = readEvents(text, fallbackTz).filter((e) => !/@bemoreswan\.(com|site)$/i.test(e.uid));
    // Single occurrences moved or cancelled (RECURRENCE-ID) replace the series' own.
    const overridden = new Map<string, Set<string>>();
    for (const e of events) if (e.recurrenceId) {
        const set = overridden.get(e.uid) ?? new Set<string>();
        set.add(dateKey(e.recurrenceId));
        overridden.set(e.uid, set);
    }
    const out: BusyTime[] = [];
    const lastDate = to.toISOString().slice(0, 10);
    for (const e of events) {
        if (e.transparent || e.cancelled || !e.start) continue;
        const s = e.start;
        const lengthMin = e.end
            ? Math.round((instant(e.end).getTime() - instant(s).getTime()) / 60000)
            : e.durationMin ?? (s.time === null ? 1440 : 0);
        if (!(lengthMin > 0)) continue;
        const dates = e.rrule && !e.recurrenceId ? expandDates(s.date, e.rrule, addDays(lastDate, 1)) : [s.date];
        const skip = new Set([...e.exdates, ...(e.recurrenceId ? [] : overridden.get(e.uid) ?? [])]);
        for (const d of dates) {
            const w: When = { ...s, date: d };
            const start = instant(w);
            if (skip.has(start.toISOString())) continue;
            const end = new Date(start.getTime() + lengthMin * 60000);
            if (end <= from || start >= to) continue;
            out.push({ start, end });
            if (out.length >= MAX_EVENTS) return out;
        }
    }
    return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}
