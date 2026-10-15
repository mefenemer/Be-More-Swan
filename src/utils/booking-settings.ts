// src/utils/booking-settings.ts — what the owner may save as opening hours, booking rules and
// bookable resources. PURE: every write (Business Information, the chat's setup card) passes these.
// tests/bookings.test.ts.

import { DATE_RE, DAY_KEYS, TIME_RE, toMinutes, type DayKey } from './booking-time';
import type { AvailabilitySettings, Interval, WeeklyHours } from './booking-availability';
import { isValidTimezone } from './newsletter-schedule';

export const BOOKING_DEFAULTS: AvailabilitySettings & { mode: 'instant' | 'request'; cancellationPolicy: string | null; visitAddress: string | null; whatsapp: string | null } = {
    timezone: 'Europe/London', weeklyHours: {}, closures: [], mode: 'request',
    minNoticeMinutes: 120, maxAdvanceDays: 60, slotIntervalMinutes: 30, bufferMinutes: 0, tableMinutes: 90, maxPartySize: 8,
    cancellationPolicy: null, visitAddress: null, whatsapp: null,
};
export const SLOT_INTERVALS = [5, 10, 15, 20, 30, 45, 60, 90, 120] as const;
export const MAX_INTERVALS_PER_DAY = 3;
export const MAX_CLOSURES = 100;
export const RESOURCE_KINDS = ['staff', 'table', 'room', 'other'] as const;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const DAY_NAMES: Record<DayKey, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

/** Opening hours: up to three periods a day (e.g. lunch and dinner), each start before end, not overlapping. */
export function cleanWeeklyHours(raw: unknown): Result<WeeklyHours> {
    const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: WeeklyHours = {};
    for (const day of DAY_KEYS) {
        const list = Array.isArray(src[day]) ? (src[day] as unknown[]) : [];
        const periods: Interval[] = [];
        for (const p of list) {
            const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
            const start = String(o.start ?? '').trim();
            const end = String(o.end ?? '').trim();
            if (!start && !end) continue;
            if (!TIME_RE.test(start) || !TIME_RE.test(end)) return { ok: false, error: `${DAY_NAMES[day]}: times are written like 09:00 and 17:30.` };
            if (toMinutes(end) <= toMinutes(start)) return { ok: false, error: `${DAY_NAMES[day]}: the closing time must be after the opening time.` };
            periods.push({ start, end });
        }
        if (periods.length > MAX_INTERVALS_PER_DAY) return { ok: false, error: `${DAY_NAMES[day]}: up to ${MAX_INTERVALS_PER_DAY} opening periods a day.` };
        periods.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
        for (let i = 1; i < periods.length; i++) {
            if (toMinutes(periods[i].start) < toMinutes(periods[i - 1].end)) return { ok: false, error: `${DAY_NAMES[day]}: the opening periods overlap.` };
        }
        if (periods.length) out[day] = periods;
    }
    return { ok: true, value: out };
}

export function cleanClosures(raw: unknown): Result<Array<{ date: string; note: string | null }>> {
    const list = Array.isArray(raw) ? raw : [];
    if (list.length > MAX_CLOSURES) return { ok: false, error: `Up to ${MAX_CLOSURES} closed days.` };
    const seen = new Set<string>();
    const out: Array<{ date: string; note: string | null }> = [];
    for (const c of list) {
        const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
        const date = String(o.date ?? '').trim();
        if (!DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { ok: false, error: 'A closed day must be a date.' };
        if (seen.has(date)) continue;
        seen.add(date);
        const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 80) : null;
        out.push({ date, note });
    }
    return { ok: true, value: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

const intIn = (v: unknown, min: number, max: number): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** A settings save: only the fields sent change; each is checked. Returns the columns to store. */
export function cleanBookingSettings(raw: Record<string, unknown>): Result<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    if (has('timezone')) {
        if (!isValidTimezone(raw.timezone)) return { ok: false, error: 'Choose a valid timezone.' };
        out.timezone = String(raw.timezone).trim();
    }
    if (has('weeklyHours')) { const r = cleanWeeklyHours(raw.weeklyHours); if (!r.ok) return r; out.weeklyHours = r.value; }
    if (has('closures')) { const r = cleanClosures(raw.closures); if (!r.ok) return r; out.closures = r.value; }
    if (has('mode')) {
        if (raw.mode !== 'instant' && raw.mode !== 'request') return { ok: false, error: 'Choose whether bookings are confirmed straight away or by you.' };
        out.mode = raw.mode;
    }
    const nums: Array<[string, number, number, string]> = [
        ['minNoticeMinutes', 0, 30 * 24 * 60, 'The notice needed must be between none and 30 days.'],
        ['maxAdvanceDays', 1, 365, 'How far ahead people can book must be 1 to 365 days.'],
        ['bufferMinutes', 0, 240, 'The gap between bookings must be up to 4 hours.'],
        ['tableMinutes', 15, 480, 'A table booking must last between 15 minutes and 8 hours.'],
        ['maxPartySize', 1, 100, 'The largest party must be between 1 and 100.'],
    ];
    for (const [k, min, max, msg] of nums) {
        if (!has(k)) continue;
        const n = intIn(raw[k], min, max);
        if (n === null) return { ok: false, error: msg };
        out[k] = n;
    }
    if (has('slotIntervalMinutes')) {
        const n = Number(raw.slotIntervalMinutes);
        if (!(SLOT_INTERVALS as readonly number[]).includes(n)) return { ok: false, error: `Times are offered every ${SLOT_INTERVALS.join(', ')} minutes.` };
        out.slotIntervalMinutes = n;
    }
    if (has('visitAddress')) {
        const a = typeof raw.visitAddress === 'string' ? raw.visitAddress.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6).join('\n').slice(0, 300) : '';
        out.visitAddress = a || null;
    }
    if (has('whatsapp')) {
        const w = typeof raw.whatsapp === 'string' ? raw.whatsapp.trim() : '';
        if (w && !/^\+?[0-9 ()-]{7,20}$/.test(w)) return { ok: false, error: 'The WhatsApp number should look like +44 7700 900123.' };
        out.whatsapp = w || null;
    }
    if (has('cancellationPolicy')) {
        out.cancellationPolicy = typeof raw.cancellationPolicy === 'string' && raw.cancellationPolicy.trim() ? raw.cancellationPolicy.trim().slice(0, 500) : null;
    }
    return { ok: true, value: out };
}

export function cleanResource(raw: Record<string, unknown>, partial: boolean): Result<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(raw, k);
    if (!partial || has('name')) {
        const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        if (!name) return { ok: false, error: 'Give it a name — e.g. Sarah, Terrace, Room 1.' };
        out.name = name;
    }
    if (!partial || has('kind')) {
        const kind = raw.kind ?? 'staff';
        if (!(RESOURCE_KINDS as readonly unknown[]).includes(kind)) return { ok: false, error: 'Choose what it is.' };
        out.kind = kind;
    }
    if (!partial || has('capacity')) {
        const n = intIn(raw.capacity ?? 1, 1, 500);
        if (n === null) return { ok: false, error: 'Capacity must be 1 to 500.' };
        out.capacity = n;
    }
    if (has('weeklyHours')) {
        if (raw.weeklyHours === null) out.weeklyHours = null;
        else { const r = cleanWeeklyHours(raw.weeklyHours); if (!r.ok) return r; out.weeklyHours = Object.keys(r.value).length ? r.value : null; }
    }
    if (has('serviceIds')) {
        if (raw.serviceIds === null) out.serviceIds = null;
        else {
            const ids = [...new Set((Array.isArray(raw.serviceIds) ? raw.serviceIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
            out.serviceIds = ids.length ? ids : null;
        }
    }
    if (has('status')) {
        if (raw.status !== 'active' && raw.status !== 'archived') return { ok: false, error: 'Invalid status.' };
        out.status = raw.status;
    }
    return { ok: true, value: out };
}

/** The stored row as the availability engine reads it (defaults filled; bad shapes ignored). */
export function settingsFromRow(row: Partial<Record<string, unknown>> | null | undefined): typeof BOOKING_DEFAULTS {
    if (!row) return { ...BOOKING_DEFAULTS };
    const hours = cleanWeeklyHours(row.weeklyHours);
    const closures = cleanClosures(row.closures);
    const num = (k: keyof typeof BOOKING_DEFAULTS) => (Number.isFinite(Number(row[k])) ? Number(row[k]) : BOOKING_DEFAULTS[k] as number);
    return {
        timezone: isValidTimezone(row.timezone) ? String(row.timezone) : BOOKING_DEFAULTS.timezone,
        weeklyHours: hours.ok ? hours.value : {},
        closures: closures.ok ? closures.value : [],
        mode: row.mode === 'instant' ? 'instant' : 'request',
        minNoticeMinutes: num('minNoticeMinutes'), maxAdvanceDays: num('maxAdvanceDays'), slotIntervalMinutes: num('slotIntervalMinutes'),
        bufferMinutes: num('bufferMinutes'), tableMinutes: num('tableMinutes'), maxPartySize: num('maxPartySize'),
        cancellationPolicy: typeof row.cancellationPolicy === 'string' ? row.cancellationPolicy : null,
        visitAddress: typeof row.visitAddress === 'string' && row.visitAddress.trim() ? row.visitAddress : null,
        whatsapp: typeof row.whatsapp === 'string' && row.whatsapp.trim() ? row.whatsapp : null,
    };
}

/** Plain words for the hours ("Mon–Fri 9am–5pm; Sat 9am–1pm") — for the chat and the site. */
export function describeHours(h: WeeklyHours): string {
    const order: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const label = (d: DayKey) => DAY_NAMES[d].slice(0, 3);
    const fmt = (t: string) => { const hh = Number(t.slice(0, 2)); const mm = t.slice(3); return `${hh % 12 === 0 ? 12 : hh % 12}${mm === '00' ? '' : `:${mm}`}${hh < 12 ? 'am' : 'pm'}`; };
    const key = (d: DayKey) => (h[d] ?? []).map((p) => `${fmt(p.start)}–${fmt(p.end)}`).join(', ');
    const groups: Array<{ from: DayKey; to: DayKey; text: string }> = [];
    for (const d of order) {
        const text = key(d);
        const last = groups[groups.length - 1];
        if (last && last.text === text && order.indexOf(d) === order.indexOf(last.to) + 1) last.to = d;
        else groups.push({ from: d, to: d, text });
    }
    const open = groups.filter((g) => g.text);
    if (!open.length) return 'No opening hours set';
    return open.map((g) => `${label(g.from)}${g.from === g.to ? '' : `–${label(g.to)}`} ${g.text}`).join('; ');
}
