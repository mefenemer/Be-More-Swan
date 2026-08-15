// src/config/lead-retention.ts
// The 30-day clock on a lead that nobody has acted on, and what happens when it runs out.
//
// ── What this is ─────────────────────────────────────────────────────────────
// Two columns of the Outreach tab hold leads that are waiting on a human and may wait forever:
//   • Review   — pending_approval. A drafted email nobody has approved or turned down.
//   • Archived — rejected. A lead the user said no to.
// Both accumulate for the life of the account. After 30 days a lead in either is moved to a
// RETAINED "Deleted" state, surfaced as its own section in the Enrichment tab.
//
// ⚠️ MOVED, NOT DESTROYED — and the distinction is the whole design.
//
// The obvious implementation is a hard DELETE, mirroring archive-cleanup.ts (which really does
// drop rejected posts at 30 days). It is wrong here, for a reason that is specific to leads:
// deleting the assistant_records row destroys the only record of the VERDICT. The manual delete
// used to show the damage — it severed `discovered_leads.assistant_record_id` (ON DELETE SET
// NULL), which is how one prod assistant ended up with 35 discovery rows marked 'promoted' and
// 14 still linked. The discovery row survives at 'discarded', so the SAME saved search will
// not re-find the company, but the dedupe index is per campaign (campaign_id, domain): a second
// search finds it again, scores it again, and drafts to it again, because nothing left on the
// record says "we looked at this company and it cannot or must not be contacted".
//
// ⚠️ SINCE 2026-08-15 THE MANUAL DELETE COMES HERE TOO. assistant-records.ts's DELETE no longer
// drops a lead row: it marks the lead rejected, banks the reason, discards the discovery row and
// stamps `deleted_by_user` below. So this section is not only the sweep's output — it is the
// answer to "where did the lead I deleted go?", and it is the ONLY answer. Any future code that
// reintroduces a hard delete for leads silently removes that answer.
//
// So the sweep moves the lead into a state that keeps saying that. Cheap to store, and it is the
// only copy of a fact the scorer and the user both need.
//
// ── What the user can and cannot undo ────────────────────────────────────────
// The MOVE is automatic and cannot be stopped or reversed — a lead that has sat untouched for 30
// days leaves Outreach whether anyone is watching or not. The LEAD is retained, and the one way
// back into the active pipeline is the explicit "Send back for enrichment" button on the Deleted
// section, which clears the stamps and restarts the clock (see RETENTION_CLOCK_FIELD below).
//
// ── Why jsonb and not a column ───────────────────────────────────────────────
// `approval_status` is the natural home for a 'deleted' state and it is the wrong choice here.
// It carries a CHECK constraint, constraints do not come back through introspection, and this
// repo applies db/*.sql BY HAND — so the value would exist in code before it existed in the live
// schema on at least one environment, and every write of it would fail there with a constraint
// violation rather than anything legible. (`paused_credits` on scheduled_posts is the same trap,
// in the other direction: DB ahead of code.) A new COLUMN is no safer: `db.select()` names every
// column it reads, so an unapplied migration turns every read of this table into a 500.
//
// `data` is already jsonb and already carries per-lead state (enrichAttemptedAt, dealOutcome,
// emailKind). Adding a key to it needs no DDL and behaves identically on both environments the
// day it ships. The cost is that the "not deleted" predicate must be added to every query over
// live leads by hand — which is exactly why the predicate is defined ONCE, here, and mirrored
// into SQL rather than retyped (the lead-recipient.ts precedent, for the same reason).
//
// ⚠️ The functions below are emitted to the browser via `.toString()` by
// scripts/gen-client-constants.ts, so they must stay self-contained: no imports, no closures over
// anything except the constants declared in this file.

/** How long a lead may sit in Review or Archived before it is moved to Deleted. */
export const LEAD_RETENTION_DAYS = 30;

/**
 * Where the verdict lives on `assistant_records.data`.
 *
 * One object rather than loose keys, so "is this lead retained?" is a single presence check in
 * both JS and SQL, and so clearing it is a single delete.
 *
 *   data.retention = {
 *     deletedAt:  ISO | null, // when the sweep moved it (absent while the lead is live)
 *     reason:     string,     // one of RETENTION_REASONS, set with deletedAt
 *     returnedAt: ISO | null, // last time "Send back for enrichment" was pressed
 *   }
 *
 * ⚠️ There is deliberately no clock field here. The clock is `assistant_records.updated_at` — see
 * retentionClockStart() below for why a second, stickier stamp was removed rather than added.
 */
export const RETENTION_FIELD = 'retention';
export const RETENTION_DELETED_FIELD = 'deletedAt';

/** Postgres `#>>` path, built from the constants above so SQL and JS cannot drift. */
export const RETENTION_DELETED_SQL_PATH = `{${RETENTION_FIELD},${RETENTION_DELETED_FIELD}}`;

/**
 * Why a lead ended up in Deleted. These are the sentences the section is FOR — a lead sitting
 * there without one is just a lead that vanished.
 *
 * The vocabulary is closed and ordered by how strongly it argues against ever contacting the
 * company again, because that is what a future search needs to know.
 */
export const RETENTION_REASONS = [
    'do_not_contact',
    // The user pressed Delete. Added 2026-08-15, when Delete stopped destroying the row: a manual
    // delete now lands a lead HERE rather than dropping it, which is what makes "where did that
    // lead go?" answerable at all. It ranks second because an explicit human "get rid of this" is
    // the strongest argument against the company short of a compliance flag.
    'deleted_by_user',
    'rejected',
    'enrichment_failed',
    'not_contactable',
    'unreviewed',
] as const;

export type RetentionReason = (typeof RETENTION_REASONS)[number];

/**
 * The reason a MANUAL delete stamps (assistant-records.ts, DELETE).
 *
 * Named rather than typed as a literal at the call site so the string exists once. The sweep's
 * `retentionReasonFor()` can never return it — that function classifies leads that ran out of
 * time, and this one is the only reason chosen by a person.
 */
export const RETENTION_REASON_USER_DELETE: RetentionReason = 'deleted_by_user';

/**
 * What the Deleted section prints, per reason.
 *
 * Written as a fact about the lead, never as an apology or an instruction: the row already
 * carries a "Send back for enrichment" button, so the sentence's job is to explain why pressing
 * it might be pointless.
 */
export const RETENTION_REASON_LABELS: Record<RetentionReason, string> = {
    do_not_contact: 'Must not be contacted',
    deleted_by_user: 'You deleted this lead',
    rejected: 'You turned this lead down',
    enrichment_failed: 'No contact address could be found',
    not_contactable: 'Never had a contact address',
    unreviewed: 'Waited 30 days without a decision',
};

/** The longer line under the label — what actually happened, and what sending it back would do. */
export const RETENTION_REASON_NOTES: Record<RetentionReason, string> = {
    do_not_contact:
        'This company was flagged as one we must never email — a competitor, an internal account, '
        + 'or someone who asked not to be contacted. Sending it back for enrichment will not clear that flag.',
    deleted_by_user:
        'You deleted this lead from your list. It is kept here, marked rejected, so a later search '
        + 'that finds the same company again leaves it rejected instead of putting it back in front of you. '
        + 'Sending it back for enrichment returns it to the pipeline.',
    rejected:
        'You rejected this lead, and 30 days passed without it being picked back up. '
        + 'Sending it back for enrichment returns it to the pipeline and starts the clock again.',
    enrichment_failed:
        'We read this company’s website and found no address to write to. '
        + 'Sending it back for enrichment tries again, including the paid lookup if it is available.',
    not_contactable:
        'This lead never had a contact address and was never enriched — cold leads are skipped on rating. '
        + 'Sending it back for enrichment reads their site for the first time.',
    unreviewed:
        'A drafted email sat waiting for your approval for 30 days. Nothing was ever sent. '
        + 'Sending it back for enrichment refreshes what we know and returns it to the pipeline.',
};

/**
 * Decide why a lead is being moved to Deleted.
 *
 * Order matters: `doNotContact` outranks everything, because it is the one verdict that must
 * survive a user later deciding to pursue the company anyway. After that, an explicit rejection
 * outranks a missing address — the user's decision is a stronger fact than our scraper's failure.
 *
 * `data` is the record's jsonb; `approvalStatus` is the envelope column. `hasRecipient` is passed
 * in rather than recomputed, because resolving it is lead-recipient.ts's job and there must not be
 * a second copy of that precedence anywhere.
 */
export function retentionReasonFor(
    data: unknown,
    approvalStatus: string,
    hasRecipient: boolean,
): RetentionReason {
    const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    if (d.doNotContact === true) return 'do_not_contact';
    if (approvalStatus === 'rejected') return 'rejected';
    if (hasRecipient) return 'unreviewed';
    // No address. Whether we ever LOOKED is the difference between a failure and an omission, and
    // the two want different sentences — "we tried and found nothing" vs "we never tried".
    return d.enrichAttemptedAt ? 'enrichment_failed' : 'not_contactable';
}

/**
 * Is this record currently in the retained Deleted state?
 *
 * Presence of `deletedAt` is the test, not truthiness of `retention` — a lead that has been sent
 * back keeps its `retention` object (it holds the restarted clock and the `returnedAt` stamp) and
 * must read as live.
 */
export function isRetentionDeleted(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const r = (data as Record<string, unknown>)[RETENTION_FIELD];
    if (!r || typeof r !== 'object') return false;
    const at = (r as Record<string, unknown>)[RETENTION_DELETED_FIELD];
    return typeof at === 'string' && at.trim() !== '';
}

/** The reason a retained lead was moved, or null if it is not in Deleted. */
export function retentionReasonOf(data: unknown): RetentionReason | null {
    if (!isRetentionDeleted(data)) return null;
    const r = (data as Record<string, unknown>)[RETENTION_FIELD] as Record<string, unknown>;
    const reason = r.reason;
    return typeof reason === 'string' && (RETENTION_REASONS as readonly string[]).includes(reason)
        ? reason as RetentionReason
        : 'unreviewed';
}

/**
 * When the current 30-day window started, as an ISO string, or null if there is nothing to read.
 *
 * ── The clock is `updated_at`, and that is the whole rule ────────────────────
 * One sentence the user can be told and the sweep can be held to: ANY write to a lead restarts
 * its 30 days. Approve it, reject it, edit it, record an outcome, send it back for enrichment,
 * land an address on it — the clock goes back to zero, because every one of those is someone or
 * something working the lead.
 *
 * A dedicated `clockStartedAt` stamp was written first and removed. It is sticky by nature: once
 * set it wins over `updated_at` forever, so a lead that had been stamped stopped responding to
 * edits while a lead that never had been still reset on every touch. Two populations of lead
 * ageing by different rules, with no way for a user to tell which they were looking at — on a
 * countdown that ends in a deletion. Making it a floor instead (MAX of the two) fixed the
 * inconsistency and left the field with nothing to do, since a write that sets it also moves
 * `updated_at` to the same instant. So it is gone.
 *
 * This is a deliberate reversal of the reasoning in archive-cleanup.ts, which refuses `updated_at`
 * on scheduled_posts because ~30 functions write that table and any of them would look like human
 * activity. Here that is the desired reading, and it errs in the safe direction: a stray write
 * lengthens a lead's life, never shortens it.
 */
export function retentionClockStart(updatedAtIso: string | null): string | null {
    return updatedAtIso && updatedAtIso.trim() ? updatedAtIso : null;
}

/**
 * Whole days left before the sweep moves this lead, given the clock start.
 *
 * Rounded UP, so a lead with six hours left reads "1 day left" rather than "0 days left" — a zero
 * beside a row that is still on screen and still actionable reads as a bug. 0 is returned only
 * once the window has genuinely closed, i.e. the next sweep will take it.
 *
 * Returns null when there is no clock to read, so callers render nothing rather than "NaN days".
 */
export function retentionDaysRemaining(clockStartIso: string | null, now?: Date): number | null {
    if (!clockStartIso) return null;
    const started = Date.parse(clockStartIso);
    if (Number.isNaN(started)) return null;
    const deadline = started + LEAD_RETENTION_DAYS * 86400000;
    const remainingMs = deadline - (now ? now.getTime() : Date.now());
    if (remainingMs <= 0) return 0;
    return Math.ceil(remainingMs / 86400000);
}

/**
 * The countdown, as the UI prints it.
 *
 * Kept here rather than in the component because three surfaces show it — the Outreach Review
 * column, the Outreach Archived column, and the Enrichment table's own column — and a lead that
 * says "3 days left" on one tab and "2 days" on another is the kind of small inconsistency that
 * makes a destructive countdown untrustworthy.
 */
export function retentionCountdownLabel(daysRemaining: number | null): string {
    if (daysRemaining === null) return '';
    if (daysRemaining === 0) return 'Due for deletion';
    if (daysRemaining === 1) return '1 day left';
    return `${daysRemaining} days left`;
}

/**
 * How urgent the countdown looks. Three bands, matching the chip vocabulary used elsewhere in the
 * lead surfaces (red = acts against you now, amber = soon, grey = ambient).
 *
 * The thresholds are generous on purpose. This countdown ends in a deletion the user cannot undo,
 * so it should be shouting for a week rather than turning red on the last afternoon.
 */
export function retentionUrgency(daysRemaining: number | null): 'none' | 'low' | 'soon' | 'urgent' {
    if (daysRemaining === null) return 'none';
    if (daysRemaining <= 3) return 'urgent';
    if (daysRemaining <= 7) return 'soon';
    return 'low';
}

/**
 * The standing notice shown above the Review and Archived columns.
 *
 * States all four facts a user needs before a countdown beside their leads means anything: what
 * happens, when, that it happens by itself, and the one way out. Deliberately does NOT say
 * "permanently deleted" — the lead is retained, and overstating it would make the Deleted section
 * that follows look like a bug.
 */
export const RETENTION_NOTICE =
    `Leads left here for ${LEAD_RETENTION_DAYS} days are moved to Deleted automatically. `
    + 'Nothing is sent, and the move cannot be undone — but the lead is kept, with the reason it was '
    + 'dropped, in the Deleted section of the Enrichment tab. To stop the countdown on a lead, send '
    + 'it back for enrichment before it runs out.';

/** The same fact, one line, for the Deleted section's own header. */
export const RETENTION_DELETED_NOTICE =
    'Leads you deleted, plus leads that sat in Outreach for '
    + `${LEAD_RETENTION_DAYS} days without a decision or that were rejected and never picked back up. `
    + 'They are kept so a later search does not surface the same company as though it were new. '
    + 'Sending one back for enrichment returns it to the pipeline.';
