// src/config/lead-reject-reasons.ts
// Why a reviewer rejected a discovered lead — the vocabulary the Review Queue offers.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// Rejecting a lead used to record nothing but `approval_status = 'rejected'` and a `lead_rejected`
// ledger event whose payload is {from,to,rating}. Nothing read it. A user could reject twenty leads
// in a sitting, every one of them for the same reason, and the discovery engine's next run was
// built from exactly the same inputs as the last.
//
// ── Why the vocabulary is CLOSED ─────────────────────────────────────────────
// Same argument as EDIT_REASONS (src/config/template-feedback.ts) and LOSS_REASONS: the reason is
// a GROUP BY key, and free text cannot be clustered. "Six people all rejected agencies" has to
// survive as a count, not as prose for a model to re-summarise.
//
// ⚠️ Adding a value means changing BOTH this file AND the CHECK in db/lead-reject-feedback.sql (and
// the matching check() in db/schema.ts). tests/lead-reject-reasons.test.ts parses all three and
// asserts they agree — add one here alone and that test fails on purpose.
//
// ── ⚠️ Capture is not yet learning ───────────────────────────────────────────
// This module and its table are the EVIDENCE half. Nothing consumes the rows to change targeting
// yet: that is the rejection-cluster proposer in the Strategy Agent, which is not built. Say so in
// any user-facing copy. Promising that a click "teaches the assistant" when no code reads the row
// is the same failure as a chat reply claiming it saved a draft it never wrote.

/**
 * Why a reviewer rejected a lead.
 *
 * Each key names a property of the TARGETING that produced this lead, not a passing opinion of the
 * company. That is the test for admitting a new value: could a discovery run have been configured
 * differently so this lead never appeared? If not, it is a note, not a reason.
 */
export const LEAD_REJECT_REASONS = [
    'competitor',          // a peer or supplier to the same market, not a buyer
    'not_a_business',      // a directory, article, listing or aggregator rather than a company
    'wrong_industry',      // outside the industries we sell to
    'too_small',           // below the size we sell to
    'too_large',           // above it — enterprise we could not service
    'wrong_geography',     // outside the territory we serve
    'existing_customer',   // already ours
    'no_buying_signal',    // plausible fit, but nothing suggesting they need us now
    'bad_contact',         // no reachable person, or the contact details are wrong
    'other',               // escape hatch — deliberately excluded from any aggregate
] as const;

export type LeadRejectReason = typeof LEAD_REJECT_REASONS[number];

/**
 * How each reason is offered to the reviewer.
 *
 * Phrased as the reviewer would say it out loud. They are picking one immediately after a reject,
 * with nineteen more leads waiting, so the choice has to be cheap and honest — a label they have to
 * decode gets whatever is nearest the cursor.
 */
export const LEAD_REJECT_REASON_LABELS: Record<LeadRejectReason, string> = {
    competitor: 'Competitor or peer',
    not_a_business: 'Not a real business',
    wrong_industry: 'Wrong industry',
    too_small: 'Too small',
    too_large: 'Too big',
    wrong_geography: 'Wrong location',
    existing_customer: 'Already a customer',
    no_buying_signal: 'No sign they need us',
    bad_contact: 'No usable contact',
    other: 'Something else',
};

/**
 * The reasons where excluding this company's DOMAIN from the search is the right follow-up.
 *
 * Narrow on purpose. A competitor or a directory is permanently not a customer, so blocking the
 * domain costs nothing. "Too small" is a property of the company TODAY — blocking that domain
 * forever would quietly delete a prospect who grows into the profile, and the user clicking a
 * one-line quick action is not making that decision knowingly.
 */
export const DOMAIN_EXCLUSION_REASONS: readonly LeadRejectReason[] = ['competitor', 'not_a_business'];

/**
 * `other` is captured for humans and withheld from any aggregate — it is a bucket, not a signal.
 * `existing_customer`, `no_buying_signal` and `bad_contact` are excluded for a different reason:
 * each is a real fact, but none of them is a fault in WHO the search looked for. They belong to
 * suppression, scoring and enrichment respectively, and clustering on them would retarget the
 * search to fix a problem that lives somewhere else.
 */
export const LEAD_REJECT_REASONS_FOR_TARGETING: readonly LeadRejectReason[] = [
    'competitor', 'not_a_business', 'wrong_industry', 'too_small', 'too_large', 'wrong_geography',
];

/**
 * How many rejections sharing one reason before the Strategy Agent may propose a retarget.
 *
 * Eight, not the edit proposer's five. A rejection is ONE CLICK; an edit is a rewrite someone
 * actually performed. The same number would treat a much weaker signal as equally decisive.
 */
export const MIN_REJECT_SAMPLE = 8;

/**
 * ⚠️ THE BURST GUARD, and the reason a raw threshold is not enough.
 *
 * A reviewer working through one bad run rejects twenty leads in a sitting. Every threshold clears
 * instantly, from a single search that was misconfigured once — and the proposer would rewrite the
 * persona for ALL of that assistant's campaigns on the strength of it. So a cluster must also be
 * spread: either it spans more than one campaign, or it accumulated over more than one day.
 *
 * "The same complaint, twice, independently" is the actual signal. One afternoon of clicking is not.
 */
export const MIN_REJECT_CAMPAIGNS = 2;
export const MIN_REJECT_SPREAD_DAYS = 2;

const REASON_SET: ReadonlySet<string> = new Set(LEAD_REJECT_REASONS);

/** Narrow an untyped value (a JSON body, a DB row) to the union. */
export function isLeadRejectReason(v: unknown): v is LeadRejectReason {
    return typeof v === 'string' && REASON_SET.has(v);
}
