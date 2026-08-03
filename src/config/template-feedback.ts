// src/config/template-feedback.ts
// The vocabulary for human edits to a drafted message — plan §2.6, the ⭐ option.
//
// A reviewer who rewrites a draft is telling us something about the TEMPLATE, not just about that
// prospect. Capturing why turns the edit into training signal instead of throwing it away: after
// MIN_EDIT_SAMPLE similar edits the Strategy Agent proposes the template change through the normal
// proposal flow, with a sample size behind it — unlike a "save as default" click, which generalises
// from n = 1.
//
// ── Why the vocabulary is CLOSED ─────────────────────────────────────────────
// `edit_reason` is the GROUP BY key for the entire edit-pattern proposer (docs/strategy-agent-plan.md
// §4.1). Free text cannot be clustered, so "six people all said the opener is too formal" would
// degenerate into asking a model to summarise prose — the same argument that makes LOSS_REASONS
// closed. The DDL mirrors this list in a CHECK constraint.
//
// ⚠️ Adding a value means changing BOTH this file AND the CHECK in db/template-feedback-vocab.sql
// (and the matching check() in db/schema.ts). tests/template-feedback.test.ts asserts the three stay
// in sync — add one here alone and that test fails on purpose.

/**
 * Why a human changed the drafted message.
 *
 * Each key names a property OF THE TEMPLATE that a rewrite could fix — not a property of this one
 * prospect. "This company is in a different sector" is not here on purpose: it is a fact about the
 * lead, it says nothing about the playbook, and a proposer clustering on it would rewrite the
 * template to suit one recipient.
 */
export const EDIT_REASONS = [
    'too_formal',                // stiff, corporate, reads like a letter
    'too_casual',                // over-familiar for this audience
    'wrong_value_prop',          // led with the wrong benefit
    'wrong_pain_point',          // named a problem they do not have
    'too_long',                  // would not survive a phone screen
    'factually_wrong',           // said something untrue about them or us
    'bad_subject',               // the subject line would not get opened
    'personalisation_missing',   // generic where it should have been specific
    'other',                     // escape hatch — deliberately excluded from the proposer
] as const;

export type EditReason = typeof EDIT_REASONS[number];

/**
 * How each reason is offered to the reviewer.
 *
 * Lives beside the vocabulary rather than in whichever surface renders it — every hand copy of a
 * closed vocabulary in this codebase has drifted. The browser gets these from
 * scripts/gen-client-constants.ts, never by retyping them into a page.
 *
 * Phrased as the reviewer would say it out loud, because they are picking one mid-edit and the
 * whole mechanism depends on that choice being cheap and honest.
 */
export const EDIT_REASON_LABELS: Record<EditReason, string> = {
    too_formal: 'Too formal',
    too_casual: 'Too casual',
    wrong_value_prop: 'Wrong benefit',
    wrong_pain_point: 'Wrong problem',
    too_long: 'Too long',
    factually_wrong: 'Got something wrong',
    bad_subject: 'Weak subject line',
    personalisation_missing: 'Not specific enough',
    other: 'Something else',
};

/**
 * `other` is captured for humans and **withheld from the model** (plan §7.1 makes the same call for
 * reject reasons). It is a bucket, not a signal: clustering on it would tell the proposer only that
 * several people disliked something, with no shared property to act on.
 */
export const EDIT_REASONS_FED_TO_MODEL: readonly EditReason[] =
    EDIT_REASONS.filter((r) => r !== 'other');

/**
 * How many similar edits the edit-pattern proposer needs before it may propose a template change
 * (docs/strategy-agent-plan.md §4.1).
 *
 * Five, not the win/loss MIN_SAMPLE of 20: the unit here is a human edit rather than a closed deal,
 * and the signal is far more direct — a person stating what was wrong with the text beats inferring
 * it from an outcome months later. Declared here so Phase 5a reads it rather than redeclaring it.
 */
export const MIN_EDIT_SAMPLE = 5;

const EDIT_REASON_SET: ReadonlySet<string> = new Set(EDIT_REASONS);

/** Narrow an untyped value (a JSON body, a DB row) to the union. */
export function isEditReason(v: unknown): v is EditReason {
    return typeof v === 'string' && EDIT_REASON_SET.has(v);
}
