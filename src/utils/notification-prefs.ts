// src/utils/notification-prefs.ts
// Single source of truth for the user-facing Notification Preferences matrix.
//
// The notification system has ~60 raw `type` strings (see TYPE_CATEGORY in
// notification-actions.ts, which buckets them into the 5-category routing model).
// For the account settings UI we group those into a small set of human-readable
// PREFERENCE categories — one row per category — each controllable per channel.
//
// Channels: In-App, Email and Push are user-toggleable (Push is never locked — see
// below). SMS and WhatsApp are higher-tier only and rendered greyed-out — there is no
// per-category storage for them yet (see CHANNEL_AVAILABILITY).
//
// PUSH is Web Push through the PWA's Service Worker: a lock-screen alert on Android and
// iOS with no App Store presence. Two properties make it different from the other two,
// and both are deliberate:
//   • NO push category is ever locked. inApp and email lock the essential rows because a
//     user must not be able to miss a security or billing alert, and those channels are
//     passive — an unread bell item or an email costs nothing. A lock-screen buzz is not
//     passive, and a critical alert the user cannot silence is how an app gets its
//     notification permission revoked wholesale, which would lose them the alerts we
//     locked ON to guarantee. Locking here would be self-defeating.
//   • Defaults are TIGHTER than in-app. A bell that lists everything is useful; a phone
//     that buzzes for everything gets muted. Only rows a user would want to be
//     interrupted for default ON.
//
// A category is "locked" on a channel when the alert is essential (account/security
// and billing) — the toggle is shown but disabled and the value is forced ON. This
// mirrors the existing critical_action = undismissible rule in notification-actions.ts.
//
// Each category `key` doubles as the storage key in user_profiles.email_preferences
// and user_profiles.in_app_preferences. Keys for the previously-existing email
// categories are preserved so stored preferences carry over unchanged.

export type PrefChannel = 'inApp' | 'email' | 'push';

// Where a category's toggles are surfaced:
//   'account'   → Account Settings › Notification Preferences (BMS customer-level alerts)
//   'assistant' → the Assistant Profile drawer (alerts produced by assistants doing their work)
// Scope only controls WHERE the toggle renders — storage and delivery gating are
// unchanged (per-user, workspace-wide), so both UIs share the same endpoint and keys.
export type PrefScope = 'account' | 'assistant';

interface ChannelRule {
    locked: boolean;   // true → always ON, toggle disabled
    default: boolean;  // value when the user has no stored preference
}

export interface PrefCategory {
    key: string;
    label: string;
    description: string;
    scope: PrefScope;
    types: string[];   // raw notification `type`s this category governs
    inApp: ChannelRule;
    email: ChannelRule;
    /**
     * Web Push. Optional so adding the channel did not require touching all twelve category
     * literals at once — but read it through pushRule(), never directly, so an omitted entry
     * resolves to a defined default instead of `undefined`.
     */
    push?: ChannelRule;
}

const LOCKED_ON: ChannelRule = { locked: true, default: true };
const ON: ChannelRule = { locked: false, default: true };
const OFF: ChannelRule = { locked: false, default: false };

// Push equivalents. Never locked — see the header note on why locking a lock-screen alert is
// self-defeating. PUSH_ON is for rows worth interrupting someone for; PUSH_OFF is opt-in.
const PUSH_ON: ChannelRule = { locked: false, default: true };
const PUSH_OFF: ChannelRule = { locked: false, default: false };

/**
 * The push rule for a category, defaulting to OFF when the category has not declared one.
 *
 * Defaulting to OFF rather than to the inApp rule is the safe direction: a new category added
 * without thinking about push produces silence, not an unexpected buzz on every user's phone —
 * and a channel that surprises people gets its permission revoked at the OS level, which is not
 * recoverable from inside the product.
 */
export function pushRule(cat: PrefCategory): ChannelRule {
    return cat.push ?? PUSH_OFF;
}

// Order here is the display order in the matrix (locked/critical rows first).
export const PREF_CATEGORIES: PrefCategory[] = [
    {
        key: 'account_security',
        label: 'Account & Security',
        description: 'Sign-in alerts, security warnings, and account/organisation changes.',
        scope: 'account',
        push: PUSH_ON,  // a security alert is the canonical reason to buzz a phone
        inApp: LOCKED_ON, email: LOCKED_ON,
        types: [
            'security', 'agent_anomaly', 'account_update', 'authorization_code',
            'org_invite_accepted', 'org_joined', 'profile_sync_complete',
            'provisioning_complete', 'usage_counter_drift', 'page_response', 'action_rate_limited',
        ],
    },
    {
        key: 'payment_confirmation', // preserves the existing locked email key
        label: 'Billing & Subscription',
        description: 'Payment receipts, failed payments, and plan changes.',
        scope: 'account',
        push: PUSH_ON,  // a failed payment suspends the account — worth an interruption
        inApp: LOCKED_ON, email: LOCKED_ON,
        types: [
            'billing_payment_failed', 'missing_stripe_sub', 'stripe_cancelled_but_db_active',
            'subscription_paused', 'assistants_paused_downgrade', 'tier_mismatch',
            'run_budget_suspended', 'task_limit_reached', 'billing_cancelled',
            'task_limit_warning', 'run_cost_warning', 'billing_renewal_due', 'billing_alert',
            'billing_renewed', 'billing_payment_received', 'payment_confirmation', 'plan_upgraded',
            'downgrade_scheduled', 'downgrade_cancelled', 'billing',
        ],
    },
    {
        // A message an admin typed by hand and sent to ONE named user — never automated, never
        // bulk. Locked in-app because the alternative is worse than noisy: an unmapped type falls
        // through to FALLBACK_CATEGORY ('product_updates'), which is user-mutable, so anyone who
        // had muted product news would silently never receive it AND the admin would see a
        // successful send. There is no delivery receipt anywhere in this system to catch that.
        // Locked also matches the intent — nobody sends one of these speculatively.
        // scope:'account' is load-bearing: assistant-scope rows render only in the Assistant
        // Profile drawer, and an ad-hoc message has no assistant_id to key an override on, so it
        // would have had no visible toggle at all.
        key: 'admin_messages',
        label: 'Messages from Be More Swan',
        description: 'Direct messages from the Be More Swan team.',
        scope: 'account',
        // Email is inert today: nothing sends an admin_message email, and the type is
        // deliberately absent from EMAIL_FALLBACK_TYPES. The row is here so the channel has a
        // sane stored default if that ever changes.
        push: PUSH_ON,  // a human typed this to one named user; never automated, never bulk
        inApp: LOCKED_ON, email: ON,
        types: ['admin_message'],
    },
    {
        key: 'invoice_ready',
        label: 'Invoices',
        description: 'A new invoice is available to download.',
        scope: 'account',
        push: PUSH_OFF,  // an invoice can wait for the next time they open the app
        inApp: ON, email: ON,
        types: ['invoice_ready'],
    },
    {
        key: 'approvals',
        label: 'Approvals & Reviews',
        description: 'Posts and actions waiting for your approval, and risk reviews.',
        scope: 'assistant',
        push: PUSH_ON,  // work is BLOCKED on the user answering — the one thing they need pulling out of their day for
        inApp: ON, email: ON,
        types: [
            'hitl_approval_required', 'review_red_urgency', 'risk_assessment_submitted',
            'risk_assessment_decision', 'risk_reclassification', 'action_rejected', 'action_expired',
            // A campaign decision is exactly this category: work parked waiting on the user's
            // answer. Listed explicitly because an unmapped type falls back to 'product_updates'
            // (see FALLBACK_CATEGORY), which would let someone who muted product news silently
            // stop receiving approval requests — and would hide the toggle where nobody looks for
            // it.
            'campaign_decision_pending',
            // The Strategy Agent's equivalent, joined 2026-08-07 for the same reason. It was left
            // on the fallback when campaign_decision_pending landed because moving a LIVE type
            // between categories changes delivery for anyone who had already muted product news:
            // they start receiving strategy approvals again. That is the intended outcome — they
            // muted product announcements, not approval requests — and it turned out to be moot:
            // on 2026-08-07 NOBODY had product_updates or approvals muted on either channel, in
            // staging (44 profiles) or production (4), and there were no per-assistant approvals
            // overrides. Both categories default ON on both channels, so the move shipped as a
            // no-op for every existing user. A future move of a live type deserves the same count.
            // ⚠️ This only buys the user a real toggle because the notification is ATTRIBUTED to an
            // assistant. 'approvals' is scope:'assistant', and assistant-scope rows render only in
            // the Assistant Profile drawer (workspace.html filters them out of Account Settings),
            // where the toggle writes a per-assistant override keyed on notifications.assistant_id.
            // An unattributed row resolves to the workspace-wide value, which has no UI at all — so
            // it would have become permanently ON, strictly worse than the wrong bucket. The
            // createNotification call in netlify/functions/autonomous-strategy-agent.ts passes
            // assistantId for exactly this reason; don't drop it.
            'strategy_proposal_pending',
        ],
    },
    {
        key: 'assistant_tasks',
        label: 'Assistant Tasks & Summaries',
        description: 'Completed work, wins, and on-demand reports from your assistants.',
        scope: 'assistant',
        push: PUSH_OFF,  // a steady drip of completed work; the bell is the right home for it
        inApp: ON, email: ON,
        types: [
            'assistant_task', 'assistant_ready', 'assistant_kickoff_complete',
            // A finished saved-search run: "your search found 14 companies to review". Joined
            // 2026-08-16, having shipped unmapped — so it fell through to FALLBACK_CATEGORY
            // ('product_updates') and anyone who muted product announcements silently stopped
            // hearing that their discovery runs had produced anything. Exactly the failure the
            // campaign_decision_pending note below `approvals` describes, and there is no delivery
            // receipt anywhere in this system that would have surfaced it.
            //
            // Here rather than in `approvals` because nothing is PARKED: `approvals` is work
            // waiting on the user's answer (a draft blocked, a proposal pending), whereas a
            // completed run reporting what it found is a summary — this category's own words,
            // "completed work, wins, and reports". The user can act on it, but nothing waits.
            //
            // ⚠️ Safe to put in a scope:'assistant' category ONLY because publishSignals() in
            // process-discovery-jobs.ts passes metadata.assistantId, which the BEFORE INSERT
            // trigger stamps onto notifications.assistant_id. That id is what the per-assistant
            // override keys on; without it this row would resolve to the workspace-wide value,
            // which has no UI, and would have become permanently ON — strictly worse than the
            // wrong bucket. Don't drop it from that call site.
            'search_signals_published',
        ],
    },
    {
        key: 'content_calendar',
        label: 'Content & Publishing',
        description: 'Draft status, publishing confirmations, and failed/missed posts.',
        scope: 'assistant',
        push: PUSH_OFF,  // high volume for a publishing assistant — this is what would get the app muted
        inApp: ON, email: ON,
        types: [
            'post_published', 'post_revised', 'post_draft_ready', 'post_generation_queued',
            'post_publish_failed', 'post_missed', 'post_generation_failed',
            // NB: 'content_calendar' itself used to be listed here — that's this category's own
            // key, not a notification type. Nothing ever emitted it and it has no template, so it
            // only ever mapped to the 'informational' fallback. Removed 2026-07-18.
            'draft_horizon_expanded', 'draft_horizon_shrunk',
            // Long-form equivalents. Without these the user cannot mute blog notifications at all:
            // an uncategorised type is unreachable from the preferences matrix.
            'blog_draft_ready', 'blog_content_decay',
        ],
    },
    {
        key: 'connections',
        label: 'Connections & Integrations',
        description: 'Connected accounts, reconnection prompts, and integration alerts.',
        scope: 'assistant',
        push: PUSH_ON,  // a lapsed token silently stops the assistant working until it is fixed
        inApp: ON, email: ON,
        types: [
            'social_oauth_revoked', 'instagram_token_refresh_failed', 'instagram_rate_limited',
            'instagram_connected', 'linkedin_connected', 'x_connected', 'integration_alert',
        ],
    },
    {
        key: 'onboarding_reminders',
        label: 'Onboarding',
        description: 'Setup reminders and your welcome / setup-complete milestones.',
        scope: 'account',
        push: PUSH_OFF,  // a nudge, not an emergency
        inApp: ON, email: ON,
        types: ['welcome', 'onboarding_prompt', 'onboarding_incomplete', 'setup_complete'],
    },
    {
        key: 'new_role_availability',
        label: 'New Role Availability',
        description: "Alerts when a waitlisted assistant role becomes available.",
        scope: 'account', // catalogue/waitlist-level, not tied to a hired assistant
        push: PUSH_OFF,  // matches the historical opt-in default on the other channels
        inApp: OFF, email: OFF, // preserves the historical notify_availability default (off)
        types: ['new_role_availability'],
    },
    {
        key: 'issues_feature_requests',
        label: 'Issues & Feature Requests',
        description: 'Updates on issues you reported and feature requests you submitted or backed.',
        scope: 'account',
        push: PUSH_OFF,  // informational follow-ups
        inApp: ON, email: ON,
        types: ['issue_update', 'feature_status_change', 'feature_released'],
    },
    {
        key: 'product_updates',
        label: 'Product, Milestones & Support',
        description: 'Milestones, referrals, support replies, and product announcements.',
        scope: 'account',
        push: PUSH_OFF,  // announcements must never be a reason someone mutes the app
        inApp: ON, email: ON,
        types: ['milestone', 'milestone_unlock', 'referral_reward', 'ticket_created', 'ticket_reply', 'system'],
    },
];

// Reverse index: raw type → category. Built once.
const TYPE_TO_CATEGORY: Record<string, PrefCategory> = (() => {
    const m: Record<string, PrefCategory> = {};
    for (const cat of PREF_CATEGORIES) for (const t of cat.types) m[t] = cat;
    return m;
})();

// Fallback for any unmapped/new type — toggleable "General" bucket (never silently
// locks something, never hard-fails). product_updates is the catch-all.
const FALLBACK_CATEGORY = PREF_CATEGORIES.find(c => c.key === 'product_updates')!;

/** The preference category governing a raw notification type. */
export function categoryForType(type: string): PrefCategory {
    return TYPE_TO_CATEGORY[type] ?? FALLBACK_CATEGORY;
}

// ── Role-aware applicability of scope:'assistant' categories ──────────────────
// Some assistant-scope categories only make sense for roles that publish content.
// Non-publishing roles (Lead Generator, AR Clerk, Tier-1 Support, CRM Enricher,
// Meeting Note-Taker, Campaign Assistant) never draft or publish posts, so those categories are hidden
// in the UI and rejected on write. This is the single source of truth; the frontend
// registry mirrors it via the `hasContentPublishing` module flag
// (src/components/assistant-dashboard-registry.js). Keep the two in sync.
// blog_writer joined 2026-07-18 with Blog Autopilot: it now drafts on a cadence and publishes via
// publish-blog-posts, so it produces exactly the draft/publish notifications this category covers.
// ⚠️ campaign_orchestrator is absent DELIBERATELY, and it is the one role where that looks wrong.
// It causes posts and articles to exist, so "it should get content notifications" is a reasonable
// first instinct — but the drafts are produced BY the Social Media and Blog Writing assistants and
// already notify against those. Adding it here would send every user two alerts for one draft.
export const PUBLISHING_ROLE_KEYS: ReadonlySet<string> = new Set(['social_media_manager', 'blog_writer']);

// Assistant-scope categories that only apply to publishing roles, keyed by category key.
const PUBLISHING_ONLY_CATEGORIES: ReadonlySet<string> = new Set(['content_calendar']);

/** Is this category one whose applicability depends on the assistant's role? Cheap
 *  check so callers can skip a role lookup for always-applicable categories. */
export function isPublishingOnlyCategory(categoryKey: string): boolean {
    return PUBLISHING_ONLY_CATEGORIES.has(categoryKey);
}

/**
 * Does an assistant-scope preference category apply to an assistant of this role?
 * Unknown/legacy roleKeys (null) are treated as social — the pre-registry default —
 * so they keep every category. Non-publishing roles drop the publishing-only ones.
 */
export function assistantCategoryAppliesToRole(
    categoryKey: string, roleKey: string | null | undefined,
): boolean {
    if (!PUBLISHING_ONLY_CATEGORIES.has(categoryKey)) return true;
    if (!roleKey) return true; // legacy/unknown = social
    return PUBLISHING_ROLE_KEYS.has(roleKey);
}

type PrefMap = Record<string, boolean> | null | undefined;

// Per-assistant preference overrides (user_profiles.assistant_notif_prefs).
// Shape: { [assistantId]: { [categoryKey]: { inApp?: boolean, email?: boolean } } }.
// A missing key at any level means "use the workspace-wide preference". Only
// scope:'assistant' categories may carry overrides; locked rules still win.
export type AssistantOverrideMap =
    Record<string, Record<string, Partial<Record<PrefChannel, boolean>>>> | null | undefined;

/** The stored override for one assistant/category/channel, or undefined if none. */
export function overrideFor(
    overrides: AssistantOverrideMap, assistantId: number | string | null | undefined,
    catKey: string, channel: PrefChannel,
): boolean | undefined {
    if (assistantId == null || !overrides) return undefined;
    const v = overrides[String(assistantId)]?.[catKey]?.[channel];
    return typeof v === 'boolean' ? v : undefined;
}

function channelEnabled(prefs: PrefMap, type: string, channel: PrefChannel): boolean {
    const cat = categoryForType(type);
    // pushRule(), not cat.push — an omitted push entry must resolve to a defined default rather
    // than blowing up on `undefined.locked`.
    const rule = channel === 'push' ? pushRule(cat) : cat[channel];
    if (rule.locked) return true; // essential — always delivered
    const stored = prefs?.[cat.key];
    return typeof stored === 'boolean' ? stored : rule.default;
}

function channelEnabledFor(
    prefs: PrefMap, overrides: AssistantOverrideMap,
    assistantId: number | string | null | undefined, type: string, channel: PrefChannel,
): boolean {
    const cat = categoryForType(type);
    const rule = channel === 'push' ? pushRule(cat) : cat[channel];
    if (rule.locked) return true;
    if (cat.scope === 'assistant') {
        const o = overrideFor(overrides, assistantId, cat.key, channel);
        if (o !== undefined) return o;
    }
    return channelEnabled(prefs, type, channel);
}

/** Should this notification type appear in the in-app bell for this user? */
export const isInAppEnabled = (inAppPrefs: PrefMap, type: string): boolean =>
    channelEnabled(inAppPrefs, type, 'inApp');

/** Should an email of this notification type be sent to this user? */
export const isEmailEnabled = (emailPrefs: PrefMap, type: string): boolean =>
    channelEnabled(emailPrefs, type, 'email');

/** Should a Web Push alert of this notification type be sent to this user's devices? */
export const isPushEnabled = (pushPrefs: PrefMap, type: string): boolean =>
    channelEnabled(pushPrefs, type, 'push');

/** In-app gate honouring a per-assistant override when the row is assistant-attributed. */
export const isInAppEnabledFor = (
    inAppPrefs: PrefMap, overrides: AssistantOverrideMap,
    assistantId: number | string | null | undefined, type: string,
): boolean => channelEnabledFor(inAppPrefs, overrides, assistantId, type, 'inApp');

/** Email gate honouring a per-assistant override when the sender knows the assistant. */
export const isEmailEnabledFor = (
    emailPrefs: PrefMap, overrides: AssistantOverrideMap,
    assistantId: number | string | null | undefined, type: string,
): boolean => channelEnabledFor(emailPrefs, overrides, assistantId, type, 'email');

/** Push gate honouring a per-assistant override when the row is assistant-attributed. */
export const isPushEnabledFor = (
    pushPrefs: PrefMap, overrides: AssistantOverrideMap,
    assistantId: number | string | null | undefined, type: string,
): boolean => channelEnabledFor(pushPrefs, overrides, assistantId, type, 'push');

/** Default preference map for one channel (used for new/incomplete profiles). */
export function buildDefaults(channel: PrefChannel): Record<string, boolean> {
    return Object.fromEntries(PREF_CATEGORIES.map(
        c => [c.key, (channel === 'push' ? pushRule(c) : c[channel]).default],
    ));
}

// Effective in-app preference map: category defaults overlaid with the user's stored
// values. When the user has no stored in-app prefs yet, seed the New Role row from the
// legacy notify_availability column so an existing opt-in isn't silently lost.
export function resolveInAppPrefs(
    inAppStored: PrefMap, legacyAvailability?: boolean | null,
): Record<string, boolean> {
    const vals: Record<string, boolean> = { ...buildDefaults('inApp'), ...(inAppStored ?? {}) };
    if ((inAppStored === null || inAppStored === undefined) && typeof legacyAvailability === 'boolean') {
        vals['new_role_availability'] = legacyAvailability;
    }
    return vals;
}

// SMS / WhatsApp are not yet deliverable — higher-tier roadmap. Flip these (and add
// per-category storage) when the tier entitlement + delivery providers land.
// `push` is available as a CHANNEL wherever the browser supports it — the per-user gate is the
// OS permission plus at least one live push_subscriptions row, not a plan entitlement. SMS and
// WhatsApp remain higher-tier roadmap; flip those (and add per-category storage) when the tier
// entitlement and delivery providers land.
export const CHANNEL_AVAILABILITY = { inApp: true, email: true, push: true, sms: false, whatsapp: false } as const;
