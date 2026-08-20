// src/utils/newsletter-schedule.ts
// What time is it for the person receiving this?
//
// Two questions that look like one:
//
//   1. WHEN DID THE SENDER MEAN? "9:00" is not an instant. Until this existed the server parsed a
//      bare wall-clock string with no zone attached, which made it 09:00 UTC — ten in the morning
//      for a British sender in summer, and the evening of the previous day for one in Sydney.
//      Nothing said so, which is what made it a bug rather than a setting.
//   2. WHEN IS IT FOR THE READER? Everyone receiving an issue at the same instant is not wrong, it
//      is just one of two reasonable things to want. The other one needs a timezone per subscriber.
//
// ⚠️ WE ONLY KNOW A SUBSCRIBER'S TIMEZONE IF THEIR BROWSER TOLD US at sign-up. It cannot be read
// from an email address, and reading it from a sign-up IP would be a guess presented as a fact in
// the one place where being wrong means arriving at three in the morning. So "unknown" is a
// first-class answer here: those people are sent at the SENDER's chosen time, and the count is put
// in front of the tenant before anything goes out.

import { DEFAULT_POSTING_TIMEZONE, zonedWallTimeToUtc } from '../config/posting-cadence';

/** 'HH:MM', 24-hour. */
export const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** How far ahead of the sender's own send a local-time recipient may be pulled. */
export const MAX_LOCAL_SPREAD_HOURS = 24;

/**
 * Is this a timezone this runtime can actually do arithmetic in?
 *
 * ⚠️ Checked rather than trusted. The value arrives from a subscriber's browser — anybody can post
 * anything to the sign-up endpoint — and an unknown zone reaching Intl throws a RangeError. Inside
 * the send worker that would fail a whole batch over one bad row.
 */
export function isValidTimezone(tz: unknown): tz is string {
    const value = String(tz ?? '').trim();
    if (!value || value.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-GB', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/** The zone to use, given what the tenant chose and what we can actually honour. */
export function resolveSendTimezone(stamped: string | null | undefined, fallback?: string | null): string {
    if (isValidTimezone(stamped)) return stamped;
    if (isValidTimezone(fallback)) return fallback;
    return DEFAULT_POSTING_TIMEZONE;
}

/**
 * A wall-clock string from a `datetime-local` input, read in a specific zone.
 *
 * Accepts exactly what that input produces ('2026-08-25T09:00'), and also a full ISO instant —
 * which already carries its own zone and is returned as-is, because re-interpreting an instant in a
 * timezone would move it.
 */
export function wallClockToInstant(value: string, timeZone: string): Date | null {
    const raw = String(value ?? '').trim();
    if (!raw) return null;

    // Already an instant: has a Z or a ±hh:mm offset.
    if (/(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) {
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
    const out = zonedWallTimeToUtc(y, mo - 1, d, h, mi, timeZone);
    return Number.isNaN(out.getTime()) ? null : out;
}

/** The same instant, as the 'YYYY-MM-DDTHH:MM' a `datetime-local` input wants, in a zone. */
export function instantToWallClock(instant: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(instant);
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const hour = p.hour === '24' ? '00' : p.hour;
    return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

/**
 * When does THIS recipient's copy become due?
 *
 * The rule, and the reason for each half of it:
 *
 *   · The target is the chosen wall-clock time on the day the issue starts sending, in the
 *     recipient's own zone.
 *   · ⚠️ IT NEVER GOES BACKWARDS. If that moment has already passed where they are — the issue
 *     started at 10:00 in London and this person is in Sydney, where 09:00 was hours ago — they are
 *     sent as soon as the issue starts, NOT tomorrow morning. An issue that is being sent now is
 *     news now; holding it 23 hours to hit a nicer clock face would deliver yesterday's newsletter.
 *   · ⚠️ AND IT NEVER RUNS AWAY. Anything beyond MAX_LOCAL_SPREAD_HOURS from the start is clamped,
 *     so one nonsense zone cannot leave a copy sitting queued for days.
 */
export function dueAtForRecipient(args: {
    startedAt: Date;
    localTime: string;
    senderTimezone: string;
    recipientTimezone: string | null | undefined;
}): Date {
    const tz = isValidTimezone(args.recipientTimezone) ? args.recipientTimezone : args.senderTimezone;
    const m = String(args.localTime || '').match(LOCAL_TIME_RE);
    if (!m) return args.startedAt;

    const [hour, minute] = [Number(m[1]), Number(m[2])];

    // The calendar date where THEY are at the moment the issue starts.
    const there = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(args.startedAt).split('-').map(Number);

    let due = zonedWallTimeToUtc(there[0], there[1] - 1, there[2], hour, minute, tz);
    if (due.getTime() < args.startedAt.getTime()) return args.startedAt;

    const cap = args.startedAt.getTime() + MAX_LOCAL_SPREAD_HOURS * 60 * 60 * 1000;
    if (due.getTime() > cap) due = new Date(cap);
    return due;
}
