// src/config/plan-reach.ts
// How much of a market one discovery run can actually see — computed, before a penny is spent.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// A campaign for "primary schools in south east England" banked 175 leads against a market of
// roughly 4,500 schools, and nothing in the product ever said so. Tier 1 fixed the report AFTER a
// run (src/components/assistant-discovery-campaigns.js `coverageLine`). This is the same fact moved
// to where it is still actionable: the brief-approval screen, where the user is already reading the
// queries and deciding whether to spend.
//
// ⚠️ Everything here is ARITHMETIC on values we control — query count, results per query, the
// user's own guardrails. Nothing is estimated, inferred or asked of a model, because the number
// that matters ("this plan can read at most N results") is exactly knowable and a guess would be
// worse than useless: a confident wrong ceiling is what the product was already shipping.
//
// The separate question of how big the MARKET is cannot be answered this way and deliberately is
// not attempted here — see src/lib/market-enumerability.ts, which is advisory and fails soft.

/**
 * Results requested per search.
 *
 * ⚠️ THE binding constraint on coverage, and it is ours, not the provider's. Serper is sent
 * `num: limit`; its `page` parameter is not used at all, so nothing paginates. Raising this (and
 * the clamp in src/lib/discovery-search.ts, currently 20) is the cheapest lever on reach that
 * exists — which is precisely why it belongs somewhere visible rather than buried as a private
 * const in the worker, where it sat while coverage was being debated.
 */
export const RESULTS_PER_QUERY = Number(process.env.DISCOVERY_RESULTS_PER_QUERY ?? '10');

/**
 * How many pages deep a single query may go — but only while it keeps paying (see YIELD_TO_PAGINATE).
 *
 * ⚠️ Depth is spent ADAPTIVELY, never planned up front. Planning 5 pages for all 15 queries would
 * be 75 searches whether or not any of them found anything, and most queries exhaust themselves on
 * page 1. Spending a page only after the previous one proved productive is what makes deeper
 * coverage affordable at all.
 */
export const MAX_PAGES_PER_QUERY = Number(process.env.DISCOVERY_MAX_PAGES_PER_QUERY ?? '4');

/**
 * The share of a page's results that must be NEW domains for the next page to be worth buying.
 *
 * At 0.5, a page where half of what we saw was already on the list is where we stop. Below that
 * threshold we are paying full price to re-read the same companies — the saturation signal Tier 1
 * surfaces after the fact, used here to decide spending during the run.
 */
export const YIELD_TO_PAGINATE = 0.5;

export interface PlanLimits {
    maxLeadsPerRun: number;
    maxSearchCallsPerRun: number;
    maxLeadsPerMonth: number;
    /** Leads already banked by this campaign this month, if known. */
    leadsThisMonth?: number;
}

export interface PlanReach {
    /** Queries in the plan as it stands on screen. */
    queries: number;
    /** Of those, how many the per-run search cap allows to actually run. */
    searchesThatWillRun: number;
    /**
     * Searches if EVERY query stays productive enough to earn its full depth.
     *
     * ⚠️ Reported as a range with the figure above, never as a single number. A productive query
     * buys its next page (MAX_PAGES_PER_QUERY), so a plan of 15 can become 60 — quoting only the
     * floor would understate reach by 4x, and quoting only the ceiling would promise depth that a
     * saturated market never earns.
     */
    searchesIfAllProductive: number;
    /** Upper bound on web results this run can read. Not leads — results. */
    maxResultsRead: number;
    /** The same bound if every query earns its full depth. */
    maxResultsReadIfAllProductive: number;
    /** Upper bound on leads it can bank, after every cap is applied. */
    maxLeadsBanked: number;
    /** Which limit bites first, or null when the plan fits inside all of them. */
    bindingLimit: 'search_cap' | 'lead_cap' | 'month_cap' | null;
}

/**
 * What this plan can reach, before it runs.
 *
 * ⚠️ Order matters: the search cap decides how many queries run, which decides how many results
 * are read, which bounds the leads. Applying the lead caps first would report a plan reading 150
 * results when its search cap only ever allowed 30.
 */
export function computePlanReach(queries: number, limits: PlanLimits): PlanReach {
    const q = Math.max(0, Math.floor(queries));
    const searchesThatWillRun = Math.min(q, Math.max(0, limits.maxSearchCallsPerRun));
    const maxResultsRead = searchesThatWillRun * RESULTS_PER_QUERY;

    // Depth is still bounded by the same per-run search cap — a query earning its fourth page
    // spends a search like any other, so this cannot exceed the ceiling the user set.
    const searchesIfAllProductive = Math.min(q * MAX_PAGES_PER_QUERY, Math.max(0, limits.maxSearchCallsPerRun));
    const maxResultsReadIfAllProductive = searchesIfAllProductive * RESULTS_PER_QUERY;

    // A lead needs a result to come from, so results are a real ceiling on leads — usually a much
    // looser one than the caps, since most results dedupe or get filtered out before insert.
    const monthRemaining = Math.max(0, limits.maxLeadsPerMonth - (limits.leadsThisMonth ?? 0));
    // Against the DEEP figure: a lead cap that only bites once depth is earned still bites, and
    // reporting it against the shallow number would tell the user a cap will not affect them when
    // in practice it is the thing that ends their run.
    const maxLeadsBanked = Math.min(maxResultsReadIfAllProductive, limits.maxLeadsPerRun, monthRemaining);

    let bindingLimit: PlanReach['bindingLimit'] = null;
    if (monthRemaining <= maxResultsReadIfAllProductive && monthRemaining <= limits.maxLeadsPerRun) bindingLimit = 'month_cap';
    else if (limits.maxLeadsPerRun <= maxResultsReadIfAllProductive) bindingLimit = 'lead_cap';
    else if (searchesIfAllProductive < q * MAX_PAGES_PER_QUERY) bindingLimit = 'search_cap';

    return {
        queries: q, searchesThatWillRun, searchesIfAllProductive,
        maxResultsRead, maxResultsReadIfAllProductive, maxLeadsBanked, bindingLimit,
    };
}
