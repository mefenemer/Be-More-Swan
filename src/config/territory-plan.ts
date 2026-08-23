// src/config/territory-plan.ts
// A campaign's standing plan to work an area territory by territory, ACROSS runs.
//
// ── Why a campaign needs memory ──────────────────────────────────────────────
// Splitting South East England into 58 districts produces ~174 queries. No single run executes
// that: a run stops at its lead cap, its search budget or its token budget, and the next run
// previously started again from a freshly generated plan — so the same handful of territories got
// worked repeatedly and the rest never got looked at once. A market of 4,530 schools was not out
// of reach because searching cannot find them; it was out of reach because nothing remembered
// where the last run had got to.
//
// This is that memory. It lives on `discovery_campaigns.approved_brief` (jsonb, no migration —
// same reasoning as the coverage tally on discovery_jobs.cursor) and answers one question: which
// territories has this campaign already worked, and which is it doing next.
//
// ⚠️ `templates` are the queries BEFORE expansion — one per strategy, as the user reviewed them.
// Storing the expanded set instead would be storing an answer rather than a method: continuing
// into Maidstone needs the shape of the question, not the copy of it that named Ashford.

import type { SplitGranularity } from '../lib/territory-split';

export interface TerritoryPlan {
    area: string;
    basis: string;
    granularity: SplitGranularity;
    /**
     * The level ABOVE the territories — see TerritorySplit.parents.
     *
     * ⚠️ Stored, not recomputed. Later runs expand the same county-level templates across new
     * districts, so they need the same vocabulary the first run had. Without it a continuation run
     * reproduces exactly the bug the first run avoided.
     */
    parents: string[];
    /** Every territory the split produced, in the order it produced them. */
    territories: string[];
    /** Those already worked by a completed run. */
    covered: string[];
    /** The pre-expansion query for each strategy, as approved. */
    templates: { niche_scrape: string | null; intent_signal: string | null; footprint: string | null };
}

/** Territories not yet worked, in plan order. */
export function remainingTerritories(plan: TerritoryPlan): string[] {
    const done = new Set(plan.covered.map((t) => t.toLowerCase()));
    return plan.territories.filter((t) => !done.has(t.toLowerCase()));
}

/**
 * How many territories the next run should take on.
 *
 * ⚠️ Derived from the run's own search budget, not a fixed number. A territory costs one search per
 * template, plus whatever depth its pages earn — so the honest estimate is
 * `templates x maxPages`. Taking a fixed ten would either waste a large budget or overcommit a
 * small one, and overcommitting is the worse failure: a run that stops a third of the way through
 * its slice marks nothing covered and repeats the same ground next time.
 *
 * Deliberately conservative at 80% of the budget. The remainder absorbs pagination that runs hotter
 * than expected, so a slice finishes rather than being cut off mid-territory.
 */
export function nextSlice(plan: TerritoryPlan, opts: { maxSearchCalls: number; maxPagesPerQuery: number }): string[] {
    const remaining = remainingTerritories(plan);
    if (remaining.length === 0) return [];

    const templates = [plan.templates.niche_scrape, plan.templates.intent_signal, plan.templates.footprint]
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0).length;
    if (templates === 0) return [];

    const searchesPerTerritory = templates * Math.max(1, opts.maxPagesPerQuery);
    const affordable = Math.floor((opts.maxSearchCalls * 0.8) / searchesPerTerritory);
    // Always at least one: a budget too small for a whole territory should still make progress
    // rather than stall the campaign forever.
    return remaining.slice(0, Math.max(1, affordable));
}

/**
 * Which territories in this run's slice were actually WORKED.
 *
 * ⚠️ This exists because gating progress on "the whole plan finished" does not survive contact with
 * a lead cap. A district sweep plans ~99 queries per run, and a 200-lead cap stops it around the
 * 44th — so `plan_complete` never fires, nothing is ever banked, and the sweep repeats its first
 * territories forever while the rest are never reached. The bug is not the cap; it is treating a
 * partly-worked slice as no progress at all.
 *
 * A territory counts as worked when every BASE query naming it has run. Pages earned by
 * pagination are ignored on purpose: they are appended after the plan, so a territory whose first
 * page ran and whose second did not has still been searched — and refusing to bank it would stall
 * the sweep for the same reason as before, just later.
 *
 * Conservative in the other direction too: a territory whose queries are still ahead of the cursor
 * is NOT banked, so ground nobody searched is never retired.
 */
export function territoriesWorked(
    flat: ReadonlyArray<{ query: string; page?: number }>,
    queriesRun: number,
    slice: readonly string[],
): string[] {
    const names = (q: string, t: string) => new RegExp(`(?<![\\w-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(q);
    return slice.filter((t) => {
        const base = flat
            .map((e, i) => ({ ...e, i }))
            .filter((e) => (e.page ?? 1) === 1 && names(e.query, t));
        // A territory with no base query of its own cannot be judged, so it is not banked.
        return base.length > 0 && base.every((e) => e.i < queriesRun);
    });
}

/** Shape-check a plan read back off the jsonb column. Returns null for anything unusable. */
export function readTerritoryPlan(brief: unknown): TerritoryPlan | null {
    if (!brief || typeof brief !== 'object') return null;
    const p = (brief as Record<string, unknown>).territoryPlan;
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    const strs = (v: unknown): string[] => Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 80))
        : [];
    const territories = strs(o.territories);
    if (territories.length < 2) return null;
    const parents = strs(o.parents);
    const t = (o.templates && typeof o.templates === 'object') ? o.templates as Record<string, unknown> : {};
    const q = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;
    return {
        area: typeof o.area === 'string' ? o.area.slice(0, 120) : '',
        basis: typeof o.basis === 'string' ? o.basis.slice(0, 120) : '',
        granularity: o.granularity === 'fine' ? 'fine' : 'coarse',
        parents,
        territories,
        covered: strs(o.covered),
        templates: { niche_scrape: q(t.niche_scrape), intent_signal: q(t.intent_signal), footprint: q(t.footprint) },
    };
}
