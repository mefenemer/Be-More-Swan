// src/config/revenue-events.ts
// The revenue ledger's vocabulary — the SINGLE source of truth for event types, actors and
// loss reasons. Imported by src/utils/revenue-ledger.ts (the only writer) and by every reader.
//
// Design: docs/lead-generator-revenue-engine-plan.md §3 (Phase 0 — the outcome ledger).
//
// ── Why the vocabularies are CLOSED ──────────────────────────────────────────
// `revenue_events` exists so the Strategy Agent (Phase 5) can attribute outcomes to the strategy
// that produced them and pivot the ICP. That only works if outcomes are CLUSTERABLE: free-text
// loss reasons cannot be grouped, so a "why are we losing?" aggregate over them degenerates into
// asking a model to summarise prose. Every value here is therefore an enum, mirrored by a CHECK
// constraint in db/revenue-events.sql.
//
// ⚠️ Adding a value means changing BOTH this file AND the CHECK constraint in the SQL (and the
// matching check() in db/schema.ts). tests/revenue-ledger.test.ts asserts the three stay in sync —
// if you add one here and nowhere else, that test fails on purpose.

/** Everything that can happen to a lead, in rough funnel order. */
export const EVENT_TYPES = [
    // ── Acquisition ──────────────────────────────────────────────────────────
    'signal_captured',      // an inbound signal (social engagement, or a saved-search hit)
    'lead_discovered',      // a discovery run surfaced a candidate that survived filtering
    'lead_enriched',        // a contact address was found for it
    'lead_scored',          // scored against the ICP; payload carries score + rating
    // ── Qualification (the human gate) ───────────────────────────────────────
    'lead_approved',
    'lead_rejected',
    // A human overruled a do-not-contact verdict for one lead. Its own event, not a flavour of
    // lead_approved: "how often is the compliance gate being bypassed, and why?" must be answerable
    // with a GROUP BY, and it should be conspicuous if that number ever climbs.
    'do_not_contact_overridden',
    // ── Engagement ───────────────────────────────────────────────────────────
    // `outreach_sent` covers BOTH the opening email and every sequence follow-up — payload carries
    // `sequenceStep` (absent/0 on the opener). Deliberately not split into a separate
    // 'follow_up_sent': the question "how many emails did we send this lead?" should not require
    // knowing to union two event types, and db/revenue-events.sql already anticipates several
    // outreach_sent rows per lead.
    'outreach_sent',
    'outreach_bounced',
    'reply_received',
    'reply_classified',
    // A HUMAN answered a prospect from the Conversations tab (netlify/functions/lead-threads.ts
    // `reply`).
    //
    // ⚠️ Deliberately NOT a flavour of `outreach_sent`, and this is the one distinction in this list
    // that protects a headline metric. Reply rate is replies ÷ leads WE emailed; folding a tenant's
    // own answers into the denominator would let them raise their reply rate by replying, and would
    // file a human's words in the Activity feed as something the assistant did. It is also not an
    // engagement event about the prospect — they had already engaged, which is why we are writing.
    'manual_reply_sent',
    // The prospect asked us to stop. Its own event, not a flavour of reply_received: opt-out RATE
    // is the health metric that says targeting or copy is wrong, and it has to be answerable
    // without parsing message bodies after the fact.
    'opt_out_received',
    // ── Sequencing (Phase 2b) — lifecycle, not sends ─────────────────────────
    // These answer "did the cadence run, and why did it stop?". `sequence_halted` carries the
    // closed haltReason vocabulary in its payload, so the Strategy Agent can GROUP BY it to see
    // whether a cadence is being cut short by replies (good) or by suppression and bounces (bad).
    'sequence_enrolled',
    'sequence_halted',
    'sequence_completed',
    // ── Closing ──────────────────────────────────────────────────────────────
    'objection_raised',
    'objection_handled',
    'meeting_booked',
    'quote_sent',
    'negotiation_opened',
    'negotiation_conceded',
    'payment_link_sent',
    // ── Terminal ─────────────────────────────────────────────────────────────
    'deal_won',
    'deal_lost',
    'deal_disqualified',
] as const;

export type RevenueEventType = typeof EVENT_TYPES[number];

/**
 * The three terminal events. `outcome` is non-NULL on exactly these and NULL on every other
 * event — the partial index `revenue_events_outcome_idx` depends on that being true, and the
 * Strategy Agent's win-rate aggregate reads only these rows.
 */
export const TERMINAL_EVENT_TYPES = ['deal_won', 'deal_lost', 'deal_disqualified'] as const;

/** The outcome column's vocabulary; one per terminal event, same order. */
export const OUTCOMES = ['won', 'lost', 'disqualified'] as const;
export type RevenueOutcome = typeof OUTCOMES[number];

/**
 * Terminal event → the outcome it implies. Callers pass an eventType and the ledger derives the
 * outcome, so the two can never disagree (a `deal_won` carrying outcome 'lost' would silently
 * corrupt every win-rate figure downstream).
 */
export const OUTCOME_FOR_EVENT: Record<string, RevenueOutcome> = {
    deal_won: 'won',
    deal_lost: 'lost',
    deal_disqualified: 'disqualified',
};

/**
 * Why a deal was lost. CLOSED so the Strategy Agent can GROUP BY it — see the header note.
 * `other` is the escape hatch; a caller using it should put detail in `payload`, not invent a key.
 */
export const LOSS_REASONS = [
    'price',
    'timing',
    'no_budget',
    'competitor',
    'no_response',
    'wrong_contact',
    'not_icp',
    'feature_gap',
    'went_silent',
    'other',
] as const;

export type LossReason = typeof LOSS_REASONS[number];

/**
 * How each loss reason is offered to the user when they mark a deal lost (Phase 4.5).
 *
 * Lives HERE, beside the vocabulary, for the same reason SEQUENCE_HALT_REASON_LABELS does: the keys
 * are a closed set, and a second file listing them is a hand copy. Every hand copy of a closed
 * vocabulary in this codebase has drifted — the connection-status one badged a dead connection
 * "Connected" for weeks. The browser gets these via scripts/gen-client-constants.ts, never by
 * retyping them into a page.
 *
 * Phrased as the user would say it, not as the analyser reads it: `not_icp` is a judgement about
 * our targeting, so it says so — that is the whole signal the Strategy Agent is looking for.
 */
export const LOSS_REASON_LABELS: Record<LossReason, string> = {
    price: 'Too expensive',
    timing: 'Bad timing — not now',
    no_budget: 'No budget',
    competitor: 'Went with a competitor',
    no_response: 'Never replied',
    wrong_contact: 'Wrong person — not the decision maker',
    not_icp: 'Not a fit — we should not have targeted them',
    feature_gap: 'We were missing something they needed',
    went_silent: 'Went quiet mid-conversation',
    other: 'Something else',
};

/** How each outcome is labelled in the UI. */
export const OUTCOME_LABELS: Record<RevenueOutcome, string> = {
    won: 'Won',
    lost: 'Lost',
    disqualified: 'Disqualified',
};

/**
 * Terminal events that require a loss reason.
 *
 * `won` takes none — there is no such thing — and passing one would store a nonsense value, since
 * recordEvent() accepts lossReason on ANY terminal event. `disqualified` requires one for the same
 * reason `lost` does: "we ruled them out" is only useful to the analyser if it says why, and
 * `not_icp` vs `wrong_contact` is precisely the targeting signal Phase 5 pivots on.
 */
export const OUTCOMES_REQUIRING_LOSS_REASON: readonly RevenueOutcome[] = ['lost', 'disqualified'];

/** The terminal event type that records this outcome. Inverse of OUTCOME_FOR_EVENT. */
export const EVENT_FOR_OUTCOME: Record<RevenueOutcome, RevenueEventType> = {
    won: 'deal_won',
    lost: 'deal_lost',
    disqualified: 'deal_disqualified',
};

/**
 * Who caused the event. This is what makes "how much of our pipeline is genuinely autonomous?"
 * answerable, and it is the join key for judging whether raising an autonomy level actually helped.
 *   'system' — a background job with no human or LLM decision (backfill, cron bookkeeping)
 *   'agent'  — an LLM-driven decision (scoring, drafting, sending, negotiating)
 *   'user'   — a person clicked something
 */
export const ACTORS = ['system', 'agent', 'user'] as const;
export type RevenueActor = typeof ACTORS[number];

// ── Guards ───────────────────────────────────────────────────────────────────
// Narrow `string` from an untyped call site (JSON bodies, DB rows) to the union.

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);
const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_EVENT_TYPES);
const LOSS_REASON_SET: ReadonlySet<string> = new Set(LOSS_REASONS);
const ACTOR_SET: ReadonlySet<string> = new Set(ACTORS);
const OUTCOME_SET: ReadonlySet<string> = new Set(OUTCOMES);

export function isEventType(v: unknown): v is RevenueEventType {
    return typeof v === 'string' && EVENT_TYPE_SET.has(v);
}

/** True for the three events that carry an outcome. Drives the ledger's outcome derivation. */
export function isTerminal(v: unknown): boolean {
    return typeof v === 'string' && TERMINAL_SET.has(v);
}

export function isLossReason(v: unknown): v is LossReason {
    return typeof v === 'string' && LOSS_REASON_SET.has(v);
}

export function isActor(v: unknown): v is RevenueActor {
    return typeof v === 'string' && ACTOR_SET.has(v);
}

export function isOutcome(v: unknown): v is RevenueOutcome {
    return typeof v === 'string' && OUTCOME_SET.has(v);
}
