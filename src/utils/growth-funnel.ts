// src/utils/growth-funnel.ts — the growth funnel's arithmetic (Admin → Analytics → Growth funnel).
// Pure: netlify/functions/admin-funnel.ts reads the rows, this turns them into stages and a
// by-source table. Owner request 2026-10-31: visit → sign-up → first assistant hired → first content
// approved → paid, to see which marketing activity is working.
//
// How to read it (the card says the same):
//   · Visits are visit STARTS in the date range (site_visit_counts.entries), from visit-count.js.
//   · Every later stage is a COHORT: accounts created in the range, and whether each has EVER
//     reached that stage — so a recent range looks worse until those accounts have had time.
//   · A sign-up with no known source is "unknown", never folded into "direct" or organic.

export const UNKNOWN_SOURCE = 'unknown';

export interface VisitRow { source: string; entries: number; views: number; }
export interface CohortRow { source: string | null; confirmed: boolean; hired: boolean; approved: boolean; paid: boolean; }

export const STAGES = [
    { key: 'visits', label: 'Visits' },
    { key: 'signups', label: 'Sign-ups' },
    { key: 'confirmed', label: 'Confirmed email' },
    { key: 'hired', label: 'Hired an assistant' },
    { key: 'approved', label: 'Approved first content' },
    { key: 'paid', label: 'Paid' },
] as const;
export type StageKey = typeof STAGES[number]['key'];

export interface Stage { key: StageKey; label: string; count: number; /** % of the stage before (null for the first, or when that was 0). */ fromPrevious: number | null; }
export interface SourceRow { source: string; visits: number; signups: number; confirmed: number; hired: number; approved: number; paid: number; }
export interface Funnel { stages: Stage[]; bySource: SourceRow[]; views: number; }

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function buildFunnel(visits: VisitRow[], cohort: CohortRow[]): Funnel {
    const rows = new Map<string, SourceRow>();
    const row = (source: string) => {
        let r = rows.get(source);
        if (!r) { r = { source, visits: 0, signups: 0, confirmed: 0, hired: 0, approved: 0, paid: 0 }; rows.set(source, r); }
        return r;
    };
    let views = 0;
    for (const v of visits) { row(v.source).visits += Number(v.entries) || 0; views += Number(v.views) || 0; }
    for (const c of cohort) {
        const r = row(c.source || UNKNOWN_SOURCE);
        r.signups++;
        if (c.confirmed) r.confirmed++;
        if (c.hired) r.hired++;
        if (c.approved) r.approved++;
        if (c.paid) r.paid++;
    }
    const all = [...rows.values()];
    const total = (k: keyof Omit<SourceRow, 'source'>) => all.reduce((n, r) => n + r[k], 0);
    const counts: Record<StageKey, number> = {
        visits: total('visits'), signups: total('signups'), confirmed: total('confirmed'),
        hired: total('hired'), approved: total('approved'), paid: total('paid'),
    };
    const stages: Stage[] = STAGES.map((s, i) => ({
        key: s.key, label: s.label, count: counts[s.key],
        fromPrevious: i === 0 ? null : pct(counts[s.key], counts[STAGES[i - 1].key]),
    }));
    const bySource = all.sort((a, b) => b.paid - a.paid || b.signups - a.signups || b.visits - a.visits || a.source.localeCompare(b.source));
    return { stages, bySource, views };
}

/** A YYYY-MM-DD date from a query string, or null. */
export function cleanDay(v: unknown): string | null {
    const s = String(v ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** The report's range: what was asked for, else the last 30 days (UK dates, inclusive). */
export function funnelRange(from: unknown, to: unknown, today: string): { from: string; to: string } {
    const t = cleanDay(to) ?? today;
    const f = cleanDay(from) ?? new Date(Date.parse(`${t}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10);
    return f <= t ? { from: f, to: t } : { from: t, to: f };
}
