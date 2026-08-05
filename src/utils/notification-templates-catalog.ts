// src/utils/notification-templates-catalog.ts
// US-COMMS-2: Default catalog for every IN-APP notification.
//
// The in-app twin of email-templates-catalog.ts, and the SINGLE SOURCE OF TRUTH in two ways:
//   1. DEFAULT  — the admin "Notification Templates" UI lists these and inserts a
//      notification_templates row only on first edit ("Restore to Default" deletes it again).
//   2. FALLBACK — createNotification() renders from here whenever the DB row is missing,
//      blank, or the table isn't migrated yet, so copy can never go missing from the feed.
//
// ── Why templateKey and not notifications.type ───────────────────────────────
// `type` is NOT unique per message: 'system' alone backs 10 distinct notifications and
// 'billing' 4. It also drives category/priority/dismissibility routing (notification-actions.ts)
// and resolve-on-success matching, so it must stay code-owned. templateKey identifies ONE
// piece of copy; the type it stamps is declared here, not editable by admins.
//
// ── Variables are per-template, not global ───────────────────────────────────
// Unlike EMAIL_VARIABLES (one global list), each entry declares exactly the variables its
// call site passes. That makes the admin's "Insert variable" list accurate per template and
// lets save-time validation reject a variable the call site will never supply (AC5) — a
// stronger guarantee than a global list can give.
//
// ── Pluralisation stays at the call site ─────────────────────────────────────
// The merge engine has no plural rules. Where copy varies by count, the call site passes a
// resolved noun phrase (e.g. postCount: "3 posts" / "1 post") rather than a bare number.
// Conditional copy is split into separate keys so admins can edit each variant.

export interface NotificationVariable {
    /** Merge path, e.g. "assistant.name". */
    key: string;
    /** Human label for the admin dropdown. */
    label: string;
    /** Dummy value used by preview (AC6). */
    sample: string;
}

export interface NotificationTemplateDefault {
    /** Stable, code-owned copy id — never renamed once shipped. */
    templateKey: string;
    /** Display name in the admin list. */
    name: string;
    category:
        | 'Onboarding' | 'Billing' | 'Content' | 'Connections'
        | 'Assistants' | 'Compliance' | 'Security' | 'Support' | 'Platform';
    /** The notifications.type stamped on the row — drives routing. NOT admin-editable. */
    type: string;
    title: string;
    message: string;
    /** Exactly the variables the call site supplies. */
    variables: NotificationVariable[];
}

const v = (key: string, label: string, sample: string): NotificationVariable => ({ key, label, sample });

// Frequently reused variable declarations.
const ASSISTANT_NAME = v('assistant.name', 'Assistant name', 'Social Media Assistant');
const PLAN_NAME = v('plan.name', 'Plan name', 'Growth');
const ORG_NAME = v('org.name', 'Workspace name', 'Acme Marketing');
const PLATFORM_LABEL = v('platform.label', 'Platform name', 'LinkedIn');
const AMOUNT = v('billing.amount', 'Amount', '£49.00');

export const NOTIFICATION_DEFAULTS: NotificationTemplateDefault[] = [
    // ── Onboarding ───────────────────────────────────────────────────────────
    {
        templateKey: 'welcome_verified',
        name: 'Welcome (after verification)',
        category: 'Onboarding',
        type: 'welcome',
        title: 'Welcome to Be More Swan!',
        message: 'Thanks for registering and welcome to Be More Swan. Your workspace is ready.',
        variables: [],
    },
    {
        templateKey: 'welcome_paid',
        name: 'Welcome (after payment)',
        category: 'Onboarding',
        type: 'welcome',
        title: 'Welcome to Be More Swan!',
        message: 'Your workspace is ready. Open the Setup Wizard to build your AI assistant and go live.',
        variables: [],
    },
    {
        templateKey: 'onboarding_prompt',
        name: 'Finish workspace setup',
        category: 'Onboarding',
        type: 'onboarding_prompt',
        title: 'Finish setting up your workspace',
        message: 'Open the Setup Wizard to build your AI assistant — it walks you through every step, from your business details to going live.',
        variables: [],
    },
    {
        templateKey: 'onboarding_incomplete',
        name: 'Assistant setup incomplete',
        category: 'Onboarding',
        type: 'onboarding_incomplete',
        title: 'Complete your assistant setup',
        message: 'You have not yet completed the onboarding of your digital assistant. Pick up where you left off.',
        variables: [],
    },
    {
        templateKey: 'setup_complete',
        name: 'Setup complete',
        category: 'Onboarding',
        type: 'setup_complete',
        title: 'Setup complete 🎉',
        message: 'Your business profile and assistant are ready — your assistant is now working for you.',
        variables: [],
    },
    {
        templateKey: 'assistant_setup_received',
        name: 'Assistant setup received',
        category: 'Onboarding',
        type: 'system',
        title: 'Assistant Setup Received',
        message: '{{assistant.name}} is being built. We\'ll notify you when it\'s ready.',
        variables: [ASSISTANT_NAME],
    },

    // ── Assistants ───────────────────────────────────────────────────────────
    {
        templateKey: 'assistant_hired',
        name: 'Assistant hired',
        category: 'Assistants',
        type: 'system',
        title: '{{assistant.name}} has joined your team',
        message: '{{assistant.name}} is hired and ready — finish its setup to put it to work.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'provisioning_complete',
        name: 'Assistant provisioned',
        category: 'Assistants',
        type: 'provisioning_complete',
        title: 'Ready for Work',
        message: '{{assistant.name}} is provisioned and ready for work. Open it and Initiate Kick-Off to put it to work.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'assistant_kickoff_complete',
        name: 'Assistant kicked off',
        category: 'Assistants',
        type: 'assistant_kickoff_complete',
        title: '{{assistant.name}} is now working',
        message: '{{assistant.name}} ({{assistant.directive}}) has been kicked off and is now actively working. {{assistant.connection_sentence}}',
        variables: [
            ASSISTANT_NAME,
            v('assistant.directive', 'Directive', 'Grow inbound leads'),
            v('assistant.connection_sentence', 'Connection summary sentence', 'It is connected to LinkedIn and Gmail.'),
        ],
    },
    {
        templateKey: 'assistant_reinstated',
        name: 'Assistant reinstated',
        category: 'Assistants',
        type: 'assistant_reinstated',
        title: '"{{assistant.name}}" has been reinstated',
        message: '"{{assistant.name}}" is back in your active workspace.',
        variables: [ASSISTANT_NAME],
    },
    {
        // Signal Inbox (Phase 1a). Raised ONCE per completed discovery run, never once per lead —
        // a run can find 50, and 50 notifications for one action is how a notification centre
        // becomes something users mute. Idempotency comes from discovery_jobs.signals_published_at.
        templateKey: 'search_signals_published',
        name: 'Saved search found new signals',
        category: 'Assistants',
        type: 'search_signals_published',
        title: '{{assistant.name}} found {{search.count}} new signals',
        message: '"{{search.name}}" finished running and added {{search.count}} new signals to your inbox for review.',
        variables: [
            ASSISTANT_NAME,
            v('search.name', 'Saved search name', 'UK retreat venues'),
            v('search.count', 'Signals found', '14'),
        ],
    },
    {
        templateKey: 'assistant_archived',
        name: 'Assistant archived',
        category: 'Assistants',
        type: 'assistant_archived',
        title: '"{{assistant.name}}" has been archived',
        message: '"{{assistant.name}}" has been archived and removed from your active workspace. You have until {{archive.deletion_date}} ({{archive.grace_days}} days) to reinstate it, subject to your plan\'s assistant limit. After that date, this assistant and all of its associated data will be permanently deleted and cannot be recovered.',
        variables: [
            ASSISTANT_NAME,
            v('archive.deletion_date', 'Scheduled deletion date', '30 August 2026'),
            v('archive.grace_days', 'Grace period (days)', '30'),
        ],
    },
    {
        templateKey: 'milestone_unlock',
        name: 'Early access unlocked',
        category: 'Assistants',
        type: 'milestone_unlock',
        title: 'You\'ve unlocked early access to {{assistant.name}}!',
        message: 'You\'ve earned early access to {{assistant.name}} — you\'re in! Head to the assistant catalogue to hire this role.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'milestone_unlocked',
        name: 'Milestone unlocked',
        category: 'Assistants',
        type: 'milestone',
        title: 'Milestone Unlocked',
        message: '{{milestone.message}}',
        variables: [v('milestone.message', 'Milestone description', 'You published your first 10 posts!')],
    },
    {
        templateKey: 'roi_milestone',
        name: 'ROI milestone reached',
        category: 'Assistants',
        type: 'roi_milestone',
        title: 'Your assistants are paying for themselves!',
        message: '£{{roi.saved}} saved this month — {{roi.multiplier}}× your subscription cost — your assistants are paying for themselves.',
        variables: [
            v('roi.saved', 'Amount saved', '412.50'),
            v('roi.multiplier', 'Multiple of subscription cost', '4.2'),
        ],
    },
    {
        templateKey: 'goal_autonomous_adjustment',
        name: 'Autonomous goal adjustment',
        category: 'Assistants',
        type: 'goal_autonomous_adjustment',
        title: 'Autonomous adjustment made',
        message: 'Assistant {{assistant.name}} automatically adjusted its {{goal.label}} to improve engagement. View Changes.',
        variables: [ASSISTANT_NAME, v('goal.label', 'Adjusted setting', 'posting schedule')],
    },
    {
        // Phase 5a §7.1 — the Strategy Agent has a change to propose and is WAITING. The wording
        // has to carry that: this notification is the only thing standing between a proposal and it
        // lapsing unread after 14 days, and the whole design principle of the phase is "proposal
        // review, never apply-then-notify". Contrast goal_autonomous_adjustment above, which is a
        // state_change because the change has already happened.
        //
        // One per org per RUN, not per proposal (§9.4) — the call site passes a resolved noun
        // phrase, since the merge engine has no plural rules.
        templateKey: 'strategy_proposal_pending',
        name: 'Strategy change proposed',
        category: 'Assistants',
        type: 'strategy_proposal_pending',
        title: 'A strategy change is waiting for you',
        message: '{{assistant.name}} has {{proposal.count}} to review — {{proposal.summary}}. Nothing changes until you approve it.',
        variables: [
            ASSISTANT_NAME,
            v('proposal.count', 'Number of proposals', '1 suggested change'),
            v('proposal.summary', 'What it wants to change', 'a new Outreach Playbook based on 7 of your edits'),
        ],
    },
    {
        templateKey: 'goal_data_disconnected',
        name: 'Goal tracking paused',
        category: 'Assistants',
        type: 'goal_data_disconnected',
        title: 'Goal tracking paused',
        message: 'We lost connection to {{integration.name}}. Please re-authenticate so your assistant can continue tracking its goals.',
        variables: [v('integration.name', 'Integration name', 'Google Analytics')],
    },
    {
        // The manual-metric counterpart of goal_data_disconnected, and deliberately NOT that template.
        // Nothing is broken here and there is no integration to re-authenticate — we are simply waiting
        // on a figure only the user has. Sending the disconnection alert instead would put an
        // undismissible red "we lost connection" banner in front of someone whose goal is working
        // exactly as designed. Categorised 'informational' in notification-actions.ts for the same reason.
        templateKey: 'goal_metric_update_due',
        name: 'Goal figure due',
        category: 'Assistants',
        type: 'goal_metric_update_due',
        title: 'Time to update {{metric.label}}',
        message: 'Your goal "{{goal.label}}" tracks a figure you report yourself. Add this period\'s {{metric.label}} to keep its progress accurate.',
        variables: [
            v('goal.label', 'Goal name', 'Grow Q4 wholesale revenue'),
            v('metric.label', 'Metric name', 'Revenue (you report)'),
        ],
    },
    {
        templateKey: 'orchestration_handoff',
        name: 'Assistant hand-off',
        category: 'Assistants',
        type: 'orchestration_handoff',
        title: '{{handoff.source_name}} handed off to {{handoff.target_name}}',
        message: '{{handoff.target_name}} is now working on: {{handoff.target_action}}.',
        variables: [
            v('handoff.source_name', 'Source assistant', 'Social Media Manager'),
            v('handoff.target_name', 'Target assistant', 'Blog Writer'),
            v('handoff.target_action', 'Hand-off action', 'draft a long-form article'),
        ],
    },
    {
        templateKey: 'orchestration_limit_reached',
        name: 'Hand-off limit reached',
        category: 'Assistants',
        type: 'orchestration_limit_reached',
        title: 'Daily hand-off limit reached',
        message: 'Your assistants have reached today\'s cross-assistant hand-off limit ({{handoff.cap}}). Further hand-offs are paused until tomorrow.',
        variables: [v('handoff.cap', 'Daily hand-off cap', '25')],
    },

    // ── Content ──────────────────────────────────────────────────────────────
    {
        templateKey: 'post_generation_queued',
        name: 'Post generation queued',
        category: 'Content',
        type: 'post_generation_queued',
        title: 'Generating your post…',
        message: 'Your post is being generated. This usually takes 30–60 seconds.',
        variables: [],
    },
    {
        templateKey: 'post_generation_queued_on_demand',
        name: 'Post generation queued (on demand)',
        category: 'Content',
        type: 'post_generation_queued',
        title: 'Generating your post on demand…',
        message: 'Your post is being generated. This usually takes 30–60 seconds.',
        variables: [],
    },
    {
        templateKey: 'post_generation_queued_conversion',
        name: 'Conversion post queued',
        category: 'Content',
        type: 'post_generation_queued',
        title: 'Generating a conversion post…',
        message: '{{assistant.name}} is drafting a conversion post to invite your audience to work with you. It\'ll appear in your review queue shortly.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'post_revision_queued',
        name: 'Post revision queued',
        category: 'Content',
        type: 'post_generation_queued',
        title: 'Revising your post…',
        message: 'Your feedback was sent to the assistant. The revised draft will be ready to review shortly.',
        variables: [],
    },
    {
        templateKey: 'post_draft_ready',
        name: 'Post draft ready',
        category: 'Content',
        type: 'post_draft_ready',
        title: '{{assistant.name}}: {{platform.label}} post draft ready',
        message: 'Your {{platform.label}} post draft is ready to review.',
        variables: [ASSISTANT_NAME, PLATFORM_LABEL],
    },
    {
        templateKey: 'post_draft_ready_on_demand',
        name: 'Post draft ready (on demand)',
        category: 'Content',
        type: 'post_draft_ready',
        title: '{{assistant.name}}: {{platform.label}} post draft ready',
        message: 'Your on-demand post draft is ready to review.',
        variables: [ASSISTANT_NAME, PLATFORM_LABEL],
    },
    {
        templateKey: 'draft_ready_no_media',
        name: 'Draft ready — media needed',
        category: 'Content',
        type: 'ai_review',
        title: '{{assistant.name}}: draft ready — media needed',
        message: 'Your {{platform.label}} post draft is ready to review, but we couldn\'t source any media for it. Check the assistant\'s Media Sources settings or add media in Review.',
        variables: [ASSISTANT_NAME, PLATFORM_LABEL],
    },
    {
        templateKey: 'draft_ready_no_credits',
        name: 'Draft ready — out of AI credits',
        category: 'Content',
        type: 'ai_review',
        title: '{{assistant.name}}: draft ready — out of AI credits',
        message: 'Your {{platform.label}} post draft is ready to review, but we couldn\'t generate an AI image — your AI credit balance is empty. Top up credits or add media in Review.',
        variables: [ASSISTANT_NAME, PLATFORM_LABEL],
    },
    {
        templateKey: 'post_revised',
        name: 'Revised post ready',
        category: 'Content',
        type: 'post_revised',
        title: '{{assistant.name}}: Your revised post is ready to review',
        message: 'Your voice feedback has been applied. The revised draft is ready for your review.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'post_published',
        name: 'Post published',
        category: 'Content',
        type: 'post_published',
        title: 'Post published to {{platform.label}}',
        message: 'Your post has been published to {{platform.label}}.',
        variables: [PLATFORM_LABEL],
    },
    {
        templateKey: 'post_published_instagram',
        name: 'Post published (Instagram)',
        category: 'Content',
        type: 'post_published',
        title: 'Post published to Instagram',
        message: 'Your post has been published to Instagram — tap to view.',
        variables: [],
    },
    {
        templateKey: 'post_publish_failed',
        name: 'Post publish failed',
        category: 'Content',
        type: 'post_publish_failed',
        title: 'Post failed to publish',
        message: 'Publishing to {{platform.label}} failed: {{failure.reason}}',
        variables: [PLATFORM_LABEL, v('failure.reason', 'Failure reason', 'The access token has expired.')],
    },
    {
        templateKey: 'post_publish_failed_instagram',
        name: 'Post publish failed (Instagram)',
        category: 'Content',
        type: 'post_publish_failed',
        title: 'Post failed to publish',
        message: '{{failure.reason}}',
        variables: [v('failure.reason', 'Failure reason', 'Instagram rejected the image format.')],
    },
    {
        templateKey: 'post_generation_failed',
        name: 'Post generation failed',
        category: 'Content',
        type: 'post_generation_failed',
        title: 'Post generation failed',
        message: 'We were unable to generate your post. Please try again or contact support if the issue persists.',
        variables: [],
    },
    {
        // Sent ONCE, on the first retry of a job someone is waiting on. Without it the only
        // notification is "Generating your post…" at enqueue, so a job that failed and is retrying
        // is indistinguishable from a job that has hung — which is exactly how it was reported.
        // Deliberately not sent per attempt (that would be three notifications for one post) and
        // not sent for scheduled drafting, where nobody is watching the clock.
        templateKey: 'post_generation_retrying',
        name: 'Post generation retrying',
        category: 'Content',
        type: 'post_generation_queued',
        title: 'Still working on your post…',
        message: 'The first attempt didn\'t come back cleanly, so {{assistant.name}} is trying again. This adds a few minutes — we\'ll let you know when the draft is ready.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'instagram_rate_limited',
        name: 'Instagram publishing delayed',
        category: 'Content',
        type: 'instagram_rate_limited',
        title: 'Instagram publishing delayed',
        message: 'Some posts have been delayed due to Instagram rate limits. They will publish automatically when the limit resets.',
        variables: [],
    },
    {
        templateKey: 'post_rescheduled',
        name: 'Post rescheduled',
        category: 'Content',
        type: 'post_rescheduled',
        title: 'Post rescheduled',
        message: '{{post.confirmation}}',
        variables: [v('post.confirmation', 'Reschedule confirmation', 'Your LinkedIn post has moved to Friday at 09:00.')],
    },
    {
        templateKey: 'review_red_urgency',
        name: 'Post due soon — approval needed',
        category: 'Content',
        type: 'review_red_urgency',
        title: 'Action needed — post due soon',
        message: '{{platform.label}} post scheduled for {{post.publish_label}} needs your approval in the next {{post.hours_left}} hours or it will be missed.',
        variables: [
            PLATFORM_LABEL,
            v('post.publish_label', 'Scheduled time', 'Friday at 09:00'),
            v('post.hours_left', 'Hours remaining', '4'),
        ],
    },
    {
        templateKey: 'post_missed',
        name: 'Post missed approval window',
        category: 'Content',
        type: 'post_missed',
        title: 'Post not published — approval window passed',
        message: '{{platform.label}} post scheduled for {{post.publish_label}} was not approved in time and has not been published. You can reschedule it from your Missed Posts tab.',
        variables: [PLATFORM_LABEL, v('post.publish_label', 'Scheduled time', 'Friday at 09:00')],
    },
    {
        templateKey: 'ai_auto_publish_post',
        name: 'Post auto-scheduled',
        category: 'Content',
        type: 'ai_auto_publish',
        title: '{{assistant.name}}: {{platform.label}} post scheduled automatically',
        message: 'Autopilot scheduled a {{platform.label}} post without review. Open the calendar to change or cancel it before it goes live.',
        variables: [ASSISTANT_NAME, PLATFORM_LABEL],
    },
    {
        templateKey: 'ai_auto_publish_batch',
        name: 'Posts auto-scheduled (batch)',
        category: 'Content',
        type: 'ai_auto_publish',
        title: 'New posts scheduled automatically',
        message: 'Your AI assistant scheduled {{batch.post_count}} automatically. Open the calendar to change or cancel {{batch.them}} before {{batch.they_go}} live.',
        variables: [
            v('batch.post_count', 'Post count phrase', '3 new posts'),
            v('batch.them', '"it" or "them"', 'them'),
            v('batch.they_go', '"it goes" or "they go"', 'they go'),
        ],
    },
    {
        templateKey: 'ai_review_batch',
        name: 'New AI drafts ready',
        category: 'Content',
        type: 'ai_review',
        title: 'New AI drafts ready for review',
        message: 'Your AI assistant drafted {{batch.post_count}} for your review.',
        variables: [v('batch.post_count', 'Post count phrase', '3 new posts')],
    },
    {
        templateKey: 'ai_review_media_needed',
        name: 'Media needed for auto-drafts',
        category: 'Content',
        type: 'ai_review',
        title: 'Media needed for auto-drafts',
        message: 'Your AI assistant couldn\'t source media for {{batch.post_count}}. Check the assistant\'s Media Sources settings or add to your content library.',
        variables: [v('batch.post_count', 'Post count phrase', '3 planned posts')],
    },
    {
        templateKey: 'autopilot_schedule_unreadable',
        name: 'Autopilot schedule unreadable',
        category: 'Content',
        type: 'autopilot_schedule_unreadable',
        title: '{{assistant.name}} is not drafting — check the posting schedule',
        message: '{{assistant.name}} has a posting schedule we cannot read ("{{schedule.frequency}}"), so it has not been drafting anything. Open the assistant\'s settings and pick a posting frequency from the list to start it again.',
        variables: [ASSISTANT_NAME, v('schedule.frequency', 'Stored posting frequency', 'Every Monday, Tuesday, Wednesday, and Thursday at 8 am.')],
    },
    {
        templateKey: 'content_library_empty',
        name: 'Content library empty',
        category: 'Content',
        type: 'content_library_empty',
        title: '{{assistant.name}}: add media to keep posts flowing',
        message: '{{assistant.name}} skipped its scheduled drafts because My Content has no available media and the Empty-Library Draft Fallback is turned off. Upload new media, or switch the fallback on so it can draft with AI or stock imagery for you to review.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'media_ready',
        name: 'AI video ready',
        category: 'Content',
        type: 'media_ready',
        title: 'Your AI video is ready',
        message: 'Your generated video has been added to My Content.',
        variables: [],
    },
    {
        templateKey: 'draft_horizon_expanded',
        name: 'Draft horizon extended',
        category: 'Content',
        type: 'draft_horizon_expanded',
        title: 'Draft horizon extended',
        message: '{{assistant.name}} is generating {{horizon.draft_count}} to cover through {{horizon.to_date}}. They\'ll appear in your Review shortly.',
        variables: [
            ASSISTANT_NAME,
            v('horizon.draft_count', 'Draft count phrase', '4 new drafts'),
            v('horizon.to_date', 'Horizon end date', '30 August'),
        ],
    },
    {
        templateKey: 'draft_horizon_shrunk',
        name: 'Draft horizon shortened',
        category: 'Content',
        type: 'draft_horizon_shrunk',
        title: 'Draft horizon shortened',
        message: '{{horizon.archived_count}} beyond your new {{horizon.days}}-day window have been moved to Archived Drafts.',
        variables: [
            v('horizon.archived_count', 'Archived draft phrase', '4 unreviewed drafts'),
            v('horizon.days', 'Horizon length in days', '14'),
        ],
    },
    {
        templateKey: 'blog_draft_ready',
        name: 'Blog draft ready for review',
        category: 'Content',
        type: 'blog_draft_ready',
        title: 'New blog draft: “{{post.title}}”',
        message: '{{assistant.name}} has written a new draft for you to review before it publishes.',
        variables: [
            v('post.title', 'Post title', 'How to automate your marketing'),
            v('assistant.name', 'Assistant name', 'Marketing Mike'),
        ],
    },
    {
        templateKey: 'blog_content_decay',
        name: 'Blog traffic decay',
        category: 'Content',
        type: 'blog_content_decay',
        title: 'Traffic dropping: “{{post.title}}”',
        message: 'Search impressions for “{{post.title}}” have fallen to {{post.current_impressions}} from a peak of {{post.peak_impressions}}. Consider refreshing the post to recover its ranking.',
        variables: [
            v('post.title', 'Post title', 'How to automate your marketing'),
            v('post.current_impressions', 'Current impressions', '120'),
            v('post.peak_impressions', 'Peak impressions', '1,450'),
        ],
    },

    // ── Connections ──────────────────────────────────────────────────────────
    // NOTE: the *_connected types are matched by CONNECTION_RESTORED_TYPES in
    // notification-actions.ts to auto-resolve open "reconnect" action items. Keep the
    // declared type exactly as-is when editing these.
    {
        templateKey: 'linkedin_connected',
        name: 'LinkedIn connected',
        category: 'Connections',
        type: 'linkedin_connected',
        title: 'LinkedIn connected',
        message: 'LinkedIn connected successfully. Your assistant can now post on your behalf.',
        variables: [],
    },
    {
        templateKey: 'linkedin_reconnected',
        name: 'LinkedIn reconnected',
        category: 'Connections',
        type: 'linkedin_connected',
        title: 'LinkedIn reconnected',
        message: 'LinkedIn connected successfully. Your assistant can now post on your behalf.',
        variables: [],
    },
    {
        templateKey: 'x_connected',
        name: 'X connected',
        category: 'Connections',
        type: 'x_connected',
        title: 'X connected',
        message: 'X (Twitter) connected successfully. Your assistant can now post on your behalf.',
        variables: [],
    },
    {
        templateKey: 'x_reconnected',
        name: 'X reconnected',
        category: 'Connections',
        type: 'x_connected',
        title: 'X reconnected',
        message: 'X (Twitter) connected successfully. Your assistant can now post on your behalf.',
        variables: [],
    },
    {
        templateKey: 'instagram_connected',
        name: 'Instagram connected',
        category: 'Connections',
        type: 'instagram_connected',
        title: 'Instagram connected',
        message: 'Instagram account connected successfully. You can now schedule and publish posts.{{instagram.page_warning}}',
        variables: [v('instagram.page_warning', 'No-Facebook-Page warning (may be empty)', ' Note: No Facebook Page linked — some features may be limited.')],
    },
    {
        templateKey: 'instagram_reconnected',
        name: 'Instagram reconnected',
        category: 'Connections',
        type: 'instagram_connected',
        title: 'Instagram reconnected',
        message: 'Instagram account connected successfully. Token refreshed.',
        variables: [],
    },
    {
        templateKey: 'facebook_connected',
        name: 'Facebook connected',
        category: 'Connections',
        type: 'facebook_connected',
        title: 'Facebook connected',
        message: 'Facebook Page connected successfully ({{facebook.page_name}}). You can now schedule and publish posts.',
        variables: [v('facebook.page_name', 'Connected Facebook Page name', 'your Page')],
    },
    {
        templateKey: 'facebook_reconnected',
        name: 'Facebook reconnected',
        category: 'Connections',
        type: 'facebook_connected',
        title: 'Facebook reconnected',
        message: 'Facebook Page connected successfully ({{facebook.page_name}}). Token refreshed.',
        variables: [v('facebook.page_name', 'Connected Facebook Page name', 'your Page')],
    },
    {
        templateKey: 'x_credits_exhausted',
        name: 'X monthly limit reached',
        category: 'Connections',
        type: 'x_credits_exhausted',
        title: 'X posting paused — monthly limit reached',
        message: 'You’ve used this month’s X (Twitter) posting allowance, so new X posts are paused. They resume automatically at the start of next month — or upgrade your plan for a higher allowance.',
        variables: [],
    },
    {
        // The OTHER way X posting stops, and it needs different words. 'x_credits_exhausted' above
        // is our own ledger saying the workspace has spent its allowance — the user fixes that by
        // waiting for the reset or upgrading. This one is X's API answering 402 while our ledger
        // still showed credit: the X developer account itself is out of quota, which no plan
        // upgrade here can resolve. Telling the user to upgrade would send them to buy something
        // that cannot fix it. Same `type` so category routing and resolve-on-reconnect matching are
        // unchanged.
        templateKey: 'x_api_quota_exhausted',
        name: 'X API quota reached',
        category: 'Connections',
        type: 'x_credits_exhausted',
        title: 'X posting paused — X rejected the post',
        message: 'X declined the post because the connected X account has reached its own API posting quota. Your posts are paused and will retry automatically at the start of next month. If this is unexpected, check the X developer account’s plan and usage.',
        variables: [],
    },
    {
        templateKey: 'x_credits_purchased',
        name: 'X credits added',
        category: 'Connections',
        type: 'x_credits_purchased',
        title: 'X credits added',
        message: '{{x.credits}} X posting credits have been added to your account. Any paused X posts will resume on the next publish run.',
        variables: [v('x.credits', 'Number of X credits purchased', '1500')],
    },
    {
        templateKey: 'social_disconnected',
        name: 'Connection disconnected',
        category: 'Connections',
        type: 'social_oauth_revoked',
        title: '{{platform.label}} disconnected',
        message: '{{platform.label}} disconnected successfully.',
        variables: [PLATFORM_LABEL],
    },
    {
        templateKey: 'social_disconnected_posts_cancelled',
        name: 'Connection disconnected (posts cancelled)',
        category: 'Connections',
        type: 'social_oauth_revoked',
        title: '{{platform.label}} disconnected',
        message: '{{platform.label}} disconnected. {{cancelled.post_count}} been cancelled. Reconnect to resume publishing.',
        variables: [PLATFORM_LABEL, v('cancelled.post_count', 'Cancelled post phrase', '3 scheduled posts have')],
    },
    {
        templateKey: 'social_token_refresh_failed',
        name: 'Social connection expired',
        category: 'Connections',
        // NOTE: the call site stamps a per-service type (`${serviceName}_token_refresh_failed`)
        // so resolve-on-reconnect can match a single platform. `type` here is the fallback for
        // an unrecognised service; the call site's explicit typeOverride wins.
        type: 'social_token_refresh_failed',
        title: '{{platform.label}} connection expired',
        message: 'Your {{platform.label}} account needs to be reconnected. Any scheduled posts will not be published until you reconnect.',
        variables: [PLATFORM_LABEL],
    },
    {
        templateKey: 'instagram_token_refresh_failed',
        name: 'Instagram connection expired',
        category: 'Connections',
        type: 'instagram_token_refresh_failed',
        title: 'Instagram connection expired',
        message: 'Your Instagram account needs to be reconnected. Your scheduled posts will not be published until you reconnect.',
        variables: [],
    },
    {
        templateKey: 'integration_alert_expiring',
        name: 'Integration expiring soon',
        category: 'Connections',
        type: 'integration_alert',
        title: '{{platform.label}} connection expires in {{expiry.days_left}}',
        message: 'Your {{platform.label}} connection will expire in {{expiry.days_left}}. Re-authorise to avoid interruption.',
        variables: [PLATFORM_LABEL, v('expiry.days_left', 'Days-left phrase', '3 days')],
    },
    {
        templateKey: 'integration_alert_expired',
        name: 'Integration disconnected',
        category: 'Connections',
        type: 'integration_alert',
        title: '{{platform.label}} disconnected — action required',
        message: 'Your {{platform.label}} integration has been disconnected. Re-authorise it to keep your assistants running.',
        variables: [PLATFORM_LABEL],
    },
    {
        templateKey: 'profile_sync_complete',
        name: 'Social profile sync complete',
        category: 'Connections',
        type: 'profile_sync_complete',
        title: 'Social profile sync complete',
        message: '{{sync.summary}}',
        variables: [v('sync.summary', 'Sync summary', 'Business profile synced to LinkedIn, Facebook.')],
    },

    // ── Billing ──────────────────────────────────────────────────────────────
    {
        templateKey: 'payment_successful_setup',
        name: 'Payment successful — set up assistant',
        category: 'Billing',
        type: 'billing',
        title: 'Payment Successful — Set Up Your Assistant',
        message: 'Your subscription is active. Click "Resume Setup" on your dashboard to build your Digital Assistant now.',
        variables: [],
    },
    {
        templateKey: 'subscription_active_setup',
        name: 'Subscription active — set up assistant',
        category: 'Billing',
        type: 'billing',
        title: 'Subscription Active — Set Up Your Assistant',
        message: 'Your subscription is active. Click "Resume Setup" on your dashboard to build your Digital Assistant now.',
        variables: [],
    },
    {
        templateKey: 'invoice_ready',
        name: 'Invoice ready',
        category: 'Billing',
        type: 'invoice_ready',
        title: 'Your invoice for {{plan.name}} is ready',
        message: 'Invoice {{invoice.number}} has been generated for your {{plan.name}} subscription. View it in your Invoice History.',
        variables: [PLAN_NAME, v('invoice.number', 'Invoice number', 'INV-2026-0142')],
    },
    {
        templateKey: 'invoice_ready_renewal',
        name: 'Invoice ready (renewal)',
        category: 'Billing',
        type: 'invoice_ready',
        title: 'Your invoice for {{plan.name}} is ready',
        message: 'Invoice {{invoice.number}} has been generated. View it in your Invoice History.',
        variables: [PLAN_NAME, v('invoice.number', 'Invoice number', 'INV-2026-0142')],
    },
    {
        templateKey: 'billing_renewal_due',
        name: 'Renewal due soon',
        category: 'Billing',
        type: 'billing_renewal_due',
        title: 'Subscription Renewal Due Soon',
        message: 'Your subscription will renew on {{billing.renewal_day}}{{billing.amount_suffix}}. Make sure your payment details are up to date.',
        variables: [
            v('billing.renewal_day', 'Renewal date', '1 September 2026'),
            v('billing.amount_suffix', 'Amount clause (may be empty)', ' for £99.00'),
        ],
    },
    {
        templateKey: 'billing_renewed',
        name: 'Subscription renewed',
        category: 'Billing',
        type: 'billing_renewed',
        title: 'Subscription Renewed',
        message: 'Your subscription has been renewed successfully{{billing.charged_suffix}}{{billing.until_suffix}}',
        variables: [
            v('billing.charged_suffix', 'Charged clause (may be empty)', ' — £99.00 charged'),
            v('billing.until_suffix', 'Active-until clause', '. Active until 1 September 2026.'),
        ],
    },
    {
        templateKey: 'billing_payment_received',
        name: 'Payment received',
        category: 'Billing',
        type: 'billing_payment_received',
        title: 'Payment Received',
        message: 'A payment of {{billing.amount}} has been received and your account is up to date.',
        variables: [AMOUNT],
    },
    {
        templateKey: 'billing_payment_received_restored',
        name: 'Payment received — assistants restored',
        category: 'Billing',
        type: 'billing_payment_received',
        title: 'Payment Received — Assistants Restored',
        message: 'A payment of {{billing.amount}} has been received. Your account is back to active and your assistants have been re-enabled.',
        variables: [AMOUNT],
    },
    {
        templateKey: 'billing_payment_failed',
        name: 'Payment failed',
        category: 'Billing',
        type: 'billing_payment_failed',
        title: 'Payment Failed',
        message: 'We were unable to charge {{billing.amount}} for your subscription. {{billing.urgency}}Update your payment details in the Billing section.',
        variables: [AMOUNT, v('billing.urgency', 'Urgency clause (may be empty)', 'This was our final attempt. ')],
    },
    {
        templateKey: 'billing_payment_failed_paused',
        name: 'Payment failed — assistants paused',
        category: 'Billing',
        type: 'billing_payment_failed',
        title: 'Payment Failed — Assistants Paused',
        message: 'We were unable to charge {{billing.amount}} for your subscription. {{billing.urgency}}Update your payment details in the Billing section.',
        variables: [AMOUNT, v('billing.urgency', 'Urgency clause (may be empty)', 'This was our final attempt. ')],
    },
    {
        templateKey: 'billing_cancelled',
        name: 'Subscription cancelled',
        category: 'Billing',
        type: 'billing_cancelled',
        title: 'Subscription Cancelled — Assistants Paused',
        message: 'Your subscription has been cancelled and your Digital Assistants have been paused. You can re-subscribe at any time from the Billing area to restore full access.',
        variables: [],
    },
    {
        templateKey: 'subscription_paused_survey',
        name: 'Account paused (cancellation survey)',
        category: 'Billing',
        type: 'subscription_paused',
        title: 'Account paused — access continues until {{billing.period_end}}',
        message: 'Your subscription will not renew. You\'ll have full access until {{billing.period_end}} — come back any time and your setup will be exactly as you left it.',
        variables: [v('billing.period_end', 'Access end date', '1 September 2026')],
    },
    {
        templateKey: 'subscription_paused_admin',
        name: 'Subscription paused by admin',
        category: 'Billing',
        type: 'billing',
        title: 'Your subscription has been paused',
        message: '{{pause.message}}',
        variables: [v('pause.message', 'Pause explanation', 'Your subscription is paused until 1 September 2026.')],
    },
    {
        templateKey: 'plan_upgraded',
        name: 'Plan upgraded',
        category: 'Billing',
        type: 'plan_upgraded',
        title: 'Plan upgraded to {{plan.name}}',
        message: 'Your plan has been upgraded to {{plan.name}}. Your new limits are active immediately.',
        variables: [PLAN_NAME],
    },
    {
        templateKey: 'downgrade_scheduled',
        name: 'Downgrade scheduled',
        category: 'Billing',
        type: 'downgrade_scheduled',
        title: 'Downgrade to {{plan.name}} scheduled',
        message: 'Your plan will downgrade to {{plan.name}} on {{billing.period_end}}. Your current plan remains active until then.',
        variables: [PLAN_NAME, v('billing.period_end', 'Downgrade date', '1 September 2026')],
    },
    {
        templateKey: 'downgrade_cancelled',
        name: 'Downgrade cancelled',
        category: 'Billing',
        type: 'downgrade_cancelled',
        title: 'Scheduled downgrade cancelled',
        message: 'Your plan will continue at its current tier — no change has been made.',
        variables: [],
    },
    {
        templateKey: 'downgrade_complete',
        name: 'Downgrade complete',
        category: 'Billing',
        type: 'downgrade_complete',
        title: 'Downgrade to {{plan.name}} complete',
        message: 'Your plan has switched to {{plan.name}}. Your new limits are now active.',
        variables: [PLAN_NAME],
    },
    {
        templateKey: 'assistants_paused_downgrade',
        name: 'Assistants paused — plan limit',
        category: 'Billing',
        type: 'assistants_paused_downgrade',
        title: 'Assistants Paused — Plan Limit Reached',
        message: 'Your plan change reduced your assistant limit to {{plan.assistant_limit}}. The following {{paused.assistant_phrase}} been paused: {{paused.names}}. You can delete or swap assistants from your workspace.',
        variables: [
            v('plan.assistant_limit', 'New assistant limit', '3'),
            v('paused.assistant_phrase', '"assistant has" or "assistants have"', 'assistants have'),
            v('paused.names', 'Paused assistant names', 'Social Media Assistant, Blog Writer'),
        ],
    },
    {
        templateKey: 'task_limit_reached',
        name: 'Monthly task limit reached',
        category: 'Billing',
        type: 'task_limit_reached',
        title: 'Monthly Task Limit Reached — Your Assistants Are Paused',
        // NB: manual/on-command tasks are NOT exempt. atomicCapCheck gates every task, including
        // chat turns (chat-orchestrator.ts → consumeTaskCredit), so the old "manual tasks still
        // work" line promised something the enforcement code refuses.
        message: 'You\'ve used all {{usage.limit}} tasks included in your {{plan.tier_name}} plan for {{usage.month}}, so your assistants have paused. You are never charged for going over — the limit is a hard stop, not an overage. Upgrade to resume straight away, or your assistants restart automatically on the 1st of next month.',
        variables: [
            v('usage.limit', 'Task limit', '2,500'),
            v('plan.tier_name', 'Plan tier name', 'Growth'),
            v('usage.month', 'Month label', 'July 2026'),
        ],
    },
    {
        templateKey: 'task_limit_resumed',
        name: 'Assistants resumed after task limit',
        category: 'Billing',
        type: 'task_limit_resumed',
        title: 'Your assistants are back to work',
        message: 'Your monthly task allowance has reset, so the {{resumed.assistant_phrase}} paused when you reached your {{plan.tier_name}} limit {{resumed.verb}} been switched back on: {{resumed.names}}. Nothing else changed — any assistant you paused yourself stays paused.',
        variables: [
            v('resumed.assistant_phrase', '"assistant" or "assistants"', 'assistants'),
            v('resumed.verb', '"has" or "have"', 'have'),
            v('resumed.names', 'Resumed assistant names', 'Social Media Assistant, Blog Writer'),
            v('plan.tier_name', 'Plan tier name', 'Growth'),
        ],
    },
    {
        templateKey: 'task_limit_warning',
        name: 'Task allowance warning',
        category: 'Billing',
        type: 'task_limit_warning',
        title: 'You\'ve used {{usage.pct}}% of your monthly task allowance',
        message: 'Your {{plan.tier_name}} plan includes {{usage.limit}} tasks per month. You have used {{usage.count}} ({{usage.pct}}%) with {{usage.remaining}} remaining. Automated tasks will pause if you reach 100%. Consider upgrading for a higher limit.',
        variables: [
            v('usage.pct', 'Percent used', '80'),
            v('plan.tier_name', 'Plan tier name', 'Growth'),
            v('usage.limit', 'Task limit', '2,500'),
            v('usage.count', 'Tasks used', '2,000'),
            v('usage.remaining', 'Tasks remaining', '500'),
        ],
    },
    {
        templateKey: 'referral_reward',
        name: 'Referral token earned',
        category: 'Billing',
        type: 'referral_reward',
        title: '🎉 Referral Token Earned',
        message: 'A friend you referred just made their first payment — you\'ve earned a referral token! It unlocks after their 14-day refund window. Save up 5 for a free assistant, or redeem 1 for £10 credit.',
        variables: [],
    },
    {
        templateKey: 'payment_dispute_opened',
        name: 'Payment dispute opened (customer)',
        category: 'Billing',
        type: 'system',
        title: '⚠️ Payment Dispute Opened',
        message: 'A dispute of {{billing.amount}} has been opened on your account. Our team will be in touch. Evidence deadline: {{dispute.deadline}}.',
        variables: [AMOUNT, v('dispute.deadline', 'Evidence deadline', '1 August 2026')],
    },

    // ── Workspace & access ───────────────────────────────────────────────────
    {
        templateKey: 'org_joined',
        name: 'Joined workspace',
        category: 'Onboarding',
        type: 'org_joined',
        title: 'Welcome to {{org.name}}!',
        message: 'You\'ve successfully joined {{org.name}} as a {{org.role}}.',
        variables: [ORG_NAME, v('org.role', 'Assigned role', 'Editor')],
    },
    {
        templateKey: 'org_invite_accepted',
        name: 'Added to workspace',
        category: 'Onboarding',
        type: 'org_invite_accepted',
        title: 'You\'ve been added to {{org.name}}',
        message: '{{org.inviter_name}} has added you to {{org.name}} as a {{org.role}}.',
        variables: [ORG_NAME, v('org.inviter_name', 'Inviter name', 'Jane Doe'), v('org.role', 'Assigned role', 'Editor')],
    },
    {
        templateKey: 'domain_join_request',
        name: 'Workspace join request',
        category: 'Onboarding',
        type: 'domain_join_request',
        title: 'Workspace join request',
        message: '{{requester.label}} signed up with a {{requester.domain}} email and would like to join your workspace. Invite them to keep your team on one account?',
        variables: [
            v('requester.label', 'Requester name or email', 'jane@acme.com'),
            v('requester.domain', 'Email domain', 'acme.com'),
        ],
    },
    {
        templateKey: 'workspace_access_request',
        name: 'Connection access request',
        category: 'Onboarding',
        type: 'workspace_access_request',
        title: 'Connection access request',
        message: '{{request.message}}',
        variables: [v('request.message', 'Request detail', 'jane@acme.com would like access to your LinkedIn connection.')],
    },
    {
        templateKey: 'workspace_access_request_upgrade',
        name: 'Connection access request — upgrade needed',
        category: 'Onboarding',
        type: 'workspace_access_request',
        title: 'Connection access request — upgrade needed',
        message: '{{request.message}}',
        variables: [v('request.message', 'Request detail', 'jane@acme.com would like access, but your plan has no seats left.')],
    },

    // ── Governance / HITL ────────────────────────────────────────────────────
    {
        templateKey: 'hitl_approval_required',
        name: 'Action needs approval',
        category: 'Compliance',
        type: 'hitl_approval_required',
        title: 'Approval required: {{action.type}}',
        message: '{{action.warning}} Run #{{run.id}} proposes: {{action.type}}{{action.record_clause}}. Expires in 24 hours.',
        variables: [
            v('action.type', 'Action type', 'send_email'),
            v('action.warning', 'Warning prefix (may be empty)', 'This action is irreversible.'),
            v('run.id', 'Task run ID', '4821'),
            v('action.record_clause', 'Affected-records clause (may be empty)', ' (12 records affected)'),
        ],
    },
    {
        templateKey: 'action_rejected',
        name: 'Action rejected',
        category: 'Compliance',
        type: 'action_rejected',
        title: 'Action rejected: {{action.type}}',
        message: 'You rejected the pending {{action.type}} action for run #{{run.id}}. Reason: {{action.rejection_reason}}',
        variables: [
            v('action.type', 'Action type', 'send_email'),
            v('run.id', 'Task run ID', '4821'),
            v('action.rejection_reason', 'Rejection reason', 'Wrong recipient list'),
        ],
    },
    {
        templateKey: 'action_expired',
        name: 'Pending action expired',
        category: 'Compliance',
        type: 'action_expired',
        title: 'Pending action expired: {{action.type}}',
        message: 'The {{action.type}} action for run #{{run.id}} was not approved within 24 hours and has been automatically cancelled.',
        variables: [v('action.type', 'Action type', 'send_email'), v('run.id', 'Task run ID', '4821')],
    },
    {
        templateKey: 'action_rate_limited',
        name: 'Publishing rate limit reached',
        category: 'Compliance',
        type: 'action_rate_limited',
        title: 'Publishing rate limit reached',
        message: 'Rate limit reached for {{action.type}} actions in run #{{run.id}}. Review and release pending actions in your workspace.',
        variables: [v('action.type', 'Action type', 'publish_post'), v('run.id', 'Task run ID', '4821')],
    },
    {
        templateKey: 'run_budget_suspended',
        name: 'Run suspended — budget ceiling',
        category: 'Compliance',
        type: 'run_budget_suspended',
        title: 'Agent Run Suspended — Budget Ceiling Reached',
        message: 'Run #{{run.id}} has been suspended because it reached the {{run.suspend_reason}} ceiling. Review the run to resume or cancel.',
        variables: [v('run.id', 'Task run ID', '4821'), v('run.suspend_reason', 'Ceiling type', 'max cost')],
    },
    {
        templateKey: 'run_cost_warning',
        name: 'Run cost warning (80%)',
        category: 'Compliance',
        type: 'run_cost_warning',
        title: 'Agent Run Cost Warning — 80% of Budget Used',
        message: 'Run #{{run.id}} has used £{{run.cost}} of the £{{run.budget}} budget ({{run.pct}}%). The run will suspend if the ceiling is reached.',
        variables: [
            v('run.id', 'Task run ID', '4821'),
            v('run.cost', 'Cost so far', '0.8123'),
            v('run.budget', 'Budget ceiling', '1.00'),
            v('run.pct', 'Percent used', '81'),
        ],
    },
    {
        templateKey: 'agent_run_suspended',
        name: 'Agent run suspended (anomaly)',
        category: 'Compliance',
        type: 'agent_anomaly',
        title: '⚠ Agent Run Suspended: {{anomaly.type}} detected',
        message: 'Run #{{run.id}} has been paused due to a {{anomaly.type}} anomaly. Review the tool call sequence and manually resume when ready.',
        variables: [v('anomaly.type', 'Anomaly type', 'tool loop'), v('run.id', 'Task run ID', '4821')],
    },
    {
        templateKey: 'agent_run_terminated',
        name: 'Agent run terminated (anomaly)',
        category: 'Compliance',
        type: 'agent_anomaly',
        title: '⚠ Agent Run Terminated: {{anomaly.type}} detected',
        message: 'Run #{{run.id}} has been permanently terminated after a repeated anomaly ({{anomaly.type}}). Review the audit trail for details.',
        variables: [v('anomaly.type', 'Anomaly type', 'tool loop'), v('run.id', 'Task run ID', '4821')],
    },
    {
        templateKey: 'bias_flag_suspended',
        name: 'Bias flag — assistant suspended',
        category: 'Compliance',
        type: 'system',
        title: 'Bias flag raised — {{assistant.name}} suspended',
        message: 'A {{bias.metric}} distributional skew of {{bias.skew_pct}}% was detected in your assistant "{{assistant.name}}". It has been suspended pending investigation (Incident #{{bias.incident_id}}). Please review the bias audit report in your admin dashboard.',
        variables: [
            ASSISTANT_NAME,
            v('bias.metric', 'Skewed metric', 'sentiment'),
            v('bias.skew_pct', 'Skew percentage', '34'),
            v('bias.incident_id', 'Incident ID', '17'),
        ],
    },
    {
        templateKey: 'bias_reactivated',
        name: 'Assistant reactivated after bias review',
        category: 'Compliance',
        type: 'system',
        title: 'Assistant reactivated after bias review',
        message: 'You acknowledged the corrective actions for bias incident #{{bias.incident_id}}. The assistant has been reactivated.',
        variables: [v('bias.incident_id', 'Incident ID', '17')],
    },
    {
        templateKey: 'quarterly_bias_reminder',
        name: 'Quarterly bias review due',
        category: 'Compliance',
        type: 'system',
        title: 'Quarterly Bias Review Due',
        message: 'A quarterly review of all masterAssistant system prompts for bias is due. Please complete the review checklist in the Admin Dashboard → Bias Audit.',
        variables: [],
    },
    {
        templateKey: 'risk_assessment_submitted',
        name: 'Risk assessment submitted',
        category: 'Compliance',
        type: 'risk_assessment_submitted',
        title: 'Risk Assessment Submitted',
        message: 'A risk assessment has been submitted for master assistant #{{risk.master_assistant_id}} and requires review.',
        variables: [v('risk.master_assistant_id', 'Master assistant ID', '12')],
    },
    {
        templateKey: 'risk_assessment_approved',
        name: 'Risk assessment approved',
        category: 'Compliance',
        type: 'risk_assessment_decision',
        title: 'Risk Assessment Approved',
        message: 'Your EU AI Act conformity assessment for assistant #{{risk.master_assistant_id}} has been approved. You may now activate the assistant in EU-market workspaces.',
        variables: [v('risk.master_assistant_id', 'Master assistant ID', '12')],
    },
    {
        templateKey: 'risk_assessment_rejected',
        name: 'Risk assessment rejected',
        category: 'Compliance',
        type: 'risk_assessment_decision',
        title: 'Risk Assessment Rejected',
        message: 'Your EU AI Act conformity assessment for assistant #{{risk.master_assistant_id}} has been rejected. Please review the findings and resubmit.',
        variables: [v('risk.master_assistant_id', 'Master assistant ID', '12')],
    },
    {
        templateKey: 'sar_export_ready',
        name: 'SAR export ready',
        category: 'Compliance',
        type: 'system',
        title: '📦 SAR Export Ready — {{sar.user_email}}',
        message: 'The Subject Access Request data package for {{sar.user_email}} is ready. Download it within 72 hours.',
        variables: [v('sar.user_email', 'Subject email', 'jane@example.com')],
    },

    // ── Security (admin-facing) ──────────────────────────────────────────────
    {
        templateKey: 'security_incident_p0',
        name: 'P0 security incident',
        category: 'Security',
        type: 'security_incident_p0',
        title: '⚠ P0 Security Incident: {{incident.title}}',
        message: 'Severity: {{incident.severity}}. A security incident has been detected. Visit the Admin Portal → Breach Response to review timelines and take action.',
        variables: [
            v('incident.title', 'Incident title', 'Credential stuffing detected'),
            v('incident.severity', 'Severity', 'CRITICAL'),
        ],
    },
    {
        templateKey: 'prompt_probe_flagged',
        name: 'Prompt extraction probe flagged',
        category: 'Security',
        type: 'security',
        title: 'Prompt extraction probe flagged: {{probe.user_label}}',
        message: 'User {{probe.user_label}} has triggered {{probe.attempt_count}} probe attempt(s) in the last 24 hours. Review account and consider rate-limiting or suspending access.',
        variables: [
            v('probe.user_label', 'User label', 'jane@example.com'),
            v('probe.attempt_count', 'Attempts in 24h', '7'),
        ],
    },
    {
        templateKey: 'super_admin_promotion_approval',
        name: 'Super admin promotion approval',
        category: 'Security',
        type: 'system',
        title: '🔐 Super Admin Promotion Requires Your Approval',
        message: 'A request to promote {{promotion.target_email}} to super_admin has been initiated. Your approval is required within 24 hours. Request ID: {{promotion.request_id}}',
        variables: [
            v('promotion.target_email', 'Target email', 'jane@example.com'),
            v('promotion.request_id', 'Request ID', 'req_8f2a1c'),
        ],
    },
    {
        templateKey: 'admin_dispute_opened',
        name: 'Dispute opened (admin alert)',
        category: 'Security',
        type: 'system',
        title: '🚨 Dispute Opened — {{billing.amount}}',
        message: 'Dispute ID: {{dispute.id}}. Reason: {{dispute.reason}}. Affected user ID: {{dispute.user_id}}. Evidence deadline: {{dispute.deadline}}.',
        variables: [
            AMOUNT,
            v('dispute.id', 'Dispute ID', 'dp_1a2b3c'),
            v('dispute.reason', 'Dispute reason', 'fraudulent'),
            v('dispute.user_id', 'Affected user ID', '412'),
            v('dispute.deadline', 'Evidence deadline', '1 August 2026'),
        ],
    },
    {
        templateKey: 'billing_reconciliation_failed',
        name: 'Billing reconciliation job failed',
        category: 'Security',
        type: 'billing_alert',
        title: '🚨 Billing Reconciliation Job Failed',
        message: 'The nightly reconciliation job failed with error: {{job.error}}. Investigate within 4 hours.',
        variables: [v('job.error', 'Error message', 'Stripe API timeout')],
    },
    {
        templateKey: 'billing_reconciliation_mismatch',
        name: 'Billing reconciliation mismatches found',
        category: 'Security',
        type: 'billing_alert',
        title: '⚠️ Billing Reconciliation: {{reconciliation.mismatch_phrase}} found',
        message: 'The nightly Stripe↔DB reconciliation detected {{reconciliation.mismatch_phrase}}. Open the Reconciliation Queue in the Admin Portal to review and sync.',
        variables: [v('reconciliation.mismatch_phrase', 'Mismatch count phrase', '3 plan mismatches')],
    },

    // ── Support ──────────────────────────────────────────────────────────────
    {
        templateKey: 'ticket_created',
        name: 'Support ticket created',
        category: 'Support',
        type: 'ticket_created',
        title: 'Ticket #{{ticket.id}} Created',
        message: 'Your support request "{{ticket.subject}}" has been logged successfully.',
        variables: [v('ticket.id', 'Ticket ID', '482'), v('ticket.subject', 'Ticket subject', 'Cannot connect LinkedIn')],
    },
    {
        templateKey: 'ticket_reply',
        name: 'Support ticket reply',
        category: 'Support',
        type: 'ticket_reply',
        title: 'New reply on Ticket #{{ticket.id}}',
        message: 'Support has responded to your request: "{{ticket.subject}}".',
        variables: [v('ticket.id', 'Ticket ID', '482'), v('ticket.subject', 'Ticket subject', 'Cannot connect LinkedIn')],
    },
    {
        templateKey: 'feature_released',
        name: 'Backed feature released',
        category: 'Support',
        type: 'feature_released',
        title: '🎉 A feature you backed has shipped: {{feature.title}}',
        message: '"{{feature.title}}" is now Released. Thanks for helping shape Be More Swan.',
        variables: [v('feature.title', 'Feature title', 'Bulk post scheduling')],
    },
    {
        templateKey: 'feature_status_change',
        name: 'Backed feature status changed',
        category: 'Support',
        type: 'feature_status_change',
        title: 'Feature update: {{feature.title}}',
        message: '"{{feature.title}}" moved to {{feature.status_label}}.',
        variables: [
            v('feature.title', 'Feature title', 'Bulk post scheduling'),
            v('feature.status_label', 'New status', 'In Progress'),
        ],
    },

    // ── Issue reports (one key per status — the status-specific CTA is the copy) ──
    {
        templateKey: 'issue_fixed_ready_to_test',
        name: 'Issue fixed — ready to test',
        category: 'Support',
        type: 'issue_update',
        title: '✅ Issue #{{issue.id}} fixed — ready to test',
        message: 'We\'ve pushed a fix — could you give it another try and let us know how it goes?{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.admin_message', 'Admin note (may be empty)', ' — “Fixed in today\'s release.”'),
        ],
    },
    {
        templateKey: 'issue_more_info_required',
        name: 'Issue — more info needed',
        category: 'Support',
        type: 'issue_update',
        title: '❓ Issue #{{issue.id}} — more info needed',
        message: 'We\'d love to help, but we need a bit more detail from you first.{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.admin_message', 'Admin note (may be empty)', ' — “Which browser were you using?”'),
        ],
    },
    {
        templateKey: 'issue_fix_in_progress',
        name: 'Issue — fix in progress',
        category: 'Support',
        type: 'issue_update',
        title: '🔧 Issue #{{issue.id}} updated: {{issue.status_label}}',
        message: 'We\'ve picked this up and are working on a fix now.{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.status_label', 'Status label', 'Fix in progress'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },
    {
        templateKey: 'issue_backlog',
        name: 'Issue added to backlog',
        category: 'Support',
        type: 'issue_update',
        title: '🗂️ Issue #{{issue.id}} added to the backlog',
        message: 'We\'ve added this to our backlog and will investigate as soon as we can.{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },
    {
        templateKey: 'issue_on_hold',
        name: 'Issue placed on hold',
        category: 'Support',
        type: 'issue_update',
        title: '⏸️ Issue #{{issue.id}} placed on hold',
        message: 'We\'re putting this on hold for now while we weigh it up against other work — we\'ll come back to it.{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },
    {
        templateKey: 'issue_merge',
        name: 'Issue fix queued to merge',
        category: 'Support',
        type: 'issue_update',
        title: '🔧 Issue #{{issue.id}} updated: {{issue.status_label}}',
        message: 'The fix is done and queued to be merged to staging — nearly there!{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.status_label', 'Status label', 'Merge'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },
    {
        templateKey: 'issue_roadmap',
        name: 'Issue added to roadmap',
        category: 'Support',
        type: 'issue_update',
        title: '🗺️ Issue #{{issue.id}} added to our roadmap',
        message: 'We\'ve added your request to our roadmap — we\'ll get to it as soon as we can.{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },
    {
        templateKey: 'issue_closed',
        name: 'Issue closed',
        category: 'Support',
        type: 'issue_update',
        title: '🔧 Issue #{{issue.id}} updated: {{issue.status_label}}',
        message: 'We\'ve closed this one out. Thanks again for flagging it!{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.status_label', 'Status label', 'Closed'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },
    {
        templateKey: 'issue_updated',
        name: 'Issue updated (generic)',
        category: 'Support',
        type: 'issue_update',
        title: '🔧 Issue #{{issue.id}} updated: {{issue.status_label}}',
        message: 'There\'s an update on the issue you reported.{{issue.admin_message}}',
        variables: [
            v('issue.id', 'Issue ID', '129'),
            v('issue.status_label', 'Status label', 'Under review'),
            v('issue.admin_message', 'Admin note (may be empty)', ''),
        ],
    },

    // ── Platform ─────────────────────────────────────────────────────────────
    {
        templateKey: 'new_role_availability',
        name: 'New assistant role available',
        category: 'Platform',
        type: 'new_role_availability',
        title: 'New Role Available: {{assistant.name}}',
        message: '{{assistant.name}} is now available to hire. Visit the Assistant Catalog to get started.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'risk_reclassification',
        name: 'High-risk reclassification',
        category: 'Compliance',
        type: 'risk_reclassification',
        title: 'High-Risk Reclassification: {{assistant.name}}',
        message: '{{assistant.name}} has been reclassified as High Risk under the EU AI Act. EU-market workspaces have a 30-day grace period before enforcement begins. A conformity assessment must be submitted to continue EU deployment.',
        variables: [ASSISTANT_NAME],
    },
    {
        templateKey: 'outbound_email_sent',
        name: 'Outbound email sent by assistant',
        category: 'Platform',
        type: 'system',
        title: 'Email sent by {{assistant.name}}',
        message: 'An outbound email was sent to {{email.to}} with subject "{{email.subject}}". AI disclosure footer v{{email.footer_version}} was appended.',
        variables: [
            ASSISTANT_NAME,
            v('email.to', 'Recipient', 'lead@example.com'),
            v('email.subject', 'Subject line', 'Following up on your enquiry'),
            v('email.footer_version', 'Footer version', '2'),
        ],
    },
];

// ── Lookup helpers ───────────────────────────────────────────────────────────

const BY_KEY = new Map(NOTIFICATION_DEFAULTS.map((d) => [d.templateKey, d]));

export function getNotificationDefault(templateKey: string): NotificationTemplateDefault | undefined {
    return BY_KEY.get(templateKey);
}

/** Dummy-data context for one template's preview (AC6). */
export function sampleNotificationContext(templateKey: string): Record<string, Record<string, string>> {
    const def = BY_KEY.get(templateKey);
    const ctx: Record<string, Record<string, string>> = {};
    for (const variable of def?.variables ?? []) {
        const [group, field] = variable.key.split('.');
        (ctx[group] ||= {})[field] = variable.sample;
    }
    return ctx;
}
