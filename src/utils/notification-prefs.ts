// src/utils/notification-prefs.ts
// Single source of truth for the user-facing Notification Preferences matrix.
//
// The notification system has ~60 raw `type` strings (see TYPE_CATEGORY in
// notification-actions.ts, which buckets them into the 5-category routing model).
// For the account settings UI we group those into a small set of human-readable
// PREFERENCE categories — one row per category — each controllable per channel.
//
// Channels: In-App and Email are user-toggleable (unless locked). SMS and WhatsApp
// are higher-tier only and rendered greyed-out — there is no per-category storage
// for them yet (see CHANNEL_AVAILABILITY).
//
// A category is "locked" on a channel when the alert is essential (account/security
// and billing) — the toggle is shown but disabled and the value is forced ON. This
// mirrors the existing critical_action = undismissible rule in notification-actions.ts.
//
// Each category `key` doubles as the storage key in user_profiles.email_preferences
// and user_profiles.in_app_preferences. Keys for the previously-existing email
// categories are preserved so stored preferences carry over unchanged.

export type PrefChannel = 'inApp' | 'email';

interface ChannelRule {
    locked: boolean;   // true → always ON, toggle disabled
    default: boolean;  // value when the user has no stored preference
}

export interface PrefCategory {
    key: string;
    label: string;
    description: string;
    types: string[];   // raw notification `type`s this category governs
    inApp: ChannelRule;
    email: ChannelRule;
}

const LOCKED_ON: ChannelRule = { locked: true, default: true };
const ON: ChannelRule = { locked: false, default: true };
const OFF: ChannelRule = { locked: false, default: false };

// Order here is the display order in the matrix (locked/critical rows first).
export const PREF_CATEGORIES: PrefCategory[] = [
    {
        key: 'account_security',
        label: 'Account & Security',
        description: 'Sign-in alerts, security warnings, and account/organisation changes.',
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
        description: 'Payment receipts, failed payments, plan changes, and trial alerts.',
        inApp: LOCKED_ON, email: LOCKED_ON,
        types: [
            'billing_payment_failed', 'missing_stripe_sub', 'stripe_cancelled_but_db_active',
            'subscription_paused', 'assistants_paused_downgrade', 'trial_expired', 'tier_mismatch',
            'run_budget_suspended', 'task_limit_reached', 'billing_cancelled', 'trial_expiring_soon',
            'task_limit_warning', 'run_cost_warning', 'billing_renewal_due', 'billing_alert',
            'billing_renewed', 'billing_payment_received', 'payment_confirmation', 'plan_upgraded',
            'downgrade_scheduled', 'downgrade_cancelled', 'billing',
        ],
    },
    {
        key: 'invoice_ready',
        label: 'Invoices',
        description: 'A new invoice is available to download.',
        inApp: ON, email: ON,
        types: ['invoice_ready'],
    },
    {
        key: 'approvals',
        label: 'Approvals & Reviews',
        description: 'Posts and actions waiting for your approval, and risk reviews.',
        inApp: ON, email: ON,
        types: [
            'hitl_approval_required', 'review_red_urgency', 'risk_assessment_submitted',
            'risk_assessment_decision', 'risk_reclassification', 'action_rejected', 'action_expired',
        ],
    },
    {
        key: 'assistant_tasks',
        label: 'Assistant Tasks & Summaries',
        description: 'Completed work, wins, and on-demand reports from your assistants.',
        inApp: ON, email: ON,
        types: ['assistant_task', 'assistant_ready'],
    },
    {
        key: 'content_calendar',
        label: 'Content & Publishing',
        description: 'Draft status, publishing confirmations, and failed/missed posts.',
        inApp: ON, email: ON,
        types: [
            'post_published', 'post_revised', 'post_draft_ready', 'post_generation_queued',
            'post_publish_failed', 'post_missed', 'post_generation_failed',
            'content_calendar', 'draft_horizon_expanded', 'draft_horizon_shrunk',
        ],
    },
    {
        key: 'connections',
        label: 'Connections & Integrations',
        description: 'Connected accounts, reconnection prompts, and integration alerts.',
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
        inApp: ON, email: ON,
        types: ['welcome', 'onboarding_prompt', 'onboarding_incomplete', 'setup_complete'],
    },
    {
        key: 'new_role_availability',
        label: 'New Role Availability',
        description: "Alerts when a waitlisted assistant role becomes available.",
        inApp: OFF, email: OFF, // preserves the historical notify_availability default (off)
        types: ['new_role_availability'],
    },
    {
        key: 'issues_feature_requests',
        label: 'Issues & Feature Requests',
        description: 'Updates on issues you reported and feature requests you submitted or backed.',
        inApp: ON, email: ON,
        types: ['issue_update', 'feature_status_change', 'feature_released'],
    },
    {
        key: 'product_updates',
        label: 'Product, Milestones & Support',
        description: 'Milestones, referrals, support replies, and product announcements.',
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

type PrefMap = Record<string, boolean> | null | undefined;

function channelEnabled(prefs: PrefMap, type: string, channel: PrefChannel): boolean {
    const cat = categoryForType(type);
    const rule = cat[channel];
    if (rule.locked) return true; // essential — always delivered
    const stored = prefs?.[cat.key];
    return typeof stored === 'boolean' ? stored : rule.default;
}

/** Should this notification type appear in the in-app bell for this user? */
export const isInAppEnabled = (inAppPrefs: PrefMap, type: string): boolean =>
    channelEnabled(inAppPrefs, type, 'inApp');

/** Should an email of this notification type be sent to this user? */
export const isEmailEnabled = (emailPrefs: PrefMap, type: string): boolean =>
    channelEnabled(emailPrefs, type, 'email');

/** Default preference map for one channel (used for new/incomplete profiles). */
export function buildDefaults(channel: PrefChannel): Record<string, boolean> {
    return Object.fromEntries(PREF_CATEGORIES.map(c => [c.key, c[channel].default]));
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
export const CHANNEL_AVAILABILITY = { inApp: true, email: true, sms: false, whatsapp: false } as const;
