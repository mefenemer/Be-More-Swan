// src/config/lead-why-now.ts
// "Why now": the dated reason to contact a lead now, kept apart from how well it fits.
// docs/lead-why-now-and-watching-plan.md, Phase 1.
//
// ── What this is ─────────────────────────────────────────────────────────────
// The research pass (src/lib/lead-intel.ts → discovery-scoring.ts rescoreWithIntel) already finds
// funding, hiring and expansion news with a link. Until now that was blended into one fit score,
// and nothing said WHEN it happened. This file holds the three rules that turn it into a reason
// with a date:
//
//   1. resolveWhyNow — the guard. The model may only POINT at a piece of evidence we gathered; the
//      date is read from that evidence, never from the model. No matching evidence, or evidence
//      with no date we can read → no Why now. Same idea as verifyPeople in lead-enrichment.ts: an
//      undated page is not a reason to contact anyone NOW.
//   2. parseEvidenceDate — the provider's own date string ("3 days ago", "14 Aug 2026") resolved
//      against WHEN WE READ IT. Kept relative, "3 days ago" would be wrong the day after it was
//      stored; resolved against gatheredAt it stays right for ever.
//   3. whyNowState — how a reason fades. Stored: the evidence date. Worked out when read: fresh up
//      to 30 days, cooling to 90, gone after. A stored "fresh" flag would be wrong a month later.
//
// ⚠️ ONE SOURCE. The Leads table and the lead panel run whyNowState/whyNowAgeLabel through the
// generated mirror (window.LeadWhyNow, scripts/gen-client-constants.ts), and the chat's lead
// snapshot imports them directly, so the table and the chat can never disagree about whether a
// reason is still fresh. The mirrored functions are emitted with .toString(): they must stay
// self-contained (no imports, no module-level helpers beyond the constants the generator
// re-declares under the same names).
//
// Pure: no imports, no I/O.

/** A reason this recent is shown as fresh. */
export const WHY_NOW_FRESH_DAYS = 30;
/** After this a reason is history, not a reason: no Why now is shown (it stays in the findings). */
export const WHY_NOW_GONE_DAYS = 90;
/** With no dated reason, the timing score is capped here: whatever the model felt, nothing on file says "now". */
export const WHY_NOW_UNDATED_TIMING_CAP = 30;

export type WhyNowState = 'fresh' | 'cooling' | 'gone' | 'none' | 'not_checked';

/** What the table's filter and group-by show for each state. Ordered as the column sorts. */
export const WHY_NOW_STATE_LABELS: Record<WhyNowState, string> = {
    fresh: 'Reason now',
    cooling: 'Cooling off',
    gone: 'No recent reason',
    none: 'No recent reason',
    not_checked: 'Not checked',
};

/** What we store on `data.intel.whyNow`. */
export interface StoredWhyNow {
    summary: string;
    url: string;
    /** YYYY-MM-DD, from the evidence, resolved against when we read it. */
    date: string;
}

export interface WhyNowView {
    state: WhyNowState;
    summary: string | null;
    url: string | null;
    date: string | null;
    /** Whole days since the evidence date; null when there is no reason. */
    ageDays: number | null;
}

const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function validDay(y: number, m: number, d: number): Date | null {
    if (!Number.isFinite(y) || y < 1990 || y > 2100 || m < 0 || m > 11 || d < 1 || d > 31) return null;
    const out = new Date(Date.UTC(y, m, d));
    // 31 Feb rolls into March in JS; a date that rolled is a date that was not real.
    return out.getUTCMonth() === m ? out : null;
}

/**
 * The provider's date string as a calendar day, or null when we cannot read it with confidence.
 *
 * Reads what Serper actually returns: "3 days ago", "1 week ago", "2 months ago", "yesterday",
 * "14 Aug 2026", "Aug 14, 2026", "14 August 2026", "2026-08-14". Anything else → null, which means
 * "no Why now", never a guess. Slash dates are refused on purpose: 04/08/2026 is April in the US
 * and August in the UK, and this product serves both.
 *
 * Relative dates resolve against `gatheredAt` (when the research ran). Months and years are
 * approximate (30 / 365 days); the fade bands are a month wide, so that is precise enough.
 */
export function parseEvidenceDate(raw: string | null | undefined, gatheredAt: string | Date): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;
    const base = gatheredAt instanceof Date ? gatheredAt : new Date(gatheredAt);
    if (Number.isNaN(base.getTime())) return null;
    const day = 86400000;

    if (s === 'today' || s === 'just now') return ymd(base);
    if (s === 'yesterday') return ymd(new Date(base.getTime() - day));

    const rel = /^(\d{1,3}|an?|one) (minute|min|hour|hr|day|week|month|year)s? ago$/.exec(s);
    if (rel) {
        const n = /^\d/.test(rel[1]) ? Number(rel[1]) : 1;
        const unitDays: Record<string, number> = { minute: 0, min: 0, hour: 0, hr: 0, day: 1, week: 7, month: 30, year: 365 };
        return ymd(new Date(base.getTime() - n * unitDays[rel[2]] * day));
    }

    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (iso) {
        const d = validDay(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
        return d ? ymd(d) : null;
    }

    // "14 aug 2026" / "14 august, 2026"
    const dmy = /^(\d{1,2}) ([a-z]{3,9})\.?,? (\d{4})$/.exec(s);
    if (dmy && MONTHS[dmy[2].slice(0, 3)] !== undefined) {
        const d = validDay(Number(dmy[3]), MONTHS[dmy[2].slice(0, 3)], Number(dmy[1]));
        return d ? ymd(d) : null;
    }
    // "aug 14, 2026" / "august 14 2026"
    const mdy = /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
    if (mdy && MONTHS[mdy[1].slice(0, 3)] !== undefined) {
        const d = validDay(Number(mdy[3]), MONTHS[mdy[1].slice(0, 3)], Number(mdy[2]));
        return d ? ymd(d) : null;
    }
    return null;
}

/** One piece of evidence, as far as dating goes. */
export interface DatableEvidence {
    url: string;
    date: string | null;
}

/**
 * THE GUARD. The model's Why now, kept only if it points at evidence we gathered AND that evidence
 * has a date we can read, which may not be in the future. The date comes from the evidence.
 */
export function resolveWhyNow(
    raw: unknown,
    evidence: DatableEvidence[],
    gatheredAt: string | Date,
): StoredWhyNow | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const summary = typeof r.summary === 'string' ? r.summary.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!summary || !url) return null;
    const ev = evidence.find((e) => e.url === url);
    if (!ev) return null;
    const date = parseEvidenceDate(ev.date, gatheredAt);
    if (!date) return null;
    const base = gatheredAt instanceof Date ? gatheredAt : new Date(gatheredAt);
    // A day of slack for time zones; beyond that a "future" date is a misread, not news.
    if (Date.parse(`${date}T00:00:00Z`) > base.getTime() + 86400000) return null;
    return { summary, url, date };
}

/** Each signal with the date of the evidence it points at (or null). Never the model's date. */
export function dateSignals<T extends { url: string }>(
    signals: T[],
    evidence: DatableEvidence[],
    gatheredAt: string | Date,
): Array<T & { date: string | null }> {
    return signals.map((s) => {
        const ev = evidence.find((e) => e.url === s.url);
        return { ...s, date: ev ? parseEvidenceDate(ev.date, gatheredAt) : null };
    });
}

/** The timing score as stored: 0–100, capped when no dated reason survived the guard. */
export function clampTiming(raw: unknown, whyNow: StoredWhyNow | null): number | null {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return null;
    const t = Math.max(0, Math.min(100, Math.round(n)));
    return whyNow ? t : Math.min(t, WHY_NOW_UNDATED_TIMING_CAP);
}

// ── Mirrored to the browser (window.LeadWhyNow) — keep self-contained ─────────

/**
 * Where a lead's Why now stands today.
 *
 *   not_checked — never researched, or researched before Why now existed (no `whyNow` key).
 *   none        — researched, and no dated reason was found.
 *   fresh / cooling / gone — a reason, by how old its evidence is.
 */
export function whyNowState(intel: unknown, now?: number): WhyNowView {
    // ⚠️ No nested functions: the build names them with a helper (__name) that does not exist in
    // the browser copy, and the mirror then throws on first use.
    var FRESH = WHY_NOW_FRESH_DAYS;
    var GONE = WHY_NOW_GONE_DAYS;
    var NOT_CHECKED: WhyNowView = { state: 'not_checked', summary: null, url: null, date: null, ageDays: null };
    var NONE: WhyNowView = { state: 'none', summary: null, url: null, date: null, ageDays: null };
    if (!intel || typeof intel !== 'object' || Array.isArray(intel)) return NOT_CHECKED;
    var rec = intel as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(rec, 'whyNow')) return NOT_CHECKED;
    var w = rec.whyNow as Record<string, unknown> | null;
    if (!w || typeof w !== 'object') return NONE;
    var summary = typeof w.summary === 'string' ? w.summary : '';
    var url = typeof w.url === 'string' ? w.url : '';
    var date = typeof w.date === 'string' ? w.date : '';
    var t = Date.parse(date + 'T00:00:00Z');
    if (!summary || !url || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(t)) return NONE;
    var nowMs = typeof now === 'number' ? now : Date.now();
    var age = Math.max(0, Math.floor((nowMs - t) / 86400000));
    var state: WhyNowState = age <= FRESH ? 'fresh' : age <= GONE ? 'cooling' : 'gone';
    return { state: state, summary: summary, url: url, date: date, ageDays: age };
}

/** "today" / "yesterday" / "5 days ago" / "3 weeks ago" / "2 months ago". Dates never shown as 04/08. */
export function whyNowAgeLabel(days: number | null): string {
    if (days === null || days === undefined || !isFinite(days) || days < 0) return '';
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return days + ' days ago';
    if (days < 60) return Math.floor(days / 7) + ' weeks ago';
    var months = Math.round(days / 30);
    return months <= 1 ? '1 month ago' : months + ' months ago';
}

/** Sort rank: fresh first, then cooling, then everything else. Lower sorts first. */
export function whyNowRank(view: WhyNowView): number {
    var base = view.state === 'fresh' ? 0 : view.state === 'cooling' ? 1 : view.state === 'gone' || view.state === 'none' ? 2 : 3;
    // Within a band, the newer reason first.
    return base * 100000 + (view.ageDays === null ? 99999 : view.ageDays);
}
