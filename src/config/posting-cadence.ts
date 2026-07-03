// src/config/posting-cadence.ts
// Discrete posting-cadence catalog — the single source of truth shared by the assistant-detail
// dropdown (UI) and the periodic conversion-post scheduler (schedule-conversion-posts.ts).
//
// posting_frequency is STORED as the human label (e.g. "3 times a week") so every existing
// free-text reader (goal-ai prompts, autonomous optimiser, brief summary) keeps working
// naturally. postsPerWeekFor() maps any stored value — a canonical label, a canonical key, or
// legacy free text — back to a number the scheduler can reason about.

export interface PostingCadence {
    /** Stable machine key. */
    key: string;
    /** Human label — this is what we persist in onboarding_context.posting_frequency. */
    label: string;
    /** Posts per week; 0 means "on demand" (no periodic scheduling). */
    postsPerWeek: number;
}

export const POSTING_CADENCES: PostingCadence[] = [
    { key: 'daily',     label: 'Daily',          postsPerWeek: 7 },
    { key: '5x_week',   label: '5 times a week', postsPerWeek: 5 },
    { key: '3x_week',   label: '3 times a week', postsPerWeek: 3 },
    { key: '2x_week',   label: '2 times a week', postsPerWeek: 2 },
    { key: 'weekly',    label: 'Weekly',         postsPerWeek: 1 },
    { key: 'on_demand', label: 'On demand',      postsPerWeek: 0 },
];

const NUMBER_WORDS: Record<string, number> = {
    once: 1, one: 1, twice: 2, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};

/**
 * Map a stored posting_frequency value to posts-per-week.
 *
 * Resolution order: canonical key → canonical label → free-text heuristics
 * ("3 times a week", "twice a day", "every day", "fortnightly", a bare number).
 * Returns 0 for on-demand / unrecognised (i.e. "do not schedule periodically").
 */
export function postsPerWeekFor(value: unknown): number {
    if (typeof value !== 'string') return 0;
    const raw = value.trim().toLowerCase();
    if (!raw) return 0;

    const byKey = POSTING_CADENCES.find(c => c.key === raw);
    if (byKey) return byKey.postsPerWeek;
    const byLabel = POSTING_CADENCES.find(c => c.label.toLowerCase() === raw);
    if (byLabel) return byLabel.postsPerWeek;

    // Free-text heuristics.
    if (/on[\s-]?demand|as needed|ad[\s-]?hoc|manual/.test(raw)) return 0;
    if (/fortnight|every (two|2) weeks|bi[\s-]?weekly/.test(raw)) return 0.5;
    if (/\bdaily\b|every ?day/.test(raw)) return 7;
    if (/\bweekly\b|every ?week/.test(raw)) return 1;

    // "<n> times a day" / "<n>x day"  → n*7 ;  "<n> times a week" / "<n>x week" → n.
    const perDay  = raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*day/);
    if (perDay)  return Number(perDay[1]) * 7;
    const perWeek = raw.match(/(\d+)\s*(?:x|times)?\s*(?:per|a|\/)?\s*week/);
    if (perWeek) return Number(perWeek[1]);

    // Word forms: "twice a day", "three times a week".
    for (const [word, n] of Object.entries(NUMBER_WORDS)) {
        if (new RegExp(`\\b${word}\\b.*\\bday`).test(raw)) return n * 7;
        if (new RegExp(`\\b${word}\\b.*\\bweek`).test(raw)) return n;
    }

    // Bare number → treat as per week.
    const bare = raw.match(/^(\d+)$/);
    if (bare) return Number(bare[1]);

    return 0;
}

/** Even spacing (in hours) between posts for a given cadence; null when not periodic. */
export function intervalHoursFor(value: unknown): number | null {
    const perWeek = postsPerWeekFor(value);
    if (perWeek <= 0) return null;
    return (7 * 24) / perWeek;
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting schedule — preferred days / times of day + slot computation.
//
// The schedule config is stored on the assistant's onboarding_context:
//   posting_frequency : human label (see POSTING_CADENCES)          → posts per week
//   posting_days      : string[] of weekday keys ('mon'..'sun')     → eligible days
//   posting_times     : string[] of 'HH:MM' (24h) local times       → time-of-day slots
//   posting_timezone  : IANA tz id (e.g. 'Europe/London')           → interpret the above
//
// computeScheduleSlots() turns that config + the draft horizon into an ordered list of concrete
// UTC instants the generator should fill, so drafts are spread across the chosen frequency/days/
// times instead of all landing at "now + 24h".
// ─────────────────────────────────────────────────────────────────────────────

/** Weekday keys indexed to match JS Date.getUTCDay() (0 = Sunday). */
export const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type WeekdayKey = typeof WEEKDAY_KEYS[number];

export const DEFAULT_POSTING_FREQUENCY = '3 times a week';
export const DEFAULT_POSTING_DAYS: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const DEFAULT_POSTING_TIMES = ['09:00'];
export const DEFAULT_POSTING_TIMEZONE = 'Europe/London';

export interface PostingSchedule {
    frequency: string;        // stored posting_frequency label/key/free-text
    days: WeekdayKey[];       // eligible weekdays
    times: string[];          // 'HH:MM' local times
    timezone: string;         // IANA tz id
}

/** Normalise a raw onboarding_context into a usable PostingSchedule, applying defaults. */
export function resolvePostingSchedule(ctx: Record<string, unknown> | null | undefined): PostingSchedule {
    const c = ctx ?? {};
    const rawDays = Array.isArray(c.posting_days) ? (c.posting_days as unknown[]) : [];
    const days = rawDays
        .map(d => String(d).trim().toLowerCase().slice(0, 3))
        .filter((d): d is WeekdayKey => (WEEKDAY_KEYS as readonly string[]).includes(d));

    const rawTimes = Array.isArray(c.posting_times) ? (c.posting_times as unknown[]) : [];
    const times = rawTimes
        .map(t => normaliseTime(t))
        .filter((t): t is string => t !== null);

    return {
        frequency: typeof c.posting_frequency === 'string' && c.posting_frequency.trim()
            ? c.posting_frequency : DEFAULT_POSTING_FREQUENCY,
        days: days.length ? dedupe(days) : DEFAULT_POSTING_DAYS,
        times: times.length ? dedupe(times) : DEFAULT_POSTING_TIMES,
        timezone: typeof c.posting_timezone === 'string' && c.posting_timezone.trim()
            ? c.posting_timezone : DEFAULT_POSTING_TIMEZONE,
    };
}

/** Validate / normalise a 'HH:MM' (24h) string; returns null when unparseable. */
export function normaliseTime(value: unknown): string | null {
    const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function dedupe<T>(arr: T[]): T[] {
    return Array.from(new Set(arr));
}

/** Calendar Y/M/D of an instant as observed in a given IANA timezone. */
function tzCalendarParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
    // en-CA formats as YYYY-MM-DD, which is trivial to split.
    const s = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
    const [year, month, day] = s.split('-').map(Number);
    return { year, month, day };
}

/** The UTC offset (ms) of a timezone at a given instant. utcWall - tzWall. */
function tzOffsetMs(date: Date, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
    // Intl can emit '24' for midnight; clamp to 0.
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
    return asUtc - date.getTime();
}

/** Convert a wall-clock (year, month0, day, hour, minute) in a timezone to the UTC instant. */
function zonedWallTimeToUtc(year: number, month0: number, day: number, hour: number, minute: number, timeZone: string): Date {
    const guessUtc = Date.UTC(year, month0, day, hour, minute, 0);
    const offset = tzOffsetMs(new Date(guessUtc), timeZone);
    return new Date(guessUtc - offset);
}

export interface ComputeSlotsArgs {
    schedule: PostingSchedule;
    horizonDays: number;
    /** Window start (defaults to current time). Only slots strictly after this are returned. */
    now?: Date;
}

/**
 * Ordered list of concrete UTC instants the assistant should publish at across the draft horizon.
 *
 * Builds every candidate slot (eligible weekday × preferred time) inside (now, now + horizonDays],
 * then evenly down-samples to match the cadence's posts-per-week rate. Returns [] for on-demand
 * cadences (postsPerWeek <= 0) — nothing to pre-generate.
 */
export function computeScheduleSlots({ schedule, horizonDays, now = new Date() }: ComputeSlotsArgs): Date[] {
    const perWeek = postsPerWeekFor(schedule.frequency);
    if (perWeek <= 0) return [];

    const horizon = Math.max(1, Math.min(30, Math.round(horizonDays)));
    const tz = schedule.timezone || DEFAULT_POSTING_TIMEZONE;
    const dayset = new Set(schedule.days.length ? schedule.days : DEFAULT_POSTING_DAYS);
    const times = (schedule.times.length ? schedule.times : DEFAULT_POSTING_TIMES).slice().sort();
    const windowEnd = new Date(now.getTime() + horizon * 24 * 60 * 60 * 1000);

    // Build candidate slots: walk each calendar day in the window, keep eligible weekdays, and for
    // each preferred time emit the matching UTC instant inside (now, windowEnd].
    const candidates: Date[] = [];
    const seenDays = new Set<string>();
    for (let offset = 0; offset <= horizon; offset++) {
        const probe = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
        const { year, month, day } = tzCalendarParts(probe, tz);
        const ymd = `${year}-${month}-${day}`;
        if (seenDays.has(ymd)) continue;
        seenDays.add(ymd);

        const weekday = WEEKDAY_KEYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
        if (!dayset.has(weekday)) continue;

        for (const t of times) {
            const [h, m] = t.split(':').map(Number);
            const slot = zonedWallTimeToUtc(year, month - 1, day, h, m, tz);
            if (slot.getTime() > now.getTime() && slot.getTime() <= windowEnd.getTime()) {
                candidates.push(slot);
            }
        }
    }
    candidates.sort((a, b) => a.getTime() - b.getTime());
    if (!candidates.length) return [];

    // Down-sample to the cadence's expected count over the horizon, spread evenly.
    const target = Math.max(1, Math.round((perWeek / 7) * horizon));
    if (target >= candidates.length) return candidates;

    const picked: Date[] = [];
    for (let i = 0; i < target; i++) {
        picked.push(candidates[Math.floor((i * candidates.length) / target)]);
    }
    return picked;
}
