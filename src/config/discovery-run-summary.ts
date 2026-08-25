// src/config/discovery-run-summary.ts
// What a finished search actually did, in the words a user would use.
//
// ── Why this exists ──────────────────────────────────────────────────────────
// The completion notification said one thing: "found 14 companies". A paying customer read that,
// counted the addresses, and asked a human "does that seem right?" — which is the whole support
// problem in one sentence. The product knew the answer and did not say it.
//
// Both facts below were ALREADY computed and persisted on `discovery_jobs.cursor` and then used
// by nothing:
//   • stopReason — did we work the whole plan, or stop at a cap? Built after a 175-lead sample of
//     ~4,500 schools presented itself as a finished search.
//   • coverage   — queries run, results resolved, and how many were domains new to this campaign.
//
// ⚠️ THE DISTINCTION THIS FILE EXISTS TO MAKE. "Complete" and "stopped at a cap" are different
// outcomes with different next actions, and a user who cannot tell them apart asks a human. A run
// that ended on `plan_complete` has seen its market; one that ended on `lead_cap` has more to find
// and the fix is one click. Same notification, opposite meaning.
//
// Pure and dependency-free so tests can assert the sentences directly — this is user-facing copy
// and the phrasing IS the feature. docs/lead-generator-completeness-plan.md §3.

/** Mirrors the worker's StopReason. Kept structurally identical, not imported, because that type
 *  lives in a Netlify function and importing across that boundary drags the whole worker in. */
export const STOP_REASONS = [
    'plan_complete', 'lead_cap', 'search_cap', 'cost_cap', 'token_cap', 'month_cap',
] as const;
export type RunStopReason = (typeof STOP_REASONS)[number];

/** Caps a run can hit, as the user set them. Only the ones we quote back are needed. */
export interface RunCaps {
    maxLeadsPerRun: number;
    maxSearchCallsPerRun: number;
    maxLeadsPerMonth: number;
}

export interface RunCoverage {
    /** Searches actually run, across every slice. */
    queriesRun: number;
    /** Candidates that survived resolution and the exclusion filters. */
    resolved: number;
    /** Of those, domains NEW to this campaign — the rest deduped away. */
    inserted: number;
    /** Searches still unrun when the run ended. Absent on runs predating this. */
    remaining?: number;
}

/**
 * The tabs this module is allowed to send a user to, as labelled in
 * `src/components/assistant-dashboard-registry.js`.
 *
 * Exported so the test can assert every branch lands on one of them rather than on a plausible
 * name nobody has ever seen on screen.
 */
export const NAMED_TABS = ['Searches', 'Enrichment', 'Outreach'] as const;

/** `14 companies` / `1 company` / `no companies` — the merge engine has no plural rules. */
export function companiesPhrase(n: number): string {
    if (n <= 0) return 'no companies';
    return n === 1 ? '1 company' : `${n} companies`;
}

/**
 * Did this run finish its plan, or stop early? The single word the whole notification turns on.
 *
 * ⚠️ Only `plan_complete` is "finished". An absent reason is treated as finished too — runs that
 * predate the field, and there is no honest way to claim a cap we have no record of.
 */
export function isComplete(stopReason: RunStopReason | null | undefined): boolean {
    return !stopReason || stopReason === 'plan_complete';
}

/**
 * The outcome sentence: what happened, and what the user does next.
 *
 * ⚠️ EVERY branch names an action AND a REAL TAB. A notification arrives with none of the tab's
 * explanatory copy around it, so it has to name the place the user can actually go — an invariant
 * `tests/signal-inbox.test.ts` has defended on the template copy since this notification shipped.
 * That copy now delegates the call to action to this function, so the guarantee lives here and
 * `tests/discovery-run-summary.test.ts` enforces it on every branch.
 *
 * WHICH tab depends on the outcome, and getting that wrong is worse than naming none: a finished
 * run sends you to Enrichment, where the leads are; a capped or empty one sends you to Searches,
 * where Start and Edit are. See NAMED_TABS below.
 */
export function outcomeSentence(
    stopReason: RunStopReason | null | undefined,
    found: number,
    caps: RunCaps,
): string {
    if (found <= 0) {
        // ⚠️ The zero case used to notify NOBODY — publishSignals returned early on
        // `leadsFound === 0`. A search that found nothing is a result the user is waiting on, and
        // silence reads as "still running" or "broken".
        return isComplete(stopReason)
            // ⚠️ Does NOT repeat "it worked through every search it planned" — coverageSentence()
            // has just said that, and the two run together in one paragraph.
            ? 'Nothing matched, which usually means the description is too narrow. Edit the search on the Searches tab to widen it, or ask your assistant in chat to rewrite it.'
            : 'It stopped before working through its whole plan, so this is not a verdict on your market. Start it again from the Searches tab to carry on.';
    }

    switch (stopReason) {
        case 'lead_cap':
            return `It stopped at your limit of ${caps.maxLeadsPerRun} leads for one run, so there is almost certainly more to find — start it again on the Searches tab to carry on from where it left off.`;
        case 'search_cap':
            return `It stopped at your limit of ${caps.maxSearchCallsPerRun} searches for one run, so part of its plan is still unworked — start it again on the Searches tab to carry on.`;
        case 'cost_cap':
        case 'token_cap':
            return 'It reached this run\'s budget before finishing its plan, so there is more to find — start it again on the Searches tab to carry on.';
        case 'month_cap':
            return `It reached this month's limit of ${caps.maxLeadsPerMonth} leads, so it will pick up again next month — what it already found is waiting on the Searches tab.`;
        case 'plan_complete':
        default:
            // ⚠️ THREE THINGS THIS SENTENCE USED TO GET WRONG, all in nine words: "Approve the ones
            // worth pursuing on the Searches tab and they become leads."
            //
            //  1. "they become leads" — every company a search finds IS a lead the moment it is
            //     scored, whatever it scored. leadGeneratorSurfaces() (chat-orchestrator.ts) holds
            //     the assistant to exactly this: never tell a user their results are waiting to
            //     "become" leads. The notification was contradicting the assistant that sent it.
            //  2. "Approve" — the button is "Move to Outreach". Approving is a SEPARATE act on the
            //     Outreach tab, and telling a user a lead is approved would have them believe an
            //     email is on its way when nothing has been sent.
            //  3. "on the Searches tab" — leads live on the ENRICHMENT tab. The Searches tab's
            //     results view is read-only.
            //
            // ⚠️ Tab names here are USER-FACING NAVIGATION, and they are the labels in
            // assistant-dashboard-registry.js. Renaming a tab without changing this sends users to
            // a tab that is not there — the coupling tests/lead-prompt-surfaces.test.ts already
            // defends for the assistant's own prompt.
            return 'They are already in your Enrichment tab — open it and move the ones worth pursuing to Outreach.';
    }
}

/**
 * The coverage sentence: evidence about whether the run saw the market or a corner of it.
 *
 * ── The newness rate, and why it is the useful half ──────────────────────────
 * A run whose every result is a domain we have never seen is nowhere near exhausting its market;
 * one returning mostly duplicates is close to saturating it. That is the difference between
 * "run it again" and "widen the description", and the user cannot infer it from a lead count.
 *
 * Returns '' when there is nothing honest to say — a run with no coverage record predates the
 * field, and inventing a confident sentence from absent data is the failure this whole plan is
 * about.
 */
export function coverageSentence(coverage: RunCoverage | null | undefined): string {
    if (!coverage || coverage.queriesRun <= 0) return '';

    const searches = coverage.queriesRun === 1 ? '1 search' : `${coverage.queriesRun} searches`;
    const planned = typeof coverage.remaining === 'number' && coverage.remaining > 0
        ? `${searches} of the ${coverage.queriesRun + coverage.remaining} it planned`
        : `all ${searches} it planned`;

    if (coverage.resolved <= 0) return `It ran ${planned}.`;

    const results = coverage.resolved === 1 ? '1 result' : `${coverage.resolved} results`;
    const rate = coverage.inserted / coverage.resolved;
    // ⚠️ Bands, not a percentage. "38% newness" is a number the user has to interpret; the whole
    // point is to hand them the interpretation, since it is the thing that decides their next move.
    // ⚠️ "results", never "companies". This rate counts DOMAINS resolved against domains already
    // on file — not leads qualified. Beside "found no companies matching your criteria", the word
    // "companies" here read as a flat contradiction: nothing matched, yet we had "already found"
    // most of them. Both were true of different things, which is exactly the sentence a user
    // brings to support.
    const reading =
        rate >= 0.5 ? ' — most were sites it had not seen before, so there is likely more of this market left to find'
        : rate <= 0.2 ? ' — most were sites it had already seen, so this search is close to exhausting its market and widening the description will do more than running it again'
        : '';

    return `It ran ${planned} and read ${results}${reading}.`;
}
