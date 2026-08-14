// src/utils/discovery-schedule.ts
// When a saved search next runs — the ONE implementation, shared by the dispatcher that fires
// schedules (netlify/functions/dispatch-discovery-runs.ts) and the API that edits them
// (discovery-campaigns.ts `schedule`).
//
// ⚠️ It has to be shared. The dispatcher used to compute this inline and ignored `days_of_week`
// entirely — a "weekly" schedule simply fired seven days after it last fired, so a search the user
// set to run on Mondays ran on whatever day it happened to be started. The column has existed
// since db/lead-discovery.sql; nothing read it. Two copies of this arithmetic is how that comes
// back: the UI would promise "next run Monday" and the dispatcher would fire on Thursday.
//
// Day numbering is JavaScript's: 0 = Sunday … 6 = Saturday, matching Date#getUTCDay() and the
// `[1] = Monday` note on the column. Everything here is UTC — the hour is stored as
// run_at_hour_utc and the row's `timezone` is a display hint for the client, never an input to
// this calculation.

export type DiscoveryCadence = 'one_off' | 'daily' | 'weekly';

export const DISCOVERY_CADENCES: readonly DiscoveryCadence[] = ['one_off', 'daily', 'weekly'] as const;

export function isDiscoveryCadence(v: unknown): v is DiscoveryCadence {
    return typeof v === 'string' && (DISCOVERY_CADENCES as readonly string[]).includes(v);
}

/** 0–23, clamped rather than rejected: an out-of-range hour is a client bug, not a reason to 400. */
export function normaliseHourUtc(v: unknown, fallback = 8): number {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(23, Math.max(0, Math.trunc(n)));
}

/**
 * Sorted, de-duplicated day numbers, or null when the caller supplied none.
 *
 * null means "no day constraint" and is NOT the same as an empty array: a weekly schedule with an
 * empty day list would match nothing and never fire again, so callers must treat both as "any
 * day", which is the legacy +7-days behaviour every existing row already has.
 */
export function normaliseDaysOfWeek(v: unknown): number[] | null {
    if (!Array.isArray(v)) return null;
    const days = [...new Set(
        v
            // ⚠️ Not a bare Number(): Number(null), Number('') and Number(false) are all 0, so a
            // sloppy client payload would quietly schedule a search for SUNDAY. Only a real number
            // (or a digit string, since jsonb round-trips are not always typed) counts as a day.
            .map((d) => (typeof d === 'number' ? d
                : (typeof d === 'string' && /^\d+$/.test(d.trim()) ? Number(d) : NaN)))
            .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    )].sort((a, b) => a - b);
    return days.length ? days : null;
}

/**
 * The next fire time strictly after `from`, or null when there will not be one.
 *
 * one_off has no next run — it disables itself once fired, which is what "run once each time you
 * start it" means everywhere in the UI.
 *
 * weekly WITHOUT days keeps the original behaviour (+7 days) rather than inventing a day: existing
 * rows have days_of_week NULL, and silently pinning them to the day of a deploy would move every
 * scheduled search in the estate.
 */
export function computeNextRun(
    cadence: string,
    runAtHourUtc: number,
    daysOfWeek: number[] | null,
    from: Date,
): Date | null {
    if (cadence === 'one_off') return null;
    const hour = normaliseHourUtc(runAtHourUtc);

    const base = new Date(from);
    base.setUTCHours(hour, 0, 0, 0);

    if (cadence === 'daily') {
        // `<=` not `<`: the dispatcher calls this with `from` set to the moment it just fired, so a
        // candidate equal to now is the run that has already happened.
        if (base <= from) base.setUTCDate(base.getUTCDate() + 1);
        return base;
    }

    const days = daysOfWeek && daysOfWeek.length ? daysOfWeek : null;
    if (!days) {
        base.setUTCDate(base.getUTCDate() + 7);
        return base;
    }

    // Walk forward a whole week from today's slot. i = 0 is today, which is still a candidate when
    // the hour has not passed yet — a schedule saved on Monday morning for Mondays should run in a
    // few hours, not next week.
    for (let i = 0; i <= 7; i++) {
        const candidate = new Date(base);
        candidate.setUTCDate(base.getUTCDate() + i);
        if (candidate > from && days.includes(candidate.getUTCDay())) return candidate;
    }
    // Unreachable while `days` is non-empty — every weekday recurs within seven days.
    return null;
}
