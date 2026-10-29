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
        subject: 'Reminder: Your Be More Swan subscription renews on {{billing.renewal_date | "in 14 days"}}',
        bodyHtml: greet +
            p('Your {{billing.plan_name | "Be More Swan"}} plan will renew on <strong>{{billing.renewal_date | "in 14 days"}}</strong> for <strong>{{billing.amount}}</strong>. No action is needed to continue.') +
            // Empty (no voucher) leaves an empty paragraph, which renders as nothing visible.
            p('{{billing.voucher_details}}') +
            p('You can review or change your plan any time in billing settings.') +
            button('Manage billing', 'billing.portal_url') + signoff,
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

    // ── End of beta (src/utils/beta-ending.ts; sent ONLY by an admin from Customers → Beta testers,
    //    except beta_ended, sent by end-beta-sweep on the end date the admin set) ──────────────────
    {
        triggerKey: 'beta_ending_notice',
        name: 'Beta Ending — Notice',
        category: 'Billing',
        transactional: true,
        subject: 'Your Be More Swan beta ends on {{beta.ends_on}}',
        preheader: 'Thank you for testing — here is how to keep going.',
        bodyHtml: greet +
            p('Thank you for being one of our beta testers. Your feedback has shaped what Be More Swan is today.') +
            p('The beta for <strong>{{workspace.name | "your workspace"}}</strong> ends on <strong>{{beta.ends_on}}</strong>.') +
            p('{{beta.offer_line}}') +
            button('Keep my assistants running', 'link.action_url') +
            p('If you don’t choose a plan by then, your assistants will pause and anything scheduled will be held. Nothing is deleted — your posts, content and settings stay exactly as they are, and you can pick up where you left off whenever you subscribe.') +
            p('Questions? Just reply to this email.') + signoff,
    },
    {
        triggerKey: 'beta_ending_reminder',
        name: 'Beta Ending — Reminder',
        category: 'Billing',
        transactional: true,
        subject: 'Reminder: your Be More Swan beta ends on {{beta.ends_on}}',
        bodyHtml: greet +
            p('A quick reminder that the beta for <strong>{{workspace.name | "your workspace"}}</strong> ends on <strong>{{beta.ends_on}}</strong>.') +
            p('{{beta.offer_line}}') +
            button('Keep my assistants running', 'link.action_url') +
            p('After that date your assistants pause until you choose a plan. Nothing is deleted.') + signoff,
    },
    {
        triggerKey: 'beta_ended',
        name: 'Beta Ended',
        category: 'Billing',
        transactional: true,
        subject: 'Your Be More Swan beta has ended — your work is safe',
        bodyHtml: greet +
            p('The beta for <strong>{{workspace.name | "your workspace"}}</strong> has now ended, so your assistants are paused and anything scheduled is on hold.') +
            p('Nothing has been deleted. Choose a plan and they start again straight away — anything that fell due while they were paused comes back to you to review rather than going out late.') +
            p('{{beta.offer_line}}') +
            button('Choose a plan', 'link.action_url') + signoff,
    },

    // ── Asking for a review of Be More Swan (src/utils/platform-reviews.ts; sent ONLY by an admin
    //    from Customers → Beta testers). Free access is mentioned up front: the review form shows it
    //    beside their review too (DMCC Act 2024). No reward is offered for reviewing. ─────────────
    {
        triggerKey: 'platform_review_request',
        name: 'Review Request — Be More Swan',
        category: 'Engagement',
        subject: 'Would you tell others how Be More Swan has worked for you?',
        preheader: 'Two minutes, in your own words — good or bad.',
        bodyHtml: greet +
            p('Thank you for testing Be More Swan with <strong>{{workspace.name | "your business"}}</strong>.') +
            p('Small businesses find tools like ours by reading what other owners say. Would you write a short, honest review? Good or bad, in your own words — it helps the next owner decide, and it tells us what to fix.') +
            button('Write a review', 'link.action_url') +
            p('Because you had free access during the beta, your review will say so. That is the law, and it keeps reviews trustworthy.') +
            p('You can also find it any time under your initials, top right, then <strong>Leave a review</strong>. If you would rather not be asked, there is a button for that on the form.') + signoff,
    },

    // ── Free 14-day trial (src/utils/trial.ts; sent by trial-sweep.ts) ─────────────────────────
    {
        triggerKey: 'trial_ending_soon',
        name: 'Free Trial — Ending Soon',
        category: 'Billing',
        transactional: true,
        subject: 'Your Be More Swan free trial ends on {{trial.ends_on}}',
        preheader: 'Choose a plan to keep your assistants running.',
        bodyHtml: greet +
            p('Your free trial for <strong>{{workspace.name | "your workspace"}}</strong> ends on <strong>{{trial.ends_on}}</strong>.') +
            p('To keep your assistants working, choose a plan: <strong>The Workflow Saver</strong> ({{plans.saver_price}} a month, one assistant) or <strong>The Busywork Buster</strong> ({{plans.buster_price}} a month, every assistant). Cancel any time.') +
            button('Choose a plan', 'link.action_url') +
            p('If you don’t, nothing is charged — there is no card on file. Your assistants simply pause and anything scheduled is held. Nothing is deleted, and you can pick up where you left off whenever you subscribe.') +
            p('Questions? Just reply to this email.') + signoff,
    },
    {
        triggerKey: 'trial_ended',
        name: 'Free Trial — Ended',
        category: 'Billing',
        transactional: true,
        subject: 'Your Be More Swan free trial has ended — your work is safe',
        bodyHtml: greet +
            p('Your free trial for <strong>{{workspace.name | "your workspace"}}</strong> has ended, so your assistants are paused and anything scheduled is on hold. Nothing has been charged.') +
            p('Nothing has been deleted either. Choose a plan and they start again straight away — anything that fell due while they were paused comes back to you to review rather than going out late.') +
            button('Choose a plan', 'link.action_url') + signoff,
    },

    // ── Admin ▸ Revenue ▸ Plan moves (src/utils/plan-moves.ts) ──────────────────────────────
    // Owner, 2026-10-19: nobody's billing changes silently, and a customer on a coupon is told what
    // they will actually pay. Every value comes from the move itself — never type a price here.
    {
        triggerKey: 'plan_move_scheduled',
        name: 'Plan Change — Scheduled',
        category: 'Billing',
        transactional: true,
        subject: 'Your Be More Swan plan is changing on {{plan_move.starts_on}}',
        preheader: 'Your new plan, its price, and what happens to any discount.',
        bodyHtml: greet +
            p('We are moving <strong>{{workspace.name | "your workspace"}}</strong> from <strong>{{plan_move.from_plan}}</strong> to <strong>{{plan_move.to_plan}}</strong>.') +
            p('It starts on <strong>{{plan_move.starts_on}}</strong>, your next renewal, and the new price is <strong>{{plan_move.new_price}}</strong>. {{plan_move.price_change_line}} Nothing changes before then, and there is no extra charge or refund for the current period.') +
            p('{{plan_move.discount_line}} {{plan_move.assistants_line}}') +
            button('See your billing', 'link.action_url') +
            p('If you would rather choose a different plan, change it from your billing page before {{plan_move.starts_on}} and this change is cancelled. Questions? Just reply to this email.') + signoff,
    },

    {
        triggerKey: 'plan_move_cancelled',
        name: 'Plan Change — Cancelled',
        category: 'Billing',
        transactional: true,
        subject: 'Your Be More Swan plan is no longer changing',
        preheader: 'You stay on your current plan and price.',
        bodyHtml: greet +
            p('We told you <strong>{{workspace.name | "your workspace"}}</strong> would move from <strong>{{plan_move.from_plan}}</strong> to <strong>{{plan_move.to_plan}}</strong> on {{plan_move.starts_on}}. That change is cancelled.') +
            p('You stay on <strong>{{plan_move.from_plan}}</strong> at {{plan_move.current_price}} and nothing about your billing changes. Any discount you have carries on as before.') +
            p('Sorry for the change of plan. Questions? Just reply to this email.') + signoff,
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
        preheader: 'What your assistants got done in the last 7 days.',
        bodyHtml: greet +
            p('Here’s what your assistants got done in {{workspace.name | "your workspace"}} over the last 7 days.') +
            p('<strong>{{digest.tasks_handled}}</strong> tasks handled, about <strong>{{digest.hours_saved}} hours</strong> of work saved.') +
            p('Tasks used this month: {{digest.tasks_used}} of {{digest.task_allowance}}.') +
            button('Open your dashboard', 'link.action_url') + signoff,
    },
    {
        // The Business Mentor's weekly review (src/utils/mentor-review.ts), to owners and admins whose
        // "Business Mentor weekly review" email preference is on. The review itself is in their chat.
        triggerKey: 'mentor_weekly_review',
        name: 'Business Mentor Weekly Review',
        category: 'Engagement',
        subject: 'Your weekly review from {{assistant.name | "your Business Mentor"}}',
        preheader: '{{review.proposals | "Your week, compared with your plan"}}',
        bodyHtml: greet +
            p('{{assistant.name | "Your Business Mentor"}} has looked at your week in {{workspace.name | "your workspace"}} and compared it with your plan.') +
            p('<strong>{{review.summary}}</strong>') +
            p('There are {{review.proposals | "no suggestions"}}. Nothing changes until you choose — the full review is in your chat with {{assistant.name | "your Mentor"}}, and its suggestions are under Notifications ▸ Needs you.') +
            button('Open my review', 'link.action_url') + signoff,
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
        // The Mystery Shopper's free public taster (src/utils/site-audit.ts sendTasterEmail). Sent ONCE,
        // to the address the visitor typed, because they asked for this check — so it is transactional
        // and carries no marketing. Being added to any mailing list is a separate, optional form on the
        // page. The link opens the result (token-protected, site-taster.ts).
        triggerKey: 'site_taster_result',
        name: 'Website First-Impression Result',
        category: 'Engagement',
        transactional: true,
        subject: 'Your website scored {{site.score}} on first impression',
        preheader: 'The result of the check you asked for on {{site.host}}.',
        bodyHtml: p('Hi there,') +
            p('You asked Be More Swan’s Mystery Shopper to look at <strong>{{site.host}}</strong> the way a first-time visitor would. It scored <strong>{{site.score}}</strong> on first impression.') +
            p('Your result — what is costing you visitors, and the one change to make first — is waiting here:') +
            button('See your result', 'link.action_url') +
            p('<span style="color:#6b7280;font-size:14px;">You are getting this one email because this address was entered on bemoreswan.com to request the check. We have not added you to any mailing list. If it wasn’t you, you can ignore it.</span>') +
            signoff,
    },
    // ── Affiliate partners (src/utils/partner-applications.ts) ───────────────
    {
        triggerKey: 'partner_application_received',
        name: 'Partner Application — Received',
        category: 'Account',
        transactional: true,
        subject: 'We’ve got your Be More Swan partner application',
        preheader: 'We’ll be in touch once we’ve had a look.',
        bodyHtml: greet +
            p('Thanks for applying to become a Be More Swan partner. We read every application ourselves and will get back to you soon.') +
            p('If we approve it, we’ll email you a link to set up your partner account, where you’ll find your personal invite link and can track what you earn.') +
            p('<span style="color:#6b7280;font-size:14px;">You are getting this one email because this address was used to apply on bemoreswan.com. We have not added you to any mailing list.</span>') +
            signoff,
    },
    {
        triggerKey: 'partner_approved',
        name: 'Partner Application — Approved',
        category: 'Account',
        transactional: true,
        subject: 'You’re a Be More Swan partner',
        preheader: 'Your partner link is ready.',
        bodyHtml: greet +
            p('Good news — your application is approved. You’re now a Be More Swan partner.') +
            p('From today you earn commission when someone you invite becomes a paying customer. Sign in to find your personal invite link.') +
            button('Sign in', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'partner_approved_create_account',
        name: 'Partner Application — Approved (create account)',
        category: 'Account',
        transactional: true,
        subject: 'You’re approved — set up your Be More Swan partner account',
        preheader: 'Your private link to create your partner account.',
        bodyHtml: greet +
            p('Good news — your application to become a Be More Swan partner is approved.') +
            p('Use the button below to set up your partner account. Please use this email address — the link is private to you and works once.') +
            button('Set up my partner account', 'link.action_url') +
            p('<span style="color:#6b7280;font-size:14px;">The link expires in {{partner.link_expires_days | "14"}} days. If it has, just reply and we’ll send a new one.</span>') +
            signoff,
    },
    {
        triggerKey: 'partner_payout_confirm',
        name: 'Partner — Confirm Payout Details',
        category: 'Security',
        transactional: true,
        subject: 'Confirm your new Be More Swan payout details',
        preheader: 'Nothing changes until you confirm.',
        bodyHtml: greet +
            p('You asked to be paid your partner commission to: <strong>{{partner.payout_display}}</strong>.') +
            p('For your security, nothing changes until you confirm. You’ll need to be signed in.') +
            button('Confirm payout details', 'link.action_url') +
            p('<span style="color:#6b7280;font-size:14px;">The link works for 24 hours. If you didn’t ask for this, ignore this email and reply to let us know — your payout details stay as they are.</span>') +
            signoff,
    },
    {
        triggerKey: 'partner_payout_changed',
        name: 'Partner — Payout Details Changed',
        category: 'Security',
        transactional: true,
        subject: 'Your Be More Swan payout details were changed',
        preheader: 'If this wasn’t you, tell us straight away.',
        bodyHtml: greet +
            p('Your partner commission will now be paid to: <strong>{{partner.payout_display}}</strong>.') +
            p('If you didn’t make this change, reply to this email straight away and we’ll hold your payouts while we look into it.') +
            signoff,
    },
    {
        triggerKey: 'partner_commission_earned',
        name: 'Partner — Commission Earned',
        category: 'Account',
        transactional: true,
        subject: 'You earned {{partner.amount}} with Be More Swan',
        preheader: 'A customer you introduced just paid.',
        bodyHtml: greet +
            p('Good news — a customer you introduced just paid, and you’ve earned <strong>{{partner.amount}}</strong> in commission.') +
            p('It becomes ready to pay on <strong>{{partner.ready_on}}</strong>, once the refund window has passed, and goes out in the next monthly payout when you have at least the minimum.') +
            button('See your Partner page', 'link.action_url') + signoff,
    },
    {
        triggerKey: 'partner_payout_sent',
        name: 'Partner — Payout Sent',
        category: 'Account',
        transactional: true,
        subject: 'Your Be More Swan payout of {{partner.amount}} is on its way',
        preheader: 'Thank you for recommending Be More Swan.',
        bodyHtml: greet +
            p('We’ve paid <strong>{{partner.amount}}</strong> of partner commission to <strong>{{partner.payout_display}}</strong>. It can take a few working days to arrive.') +
            p('Thank you for recommending Be More Swan. Your Partner page shows every commission and payout.') +
            button('See your Partner page', 'link.action_url') + signoff,
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
