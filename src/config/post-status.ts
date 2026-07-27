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
 * writes 'scheduled' directly; 'paused' and 'failed' are posts that WERE scheduled and now need
 * attention, so hiding them would lose work silently.
 */
export const SCHEDULE_ACTIVE_STATUSES = [
    'approved',
    'scheduled',
    'publishing',
    'published',
    'paused',
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
