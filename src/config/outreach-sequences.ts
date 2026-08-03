// src/config/outreach-sequences.ts
// The outreach-sequence vocabulary and its safety caps — Phase 2b of
// docs/lead-generator-revenue-engine-plan.md §5.2.
//
// Imported by src/utils/outreach-sequences.ts (the only writer of sequence_enrolments) and by
// netlify/functions/process-sequence-sends.ts (the only sender). The CHECK constraints in
// db/outreach-sequences.sql and the check() calls in db/schema.ts mirror the vocabularies here;
// tests/outreach-sequences.test.ts asserts all three stay in sync.
//
// ── Why the caps live in code, not only in the DB ────────────────────────────
// A cadence that runs away does not fail loudly — it quietly emails strangers on a tenant's
// behalf, from the tenant's own mailbox, and the first signal is a spam complaint or a burned
// sending domain. Every limit below is therefore enforced in the worker BEFORE a send, not
// merely defaulted in a column an operator could edit to something absurd.

/** Enrolment lifecycle. Mirrors sequence_enrolments_state_check. */
export const SEQUENCE_STATES = ['active', 'completed', 'halted', 'cancelled'] as const;
export type SequenceState = typeof SEQUENCE_STATES[number];

/**
 * Why a cadence stopped. CLOSED so "why do sequences stop early?" is a GROUP BY rather than a
 * prose summary — the same reasoning as LOSS_REASONS in revenue-events.ts.
 *
 * The distinction that matters analytically is `replied` (the cadence worked) versus everything
 * else (the cadence was cut short). A tenant whose sequences mostly end in `max_steps` is being
 * ignored; one whose sequences mostly end in `suppressed` has a targeting problem upstream.
 */
export const SEQUENCE_HALT_REASONS = [
    'replied',        // the prospect answered — the success case, and the ONLY halt we want to see often
    'suppressed',     // the org's suppression list gained this domain after enrolment
    'no_recipient',   // the address vanished from the record (edited or cleared)
    'not_connected',  // the mailbox OAuth connection died mid-cadence
    'send_failed',    // repeated send failures; see MAX_SEND_ATTEMPTS
    'max_steps',      // the cadence ran to its end with no reply
    'record_closed',  // the underlying lead record was rejected or deleted
    'do_not_contact', // qualification says this lead must never be emailed — distinct from a human
                      // rejecting it (record_closed): it means targeting let through someone we
                      // should not have contacted, which is a compliance signal, not a preference
    'manual',         // a human stopped it
] as const;
export type SequenceHaltReason = typeof SEQUENCE_HALT_REASONS[number];

/**
 * How each halt reason is phrased to the user.
 *
 * Lives HERE, beside the vocabulary, rather than in whichever surface happens to render it. The
 * keys are already a closed set; a second file listing them is a hand copy, and hand copies of
 * closed vocabularies in this codebase have drifted every single time (the connection-status one
 * badged a dead connection "Connected" for weeks).
 *
 * Phrased from the USER's point of view, not the worker's: `not_connected` is a thing they can go
 * and fix, so it says so.
 */
export const SEQUENCE_HALT_REASON_LABELS: Record<SequenceHaltReason, string> = {
    replied: 'They replied — follow-ups stopped automatically',
    suppressed: 'Their domain was added to your suppression list',
    no_recipient: 'The email address was removed from this lead',
    not_connected: 'Your sending mailbox disconnected — reconnect it to resume',
    send_failed: 'Sending kept failing, so the follow-ups were stopped',
    max_steps: 'The full sequence ran with no reply',
    record_closed: 'The lead was rejected or deleted',
    do_not_contact: 'This lead must never be emailed',
    manual: 'You stopped it',
};

/**
 * A user-facing sentence for a halt reason. Falls back to the raw value rather than an empty
 * string, so a reason added to the vocabulary without a label degrades to "why did it stop?
 * some_new_reason" instead of a blank space where an explanation should be.
 */
export function haltReasonLabel(reason: string | null | undefined): string | null {
    if (!reason) return null;
    return SEQUENCE_HALT_REASON_LABELS[reason as SequenceHaltReason] ?? reason;
}

const STATE_SET: ReadonlySet<string> = new Set(SEQUENCE_STATES);
const HALT_SET: ReadonlySet<string> = new Set(SEQUENCE_HALT_REASONS);

export function isSequenceState(v: unknown): v is SequenceState {
    return typeof v === 'string' && STATE_SET.has(v);
}
export function isHaltReason(v: unknown): v is SequenceHaltReason {
    return typeof v === 'string' && HALT_SET.has(v);
}

/**
 * The default cadence, provisioned per assistant on first enrolment.
 *
 * Three follow-ups over ~17 days. The shape is deliberate: each step asks for LESS than the one
 * before it, ending on a break-up note that gives the prospect an easy way to close the loop.
 * Escalating pressure is what turns a cadence into harassment, and it converts worse.
 *
 * `delayDays` counts from the PREVIOUS send, so the calendar is 3 / 10 / 17 days after the opener.
 */
export const DEFAULT_SEQUENCE_STEPS: ReadonlyArray<{ stepNumber: number; delayDays: number; bodyPrompt: string }> = [
    {
        stepNumber: 1,
        delayDays: 3,
        bodyPrompt:
            'A short nudge on the original email. Reference something specific from it so it is clearly '
            + 'the same conversation, not a mail-merge. Add ONE new concrete detail or proof point that was '
            + 'not in the first email. Under 70 words. Do not apologise for following up and do not say '
            + '"just checking in" or "bumping this to the top of your inbox".',
    },
    {
        stepNumber: 2,
        delayDays: 7,
        bodyPrompt:
            'A second and final nudge, lighter than the first. Offer one specific, low-commitment next '
            + 'step (a 15-minute call, or simply a yes/no reply). Acknowledge that the timing may be wrong. '
            + 'Under 60 words.',
    },
    {
        stepNumber: 3,
        delayDays: 7,
        bodyPrompt:
            'A polite close-out. Say plainly that this is the last email and that you will not follow up '
            + 'again, and invite them to reply if the timing changes later. Warm, no guilt, no false '
            + 'scarcity, no "should I close your file?". Under 50 words.',
    },
];

// ── Hard caps (enforced in the worker, before every send) ────────────────────

/**
 * Absolute ceiling on follow-ups per enrolment, independent of how many rows sequence_steps holds.
 * A misconfigured cadence with 40 steps must not be able to send 40 emails.
 */
export const MAX_STEPS_PER_ENROLMENT = 5;

/**
 * Ceiling on sequence follow-ups per organisation per UTC day. Mirrors HANDOFF_CAP_BY_TIER's role
 * as a cost/spam backstop. This counts FOLLOW-UPS ONLY — opening emails are gated by the human
 * approval click and are not part of this budget.
 */
export const MAX_SENDS_PER_ORG_PER_DAY = 50;

/** Ceiling on new enrolments per organisation per UTC day. */
export const MAX_ENROLMENTS_PER_ORG_PER_DAY = 100;

/** Consecutive failures at one step before the enrolment is halted as `send_failed`. */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * Wall-clock budget for one worker invocation. Netlify's scheduled-function ceiling is ~26s; the
 * worker checks this between enrolments and stops cleanly, leaving the rest for the next tick.
 * A partially drained queue is fine — every row is claimed independently and next_send_at is only
 * advanced after a confirmed send.
 */
export const WORKER_BUDGET_MS = 20_000;

/** Enrolments claimed per invocation. Bounds the query, not the send count. */
export const WORKER_BATCH_SIZE = 25;

/**
 * How the `template_version` on an outbound sequence message is stamped. The prefix is what lets a
 * follow-up be counted separately from an opening email in lead_messages, which is how
 * MAX_SENDS_PER_ORG_PER_DAY is measured — so it must stay stable.
 */
export const SEQUENCE_TEMPLATE_PREFIX = 'seq';
export function sequenceTemplateVersion(sequenceId: number, stepNumber: number): string {
    return `${SEQUENCE_TEMPLATE_PREFIX}:${sequenceId}:${stepNumber}`;
}
