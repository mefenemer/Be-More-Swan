// src/config/post-status.ts
// Single source of truth for which scheduled_posts statuses mean "this post has a LIVE schedule".
//
// ── Why this distinction exists ─────────────────────────────────────────────────────────────────
// Every draft carries a publish_date from the moment it is created — the assistant proposes a slot
// so the composer, the format router and the gap-filler have something to reason about. That date
// is a PROPOSAL, not a commitment: nothing publishes until a human presses Schedule/Approve
// (approve-post.ts, which moves the row to 'scheduled').
//
// Treating a draft's proposed date as a real schedule produced two user-visible bugs:
//   • the Content Calendar rendered unapproved drafts alongside genuinely scheduled work, so the
//     calendar could not be read as "what is going out"
//   • check-review-urgency emailed + notified against that date ("post due in 3h") and expired the
//     draft to 'missed' when the slot passed — deadlines for a schedule that was never active
//
// Anything that reasons about "is this post on the calendar / is its clock running" must ask here
// rather than writing its own status list. The browser's copy is generated into
// src/generated/platform-constants.js (scripts/gen-client-constants.ts) — do not retype it.

/** Every status scheduled_posts.status may hold (db/scheduled-posts-status-check.sql). */
export type PostStatus =
    | 'draft'
    | 'pending_approval'
    | 'in_review'
    | 'approved'
    | 'scheduled'
    | 'publishing'
    | 'published'
    | 'paused'
    /**
     * NOT a synonym for 'paused'. This is the X quota park: the post is committed and due, but
     * either our monthly X allowance or the connected X account's own API quota is spent, so it
     * waits rather than burning a publish attempt (publish-social-posts.ts → pauseForXCredits).
     * Two sweeps select it back out — the monthly reset, and a credit-pack purchase in
     * stripe-webhook.ts. It was missing from this union AND from the database CHECK constraint,
     * which meant every pause was a constraint violation that degraded into a permanent 'failed'.
     * See db/scheduled-posts-paused-credits-status.sql.
     */
    | 'paused_credits'
    | 'failed'
    | 'rejected'
    | 'cancelled'
    | 'missed'
    | 'admin_test';

/**
 * Statuses whose schedule is live: a human has committed the post, so its publish_date is a real
 * appointment. These are the posts the Content Calendar shows and the only ones a publish-deadline
 * may be measured against.
 *
 * 'approved' and 'scheduled' are both here because approval is the commit point and the SMM flow
 * writes 'scheduled' directly; 'paused', 'paused_credits' and 'failed' are posts that WERE
 * scheduled and now need attention, so hiding them would lose work silently — which is exactly
 * what happened to 'paused_credits' while it was absent from both lists: a post parked on quota
 * fell off the calendar with no badge, no column and no chip anywhere in the product.
 */
export const SCHEDULE_ACTIVE_STATUSES = [
    'approved',
    'scheduled',
    'publishing',
    'published',
    'paused',
    'paused_credits',
    'failed',
] as const satisfies readonly PostStatus[];

/**
 * The rest: drafts nobody has committed yet ('draft', 'pending_approval', 'in_review'), posts the
 * user turned down ('rejected', 'cancelled'), legacy expiries ('missed') and admin dry-runs
 * ('admin_test'). These live in the Review Queue, not on the calendar.
 */
export const SCHEDULE_INACTIVE_STATUSES = [
    'draft',
    'pending_approval',
    'in_review',
    'rejected',
    'cancelled',
    'missed',
    'admin_test',
] as const satisfies readonly PostStatus[];

const ACTIVE = new Set<string>(SCHEDULE_ACTIVE_STATUSES);

/** True when the post is committed to publish — i.e. it belongs on the Content Calendar. */
export function isScheduleActive(status: string | null | undefined): boolean {
    return ACTIVE.has(String(status ?? ''));
}

/**
 * Statuses whose MEDIA may still be changed. A post that has gone out is a matter of record, and a
 * rejected/cancelled one is not coming back — swapping either one's picture would rewrite history.
 *
 * Deliberately narrower than SCHEDULE_ACTIVE_STATUSES, and not derivable from it: 'published',
 * 'publishing' and 'failed' all have live schedules but must never have their media rewritten,
 * while 'draft'/'pending_approval'/'in_review' have no schedule yet and are the most editable posts
 * there are. The browser's copy of this rule is _pceIsEditablePost in workspace.html.
 */
export const MEDIA_EDITABLE_STATUSES = [
    'draft',
    'pending_approval',
    'in_review',
    'approved',
    'scheduled',
] as const satisfies readonly PostStatus[];

const MEDIA_EDITABLE = new Set<string>(MEDIA_EDITABLE_STATUSES);

/** True when this post's attached media may still be swapped. */
export function isMediaEditable(status: string | null | undefined): boolean {
    return MEDIA_EDITABLE.has(String(status ?? ''));
}
