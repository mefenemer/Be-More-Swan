// src/utils/email-templates-catalog.ts
// US-COMMS-1: Default catalog for every system email trigger.
//
// This catalog is the SINGLE SOURCE OF TRUTH in two ways:
//   1. SEED — db/email-templates.sql (and the admin "restore defaults" path) seed the
//      email_templates table from these entries.
//   2. FALLBACK — sendTemplatedEmail() falls back to the matching entry here whenever the
//      DB row is missing or empty, so a not-yet-seeded or accidentally-blanked template can
//      NEVER drop a transactional email (esp. billing/security/compliance).
//
// Bodies are INNER content only — the immutable brand shell is added by renderMasterTemplate
// at send time. Subjects and bodies may contain {{merge}} tags (see EMAIL_VARIABLES). Use the
// fallback form {{user.first_name | "there"}} for anything that can be null.
//
// triggerKey is a stable, code-owned identifier (AC3.2.1) — never renamed once shipped.

export interface EmailTemplateDefault {
    triggerKey: string;
    name: string;
    category: 'Onboarding' | 'Billing' | 'Security' | 'Lifecycle' | 'Engagement' | 'Compliance' | 'Account';
    subject: string;
    /** Inner body HTML (no <html>/<body> wrapper). */
    bodyHtml: string;
    preheader?: string;
    /** Transactional mail (auth, security, billing receipts) — omits the unsubscribe link. */
    transactional?: boolean;
    /** Critical triggers that admins must not be able to deactivate (AC3.2.2). */
    locked?: boolean;
}

// Small helpers to keep the catalog readable and consistent.
const p = (s: string) => `<p style="margin:0 0 16px;">${s}</p>`;
const greet = `${p('Hi {{user.first_name | "there"}},')}`;
const signoff = p('— The Be More Swan Team');
const button = (label: string, urlVar: string) =>
    `<p style="margin:24px 0;"><a href="{{${urlVar}}}" style="background:#0f766e;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">${label}</a></p>`;

export const TEMPLATE_DEFAULTS: EmailTemplateDefault[] = [
    // ── Onboarding & assistant lifecycle ─────────────────────────────────────
    {
        triggerKey: 'assistant_ready',
        name: 'Assistant Ready',
        category: 'Onboarding',
        subject: '{{assistant.name | "Your assistant"}} is ready!',
        preheader: 'Your new assistant is live and ready to work.',
        bodyHtml: greet +
            p('Great news — <strong>{{assistant.name}}</strong>, your {{assistant.role | "AI assistant"}}, is now live and ready to get to work in {{workspace.name | "your workspace"}}.') +
            button('Open your dashboard', 'link.action_url') +
            signoff,
    },
    {
        triggerKey: 'assistant_live',
        name: 'Assistant Now Live',
        category: 'Onboarding',
        subject: '{{assistant.name}} is now Live on Be More Swan!',
        bodyHtml: greet +
            p('<strong>{{assistant.name}}</strong> has been switched to <strong>Live</strong> and is now actively handling {{assistant.role | "its role"}} for {{workspace.name | "your workspace"}}.') +
            button('View activity', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'assistant_failed',
        name: 'Assistant Setup Failed',
        category: 'Onboarding',
        subject: 'There was an issue setting up your assistant',
        bodyHtml: greet +
            p('We hit a snag while finishing the setup of <strong>{{assistant.name | "your assistant"}}</strong>. Our team has been alerted, and no action is needed from you right now.') +
            p('If this persists, reply to this email and we will sort it out.') + signoff,
    },
    {
        triggerKey: 'assistant_waiting',
        name: 'Finish Assistant Setup',
        category: 'Onboarding',
        subject: 'Action required: Finish setting up your Be More Swan Assistant',
        bodyHtml: greet +
            p('Your assistant is almost ready — there are just a couple of steps left to complete setup.') +
            button('Finish setup', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'onboarding_reminder_24h',
        name: 'Onboarding Reminder (24h)',
        category: 'Onboarding',
        subject: 'Your Digital Assistant is waiting for you',
        bodyHtml: greet +
            p('You started setting up your Be More Swan assistant but haven’t finished yet. It only takes a few minutes to get up and running.') +
            button('Continue setup', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'onboarding_reminder_72h',
        name: 'Onboarding Reminder (72h)',
        category: 'Onboarding',
        subject: 'Your assistant is waiting — here’s how to finish',
        bodyHtml: greet +
            p('Your assistant is still waiting in {{workspace.name | "your workspace"}}. Pick up right where you left off.') +
            button('Finish setup', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'abandoned_draft',
        name: 'Abandoned Draft Nudge',
        category: 'Onboarding',
        subject: 'Your Be More Swan assistant draft is still here',
        bodyHtml: greet +
            p('We saved your progress. Your assistant draft will be kept for a little longer if you’d like to come back and finish it.') +
            button('Resume draft', 'link.action_url') + signoff,
    },

    // ── Auth & account (transactional) ───────────────────────────────────────
    {
        triggerKey: 'magic_link',
        name: 'Login Link',
        category: 'Account',
        transactional: true,
        locked: true,
        subject: 'Your Be More Swan Login Link',
        bodyHtml: greet +
            p('Click the button below to securely sign in to your Be More Swan account. This link expires shortly and can only be used once.') +
            button('Sign in', 'link.action_url') +
            p('<span style="color:#6b7280;font-size:14px;">If you didn’t request this, you can safely ignore this email.</span>'),
    },
    {
        triggerKey: 'email_verify',
        name: 'Verify Email Address',
        category: 'Account',
        transactional: true,
        locked: true,
        subject: 'Confirm your new Be More Swan email address',
        bodyHtml: greet +
            p('Please confirm this email address to keep your Be More Swan account secure.') +
            button('Confirm email', 'link.action_url'),
    },
    {
        triggerKey: 'email_change_requested',
        name: 'Email Change Requested',
        category: 'Security',
        transactional: true,
        locked: true,
        subject: 'Email address change requested on your Be More Swan account',
        bodyHtml: greet +
            p('We received a request to change the email address on your account. If this was you, no action is needed. If it wasn’t, please contact support immediately.') + signoff,
    },
    {
        triggerKey: 'account_locked',
        name: 'Account Temporarily Locked',
        category: 'Security',
        transactional: true,
        locked: true,
        subject: 'Your Be More Swan account has been temporarily locked',
        bodyHtml: greet +
            p('For your security, your account was temporarily locked after multiple sign-in attempts. You can try again shortly, or reset access using the link below.') +
            button('Regain access', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'account_delete_request',
        name: 'Account Deletion Requested',
        category: 'Account',
        transactional: true,
        locked: true,
        subject: 'Account deletion requested — cancel within 24 hours',
        bodyHtml: greet +
            p('We’ve received a request to delete your Be More Swan account. This will permanently remove your data after 24 hours.') +
            p('If you did not request this, click below to cancel immediately.') +
            button('Cancel deletion', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'account_removed',
        name: 'Account Removed',
        category: 'Account',
        transactional: true,
        locked: true,
        subject: 'Your Be More Swan account has been removed',
        bodyHtml: greet +
            p('Your Be More Swan account and associated data have been removed as requested. We’re sorry to see you go.') + signoff,
    },
    {
        triggerKey: 'data_erased',
        name: 'Data Erased (GDPR)',
        category: 'Compliance',
        transactional: true,
        locked: true,
        subject: 'Your Be More Swan account data has been erased',
        bodyHtml: greet +
            p('As requested, the personal data associated with your account has been erased in line with our data protection obligations.') + signoff,
    },
    {
        triggerKey: 'invite_member',
        name: 'Team Invitation',
        category: 'Account',
        transactional: true,
        subject: 'You’ve been invited to join {{workspace.name | "a workspace"}} on Be More Swan',
        bodyHtml: p('Hi there,') +
            p('You’ve been invited to join <strong>{{workspace.name}}</strong> on Be More Swan. Accept your invitation to get started.') +
            button('Accept invitation', 'link.action_url') + signoff,
    },

    // ── Billing (transactional) ──────────────────────────────────────────────
    {
        triggerKey: 'payment_failed',
        name: 'Payment Failed',
        category: 'Billing',
        transactional: true,
        locked: true,
        subject: 'Payment failed — please update your details',
        bodyHtml: greet +
            p('We were unable to process your subscription payment of <strong>{{billing.amount}}</strong>.') +
            p('Please update your payment details to avoid any interruption to your assistants.') +
            button('Update payment details', 'billing.portal_url') + signoff,
    },
    {
        triggerKey: 'subscription_paused',
        name: 'Subscription Paused',
        category: 'Billing',
        transactional: true,
        locked: true,
        subject: 'Your assistants are paused — update payment to restore access',
        bodyHtml: greet +
            p('Because we couldn’t process your payment, your assistants have been paused. Update your billing details to restore access right away.') +
            button('Restore access', 'billing.portal_url') + signoff,
    },
    {
        triggerKey: 'final_notice',
        name: 'Final Cancellation Notice',
        category: 'Billing',
        transactional: true,
        locked: true,
        subject: 'Final notice — your account will be cancelled tomorrow',
        bodyHtml: greet +
            p('This is a final reminder that your Be More Swan subscription will be cancelled tomorrow due to a failed payment. Update your details now to keep your assistants running.') +
            button('Update payment details', 'billing.portal_url') + signoff,
    },
    {
        triggerKey: 'renewal_reminder',
        name: 'Renewal Reminder (14 days)',
        category: 'Billing',
        subject: 'Reminder: Your Be More Swan subscription renews in 14 days',
        bodyHtml: greet +
            p('Your {{billing.plan_name | "subscription"}} will renew in 14 days for <strong>{{billing.amount}}</strong>. No action is needed to continue.') +
            p('You can review or change your plan any time in billing settings.') +
            button('Manage billing', 'billing.portal_url') + signoff,
    },
    {
        triggerKey: 'trial_ending',
        name: 'Trial Ending',
        category: 'Billing',
        subject: 'Your Be More Swan trial is ending soon',
        bodyHtml: greet +
            p('Your trial is ending soon. Choose a plan to keep {{assistant.name | "your assistant"}} working without interruption.') +
            button('Choose a plan', 'billing.portal_url') + signoff,
    },
    {
        triggerKey: 'billing_override',
        name: 'Billing Adjustment',
        category: 'Billing',
        transactional: true,
        subject: 'An update to your Be More Swan billing',
        bodyHtml: greet +
            p('We’ve made an adjustment to your billing. You can review the details in your billing portal.') +
            button('View billing', 'billing.portal_url') + signoff,
    },

    // ── Engagement & lifecycle ───────────────────────────────────────────────
    {
        triggerKey: 'win_back',
        name: 'Win-Back',
        category: 'Engagement',
        subject: 'You were checking out our plans — here’s a hand',
        bodyHtml: greet +
            p('We noticed you were exploring Be More Swan. If you have any questions about which plan fits, just reply — we’re happy to help.') +
            button('Explore plans', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'weekly_digest',
        name: 'Weekly Digest',
        category: 'Engagement',
        subject: 'Your Be More Swan week in review',
        bodyHtml: greet +
            p('Here’s a quick summary of what your assistants got done this week in {{workspace.name | "your workspace"}}.') +
            button('View full report', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'post_due',
        name: 'Post Approval Due',
        category: 'Engagement',
        subject: 'Action needed: a post is awaiting your approval',
        bodyHtml: greet +
            p('A scheduled post needs your approval before it can go out. Review it now to keep your content on schedule.') +
            button('Review post', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'post_missed',
        name: 'Post Missed',
        category: 'Engagement',
        subject: 'A scheduled post was missed',
        bodyHtml: greet +
            p('A scheduled post couldn’t be published because it wasn’t approved in time. You can reschedule it from your dashboard.') +
            button('Reschedule', 'link.action_url') + signoff,
    },

    // ── Security & compliance ────────────────────────────────────────────────
    {
        triggerKey: 'integration_reconnect',
        name: 'Reconnect Integration',
        category: 'Security',
        subject: 'Action needed: Reconnect your {{integration.name | "integration"}}',
        bodyHtml: greet +
            p('Your connection to <strong>{{integration.name | "an integration"}}</strong> has expired or been disconnected. Reconnect it so your assistant can keep working.') +
            button('Reconnect now', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'credentials_revoked',
        name: 'Credentials Revoked',
        category: 'Security',
        transactional: true,
        locked: true,
        subject: 'Security Notice: Your connected app credentials have been revoked',
        bodyHtml: greet +
            p('As a security precaution, the credentials for one or more connected apps have been revoked. You may need to reconnect them to resume normal operation.') + signoff,
    },
    {
        triggerKey: 'security_incident',
        name: 'Security Incident Notice',
        category: 'Security',
        transactional: true,
        locked: true,
        subject: 'Important security notice about your Be More Swan account',
        bodyHtml: greet +
            p('We’re writing to inform you of a security matter that may affect your account. Please review the details and follow any recommended steps.') + signoff,
    },
    {
        triggerKey: 'data_export_ready',
        name: 'Data Export Ready',
        category: 'Compliance',
        transactional: true,
        subject: 'Your Be More Swan data export is ready',
        bodyHtml: greet +
            p('Your data export is ready to download. For security, the link below will expire after a short time.') +
            button('Download export', 'link.action_url') + signoff,
    },
];

/** Look up a default by trigger key (used as the send-time fallback). */
export function getTemplateDefault(triggerKey: string): EmailTemplateDefault | undefined {
    return TEMPLATE_DEFAULTS.find((t) => t.triggerKey === triggerKey);
}
