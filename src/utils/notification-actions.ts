// src/utils/notification-actions.ts
// Notifications: action vs info classification + auto-resolution.
//
// ACTION items require the user to DO something and are "cleared" by completing the
// task, not by reading. Everything else is informational (read/unread). This module is
// the single source of truth for that classification (imported by notifications.ts) and
// for auto-resolving open action items when the underlying problem is actually fixed.
//
// Two ways an action item clears:
//   1. resolve-on-click — clicking the card's CTA marks it read (handled in notifications.js).
//   2. auto-resolve (this module) — a real-world success event (payment taken, plan
//      upgraded, connection re-established) clears the matching open action items server-side,
//      so a stale "Update payment" card disappears the moment the payment actually succeeds.
//
// Auto-resolve is wired only for ACCOUNT-STATE actions whose condition is global to the
// user (billing/connection). Per-item actions (post approvals, per-post publish
// failures) are intentionally left on resolve-on-click: clearing all of a type on one
// success would wrongly dismiss a still-open sibling item.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { notifications } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

// ── Category model (Dynamic Communications Engine — Intelligent Notification Routing) ──
// Every notification type maps to exactly one of five categories. The category drives
// rendering (border/icon), priority sort, dismissibility and email-fallback eligibility.
// This is the single source of truth — KEEP IN SYNC with the SQL CASE in
// db/notifications-categorization.sql (which stamps the same values onto the columns).
export type NotificationCategory =
    | 'critical_action'   // billing / account / security blockers — pinned, undismissible
    | 'suggested_action'  // important, do-something, but dismissible
    | 'state_change'      // something completed / changed — FYI confirmation
    | 'informational'     // neutral notices
    | 'celebratory';      // wins / milestones

// AC2.1: hidden priority weight per category (lower = higher up the feed).
export const CATEGORY_PRIORITY: Record<NotificationCategory, number> = {
    critical_action: 1, suggested_action: 2, state_change: 3, celebratory: 3, informational: 4,
};

// AC3.2: only critical_action is locked (cannot be dismissed); everything else defaults dismissible.
export const CATEGORY_DISMISSIBLE: Record<NotificationCategory, boolean> = {
    critical_action: false, suggested_action: true, state_change: true, celebratory: true, informational: true,
};

// type → category. Anything not listed defaults to 'informational'.
const TYPE_CATEGORY: Record<string, NotificationCategory> = {
    // critical_action — billing / account / security blockers (undismissible)
    billing_payment_failed: 'critical_action', missing_stripe_sub: 'critical_action',
    stripe_cancelled_but_db_active: 'critical_action', subscription_paused: 'critical_action',
    assistants_paused_downgrade: 'critical_action',
    tier_mismatch: 'critical_action', run_budget_suspended: 'critical_action',
    task_limit_reached: 'critical_action', billing_cancelled: 'critical_action',
    security: 'critical_action', agent_anomaly: 'critical_action',
    // SMART Goals AC4.3.3 — telemetry connection lost; user must re-authenticate to keep tracking.
    goal_data_disconnected: 'critical_action',
    // ⚠️ NOTHING EMITS THESE TWO. They exist in db/notifications-categorization.sql and nowhere
    // else in the codebase — no call site, and no row in PREF_CATEGORIES. Mirrored here anyway
    // (2026-08-16) at the values the SQL already assigns, so the two maps agree by construction
    // and the parity test in tests/notification-prefs.test.ts has no exception list to rot.
    // Deleting them from the SQL was the alternative; that discards whoever's intent for a trial
    // flow, and a dead entry costs nothing. If a trial feature does ship, give them a
    // PREF_CATEGORIES home too — unmapped there means they fall to 'product_updates'.
    trial_expired: 'critical_action', trial_expiring_soon: 'suggested_action',
    // suggested_action — important, do-something, dismissible
    onboarding_prompt: 'suggested_action', onboarding_incomplete: 'suggested_action',
    hitl_approval_required: 'suggested_action', review_red_urgency: 'suggested_action',
    task_limit_warning: 'suggested_action',
    // Abuse Prevention US2: an admin is asked to invite someone who hit a connection collision.
    workspace_access_request: 'suggested_action',
    // Abuse Prevention US4: an owner is asked to invite someone who signed up on their domain.
    domain_join_request: 'suggested_action',
    run_cost_warning: 'suggested_action', social_oauth_revoked: 'suggested_action',
    instagram_token_refresh_failed: 'suggested_action', instagram_rate_limited: 'suggested_action',
    // refresh-social-tokens stamps a COMPUTED type per platform (see notify.ts `typeOverride`) so a
    // reconnect can clear one platform's prompt without touching another's. Being computed, they
    // were never listed here — and an unlisted type falls back to 'informational', which is
    // kindOf 'info'. A dead X connection therefore filed its "Action required: reconnect" card
    // under *Updates*, unpinned and never auto-resolved, next to the marketing notices.
    x_token_refresh_failed: 'suggested_action', linkedin_token_refresh_failed: 'suggested_action',
    facebook_token_refresh_failed: 'suggested_action',
    integration_alert: 'suggested_action', post_publish_failed: 'suggested_action',
    post_missed: 'suggested_action', post_generation_failed: 'suggested_action',
    // Empty-Library Draft Fallback (off) — scheduled drafts were skipped; user must upload media.
    content_library_empty: 'suggested_action',
    // The assistant's stored posting_frequency cannot be parsed, so autopilot has never run. Only a
    // human can fix the stored value, and until they do the assistant drafts nothing at all — this
    // belongs in "Action required", not Updates.
    autopilot_schedule_unreadable: 'suggested_action',
    // The blueprint has blocking gaps (unaccepted DPA, no active plan, prohibited-use terms not
    // acknowledged), so generation is refused every hour. Fixable in seconds once they know.
    autopilot_setup_blocked: 'suggested_action',
    // US 5.1 — a published post is losing search traffic and the user is asked to refresh it.
    // Was uncategorised (→ 'informational'), which filed a do-something alert under Updates.
    blog_content_decay: 'suggested_action',
    risk_assessment_submitted: 'suggested_action', billing_renewal_due: 'suggested_action',
    billing_alert: 'suggested_action', action_rejected: 'suggested_action', action_expired: 'suggested_action',
    // Issue #191 — archived assistant has a 14-day reinstate window before permanent deletion.
    assistant_archived: 'suggested_action',
    // Phase 5a §7.1 — the Strategy Agent is waiting on a human decision, and the proposal lapses
    // unread after 14 days, so it genuinely needs doing. NOT critical_action: that is undismissible,
    // and nothing here is broken — a lapsed proposal costs nothing and the agent simply re-proposes
    // when the evidence still supports it. Pinning an unkillable banner for a suggestion would be
    // the same mistake goal_metric_update_due documents below.
    //
    // (docs/strategy-agent-plan.md §6 specifies 'action_required'; no such category exists here —
    // the union is critical_action / suggested_action / state_change / informational / celebratory.)
    strategy_proposal_pending: 'suggested_action',
    // The Campaign Assistant's equivalent, and suggested_action for the same reasons: it waits on a
    // human, it expires on its own (2–14 days by kind, DECISION_TTL_DAYS), and a lapsed decision
    // costs nothing because the agent re-proposes while the evidence still holds. Uncategorised
    // types fall back to 'informational', which would file "your campaign needs a decision" under
    // Updates rather than Action required — the same mistake blog_draft_ready documents below.
    campaign_decision_pending: 'suggested_action',
    // A prospect replied. suggested_action by the same test the state_change note below states: this
    // is PARKED work that DECAYS — a warm reply loses value by the day, and nothing else in the
    // product will answer it. It is not a completed run reporting what it found.
    lead_reply_received: 'suggested_action',
    // Leads that will leave the Outreach queue on the retention clock. LAPSING, by definition —
    // the whole point of the notification is the deadline.
    leads_expiring_soon: 'suggested_action',
    // A company was excluded from every search because someone erased a prospect we held no address
    // for. state_change, NOT suggested_action: it is done, it was correct, and there is nothing the
    // reader is being asked to decide. It is here so that a company disappearing from the pipeline
    // has a cause on the record rather than being noticed as an absence weeks later.
    lead_company_blocked: 'state_change',
    // state_change — completed / changed confirmations
    billing_renewed: 'state_change', billing_payment_received: 'state_change', payment_confirmation: 'state_change',
    plan_upgraded: 'state_change', downgrade_scheduled: 'state_change', downgrade_cancelled: 'state_change',
    instagram_connected: 'state_change', linkedin_connected: 'state_change', x_connected: 'state_change',
    post_published: 'state_change', post_revised: 'state_change', post_draft_ready: 'state_change',
    // Blog Autopilot's long-form draft, mirroring post_draft_ready above. Uncategorised types fall
    // back to 'informational', which would have put a "review this draft" alert in the wrong bucket.
    blog_draft_ready: 'state_change',
    // The Newsletter Assistant's pair, mirroring blog_draft_ready and post_published exactly.
    // ⚠️ Both are state_change, NOT suggested_action, even though an unapproved issue is arguably
    // "parked": the drafting cron refuses to write a second issue while one is still waiting
    // (draft-newsletter-issues.ts rule 1), so nothing degrades and nothing expires if it is read
    // next week. Keeping "Action required" to things that are genuinely blocked is what makes
    // that tab worth opening.
    newsletter_issue_ready: 'state_change', newsletter_issue_sent: 'state_change',
    post_generation_queued: 'state_change', provisioning_complete: 'state_change', profile_sync_complete: 'state_change',
    draft_horizon_expanded: 'state_change', draft_horizon_shrunk: 'state_change',
    org_invite_accepted: 'state_change', org_joined: 'state_change',
    risk_assessment_decision: 'state_change', risk_reclassification: 'state_change',
    account_update: 'state_change', assistant_task: 'state_change', assistant_ready: 'state_change',
    // Issue #115 — Kick Off Meeting confirmed: assistant moved to actively working.
    assistant_kickoff_complete: 'state_change',
    // A saved search finished and has companies waiting to be reviewed. Shipped uncategorised, so
    // it fell to the 'informational' default and sorted below every other assistant update.
    //
    // state_change, NOT suggested_action, and the line between them is whether something is BLOCKED
    // or EXPIRES. Everything in suggested_action is broken (post_publish_failed), parked
    // (hitl_approval_required) or lapsing (strategy_proposal_pending, campaign_decision_pending).
    // A completed run is none of those: the companies sit in the Searches tab indefinitely and
    // nothing degrades if they are read next week. This is the same call post_draft_ready and
    // blog_draft_ready already make — "your assistant finished something, go look" is a
    // confirmation, not an action item — and it keeps the "Action required" tab meaning
    // genuinely blocked, which is the only thing that makes that tab worth opening.
    //
    // Its three siblings in the `assistant_tasks` preference category (assistant_task,
    // assistant_ready, assistant_kickoff_complete) are all state_change too; see
    // src/utils/notification-prefs.ts, where this type was mapped on the same day.
    search_signals_published: 'state_change',
    // Issue #191 follow-up — confirms a reinstate actually took effect.
    assistant_reinstated: 'state_change',
    goal_autonomous_adjustment: 'state_change', // SMART Goals AC3.3.3 — autonomous brief change FYI
    feature_status_change: 'state_change', // Feature Requests US06 — a backed request moved status
    // celebratory
    setup_complete: 'celebratory', milestone_unlock: 'celebratory', referral_reward: 'celebratory',
    feature_released: 'celebratory', // Feature Requests US06 — a backed request shipped
    roi_milestone: 'celebratory', // Issue #84 — ROI/break-even milestone (replaces persistent banner)
    // informational (explicit; unknown types also fall here)
    welcome: 'informational', invoice_ready: 'informational', ticket_created: 'informational',
    ticket_reply: 'informational', billing: 'informational', new_role_availability: 'informational',
    action_rate_limited: 'informational', usage_counter_drift: 'informational', system: 'informational',
    authorization_code: 'informational', page_response: 'informational',
    // A user-reported goal figure is overdue. Explicitly informational, NOT the critical_action its
    // sibling goal_data_disconnected gets: nothing is broken, no integration needs re-authenticating,
    // and the goal keeps its last-known progress until the next figure arrives. It recurs on the
    // metric's own cadence, so a monthly nudge must never be undismissible.
    goal_metric_update_due: 'informational',
};

export const categoryOf = (type: string): NotificationCategory => TYPE_CATEGORY[type] ?? 'informational';
export const priorityOf = (type: string): number => CATEGORY_PRIORITY[categoryOf(type)];
export const isDismissibleType = (type: string): boolean => CATEGORY_DISMISSIBLE[categoryOf(type)];

// The two-tab split: "Action required" = critical + suggested; "Updates" = the rest.
const ACTION_CATEGORIES = new Set<NotificationCategory>(['critical_action', 'suggested_action']);
export const kindOf = (type: string): 'action' | 'info' =>
    ACTION_CATEGORIES.has(categoryOf(type)) ? 'action' : 'info';

// ── Resolution groups ────────────────────────────────────────────────
// Each group is the set of open action items that a given success event makes moot.

// A successful payment / restored subscription clears every "your billing is broken" prompt.
export const PAYMENT_RESTORED_TYPES = [
    'billing_payment_failed', 'missing_stripe_sub',
    'stripe_cancelled_but_db_active', 'subscription_paused',
];

// An upgrade (or any move to a higher tier with active billing) clears the
// capacity / downgrade prompts that were nudging the user to upgrade.
export const PLAN_UPGRADED_TYPES = [
    'tier_mismatch',
    'assistants_paused_downgrade', 'task_limit_reached', 'task_limit_warning',
    ...PAYMENT_RESTORED_TYPES,
];

// A (re)connected / refreshed social account clears the "reconnect" prompts.
//
// The per-platform computed types (`${serviceName}_token_refresh_failed`) are NOT listed here on
// purpose: restoring X must not clear LinkedIn's still-valid reconnect prompt. Callers append the
// one type for the platform they just restored — connection-recovery.ts does this, and it is the
// resolution half the `typeOverride` comment in notify.ts always described but never had.
export const CONNECTION_RESTORED_TYPES = [
    'social_oauth_revoked', 'instagram_token_refresh_failed', 'integration_alert',
];

/**
 * The computed per-platform reconnect prompts. Kept as an explicit list (rather than derived from
 * a platform constant) because these strings are also what `categoryOf` must recognise — a type
 * nobody listed is not an error anywhere, it just quietly becomes 'informational'.
 */
export const PLATFORM_TOKEN_REFRESH_FAILED_TYPES = [
    'x_token_refresh_failed', 'linkedin_token_refresh_failed', 'facebook_token_refresh_failed',
];

// Action types whose resolution is driven by REAL completion criteria (the server
// auto-resolves them via the groups above, or onboarding completion). For these, clicking
// the CTA must only navigate + mark read — never "Done" — so the card stays open until the
// underlying problem is actually fixed (the bug where clicking a setup reminder showed Done).
// Every other action type has no completion hook yet, so it falls back to resolve-on-click.
const COMPLETION_RESOLVED_TYPES = new Set<string>([
    'onboarding_prompt', 'onboarding_incomplete',
    ...PLAN_UPGRADED_TYPES, ...CONNECTION_RESTORED_TYPES,
    // The per-platform reconnect prompts now HAVE a completion hook (connection-recovery.ts clears
    // them when the connection is actually restored), so they must not resolve on click: the CTA
    // navigates the user to the OAuth flow, and marking it Done at that moment closes the card
    // before they have reconnected anything.
    ...PLATFORM_TOKEN_REFRESH_FAILED_TYPES,
    // Issue #191 follow-up: reinstating is a separate, plan-gated action taken from the
    // assistant's detail page, not merely viewing it — resolving on click hid the "View &
    // Reinstate" CTA the moment the user opened the notification, before they'd had any
    // chance to act on it. This item now only resolves once the assistant is actually
    // reinstated (or permanently purged), same as the other completion-driven types above.
    'assistant_archived',
]);

/** True when clicking the CTA should immediately resolve the item (no completion hook exists). */
export const resolvesOnClick = (type: string): boolean =>
    kindOf(type) === 'action' && !COMPLETION_RESOLVED_TYPES.has(type);

// ── US4 — Offline email fallback (opt-in allowlist) ───────────────────
// Only these types trigger a fallback email if they go unseen (AC4.2/4.3). AC4.4 (squelch
// state_change/informational/celebratory) is satisfied automatically because every type here
// is critical/suggested. The list is deliberately CONSERVATIVE: it excludes urgent types that
// ALREADY send their own email at creation (billing dunning, review-urgency,
// instagram token refresh) so the worker can never double-send. Expand only after confirming a
// type has no existing email path. Worker also guards on fallback_email_sent_at to send once.
export const EMAIL_FALLBACK_TYPES = [
    'hitl_approval_required',  // a post is waiting for the user's approval
    'run_budget_suspended',    // assistant halted on budget
    'task_limit_reached',      // hit the plan's task cap
    'post_publish_failed',     // a scheduled post failed to publish
];

/** True when a type is eligible for the offline email fallback. */
export const hasEmailFallback = (type: string): boolean => EMAIL_FALLBACK_TYPES.includes(type);

/**
 * Mark open (unread) action notifications of the given types as resolved for one user.
 * Best-effort: never throws — auto-resolve must not break the success path that triggered it.
 * Returns the number of items cleared (0 on error or when nothing was open).
 */
export async function resolveActionNotifications(
    db: Db,
    userId: number,
    types: readonly string[],
): Promise<number> {
    if (!userId || !types.length) return 0;
    try {
        const now = new Date();
        const cleared = await db.update(notifications)
            // resolvedAt is the true "closed" signal (separate from isRead = "seen"): an item is
            // Done only once its completion criteria are met, which is exactly here.
            .set({ isRead: true, readAt: now, resolvedAt: now })
            .where(and(
                eq(notifications.userId, userId),
                eq(notifications.isRead, false),
                inArray(notifications.type, [...types]),
            ))
            .returning({ id: notifications.id });
        if (cleared.length) {
            console.log(`[notifications] auto-resolved ${cleared.length} action item(s) for user ${userId}: ${types.join(', ')}`);
        }
        return cleared.length;
    } catch (err) {
        console.error('[notifications] resolveActionNotifications failed:', err);
        return 0;
    }
}
