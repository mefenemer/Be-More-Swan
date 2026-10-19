// src/utils/partner-rate-periods.ts
// Affiliate Partner Programme — the rules for dated commission rates (docs/affiliate-partner-programme-plan.md §4.1).
//
// A rate period has a start and (optionally) an end. A partner's referred customer gets the rate of
// the period covering the moment they FIRST PAY, and keeps it for their whole commission window —
// the terms are copied onto partner_referrals, so later edits never change a promise already made.
//
// The database only checks shapes (db/z-affiliate-partners.sql). Everything that needs to look at
// more than one row lives here, and every write path (admin GUI and chat) must call
// validatePeriodChanges before saving:
//   - no two periods in the same scope (programme-wide, or one partner) overlap;
//   - programme-wide periods have no gaps, and the latest is open-ended — some programme rate
//     always applies, so a customer can never land on "no rate";
//   - once a period has started its rate, duration and start are frozen and it cannot be deleted;
//     only its end date may move, and never into the past.
//
// Pure functions, no DB — the caller loads the periods and passes them in.

/** A period as stored (partner_rate_periods). partnerId null = programme-wide. */
export interface RatePeriod {
    id: number;
    partnerId: number | null;
    rateBps: number;              // 2500 = 25%
    durationMonths: number | null; // null = lifetime
    startsAt: Date;
    endsAt: Date | null;          // null = open-ended; exclusive
}

/** The terms copied onto partner_referrals when the customer first pays. */
export interface LockedTerms {
    ratePeriodId: number;
    rateBps: number;
    durationMonths: number | null;
}

/** A proposed change: create (no id), edit (id + fields), or delete. */
export type PeriodChange =
    | { op: 'create'; period: Omit<RatePeriod, 'id'> }
    | { op: 'update'; id: number; period: Omit<RatePeriod, 'id'> }
    | { op: 'delete'; id: number };

export const MAX_RATE_BPS = 10000;
export const MAX_DURATION_MONTHS = 120;

function covers(p: RatePeriod, at: Date): boolean {
    const t = at.getTime();
    return p.startsAt.getTime() <= t && (p.endsAt === null || t < p.endsAt.getTime());
}

function sameScope(a: { partnerId: number | null }, b: { partnerId: number | null }): boolean {
    return (a.partnerId ?? null) === (b.partnerId ?? null);
}

/**
 * The period that applies to a customer of `partnerId` who first pays at `at`: that partner's own
 * period if one covers the moment, otherwise the programme-wide one. Null only if the programme
 * has a gap — which validatePeriodChanges prevents.
 */
export function resolvePeriodAt(periods: RatePeriod[], partnerId: number, at: Date): RatePeriod | null {
    return periods.find((p) => p.partnerId === partnerId && covers(p, at))
        ?? periods.find((p) => p.partnerId === null && covers(p, at))
        ?? null;
}

export function lockTerms(period: RatePeriod): LockedTerms {
    return { ratePeriodId: period.id, rateBps: period.rateBps, durationMonths: period.durationMonths };
}

/** Calendar months later, in UTC, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonthsUtc(from: Date, months: number): Date {
    const y = from.getUTCFullYear();
    const m = from.getUTCMonth() + months;
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = new Date(from.getTime());
    d.setUTCFullYear(y, m, Math.min(from.getUTCDate(), lastDay));
    return d;
}

/** Does a payment at `paidAt` still earn commission under the locked terms? */
export function isWithinCommissionWindow(subscribedAt: Date, durationMonths: number | null, paidAt: Date): boolean {
    if (paidAt.getTime() < subscribedAt.getTime()) return false;
    if (durationMonths === null) return true;
    return paidAt.getTime() < addMonthsUtc(subscribedAt, durationMonths).getTime();
}

/** Commission on a payment excluding VAT. Rounded DOWN to the penny. */
export function commissionPence(netAmountPence: number, rateBps: number): number {
    if (netAmountPence <= 0 || rateBps <= 0) return 0;
    return Math.floor((netAmountPence * rateBps) / MAX_RATE_BPS);
}

function shapeErrors(p: Omit<RatePeriod, 'id'>): string[] {
    const errors: string[] = [];
    if (!Number.isInteger(p.rateBps) || p.rateBps < 0 || p.rateBps > MAX_RATE_BPS) {
        errors.push('The rate must be between 0% and 100%.');
    }
    if (p.durationMonths !== null
        && (!Number.isInteger(p.durationMonths) || p.durationMonths < 1 || p.durationMonths > MAX_DURATION_MONTHS)) {
        errors.push(`The commission length must be 1–${MAX_DURATION_MONTHS} months, or lifetime.`);
    }
    if (Number.isNaN(p.startsAt.getTime()) || (p.endsAt && Number.isNaN(p.endsAt.getTime()))) {
        errors.push('The dates are not valid.');
    } else if (p.endsAt && p.endsAt.getTime() <= p.startsAt.getTime()) {
        errors.push('The end date must be after the start date.');
    }
    return errors;
}

function overlaps(a: Omit<RatePeriod, 'id'>, b: Omit<RatePeriod, 'id'>): boolean {
    const aEnd = a.endsAt?.getTime() ?? Infinity;
    const bEnd = b.endsAt?.getTime() ?? Infinity;
    return a.startsAt.getTime() < bEnd && b.startsAt.getTime() < aEnd;
}

/**
 * Check one or more changes, applied together, against the current periods. Returns the problems
 * in plain words — empty when allowed. Changes are checked as ONE edit, so "end the current rate
 * and start a new one from the same moment" passes, where either half alone would leave a gap.
 * `now` is injectable for tests.
 */
export function validatePeriodChanges(existing: RatePeriod[], changes: PeriodChange[], now: Date = new Date()): string[] {
    const nowMs = now.getTime();
    const errors: string[] = [];
    // Working copy keyed by id; new periods get negative ids.
    const state = new Map<number, Omit<RatePeriod, 'id'>>(existing.map((p) => [p.id, p]));
    const touchedScopes = new Set<number | null>();
    let nextNewId = -1;

    for (const change of changes) {
        const current = change.op === 'create' ? undefined : existing.find((p) => p.id === change.id);
        if (change.op !== 'create' && (!current || !state.has(change.id))) {
            errors.push('That rate period no longer exists.');
            continue;
        }
        const started = current ? current.startsAt.getTime() <= nowMs : false;

        if (change.op === 'delete') {
            if (started) errors.push('A period that has already started cannot be deleted — end it instead.');
            touchedScopes.add(current!.partnerId ?? null);
            state.delete(change.id);
            continue;
        }

        const next = change.period;
        errors.push(...shapeErrors(next));
        if (current && !sameScope(current, next)) errors.push('A period cannot be moved between partners.');
        if (current && started) {
            if (next.rateBps !== current.rateBps || next.durationMonths !== current.durationMonths) {
                errors.push('This period has started, so its rate and length are fixed — end it and add a new period instead.');
            }
            if (next.startsAt.getTime() !== current.startsAt.getTime()) {
                errors.push('This period has started, so its start date is fixed.');
            }
        }
        // Ending (or re-ending) a period in the past would rewrite which rate applied to customers
        // who already subscribed. An end date that is already past and left untouched is fine.
        const endChanged = (next.endsAt?.getTime() ?? null) !== (current?.endsAt?.getTime() ?? null);
        if (next.endsAt && endChanged && next.endsAt.getTime() < nowMs) {
            errors.push('The end date cannot be in the past.');
        }
        if (!current && next.startsAt.getTime() < nowMs - 60_000) {
            errors.push('A new period cannot start in the past.');
        }
        touchedScopes.add(next.partnerId ?? null);
        state.set(change.op === 'create' ? nextNewId-- : change.id, next);
    }
    if (errors.length) return [...new Set(errors)];

    for (const scope of touchedScopes) {
        const inScope = [...state.values()].filter((p) => (p.partnerId ?? null) === scope);
        for (let i = 0; i < inScope.length; i++) {
            for (let j = i + 1; j < inScope.length; j++) {
                if (overlaps(inScope[i], inScope[j])) return ['That would overlap another rate period for the same scope.'];
            }
        }
        if (scope !== null) continue;
        const sorted = inScope.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
        if (sorted.length === 0) return ['The programme must always have a rate.'];
        for (let i = 0; i < sorted.length - 1; i++) {
            if (sorted[i].endsAt?.getTime() !== sorted[i + 1].startsAt.getTime()) {
                return ['Programme rates must follow on from each other with no gap.'];
            }
        }
        if (sorted[sorted.length - 1].endsAt !== null) {
            return ['The latest programme rate must have no end date, so a rate always applies.'];
        }
    }
    return [];
}

/**
 * Midnight UK time on a calendar date ('2026-12-01'), as the UTC instant stored in the database.
 * Admins pick dates, not instants: "from 1 December" means from the start of the UK day, in GMT
 * or BST. Null for anything that is not a real YYYY-MM-DD date.
 */
export function ukMidnightUtc(date: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const guess = Date.UTC(y, mo - 1, d);
    const check = new Date(guess);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    // London's offset from UTC at that moment, read back through Intl (0 in GMT, +1h in BST).
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(check).map((p) => [p.type, p.value]));
    const londonAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return new Date(guess - (londonAsUtc - guess));
}
