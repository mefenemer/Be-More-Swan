/**
 * src/components/assistant-dashboard-registry.js
 *
 * Post-hire dashboard configuration for assistant-detail.html, keyed by the
 * assistant's roleKey (db/seed-catalog.ts — snake_case, verbatim). Each entry
 * declares the four Performance Metric (KPI) cards and which social-specific
 * UI modules the page should show — so an AR Clerk isn't offered an Instagram
 * strategy or a Review Queue.
 *
 * Usage (assistants.js → _applyDashboardRegistry):
 *   const cfg = window.AssistantDashboardRegistry.get(roleKey);
 *   cfg.kpis     // → [{ label, title, desc }, …4] injected into #kpi-N-label/-title/-desc
 *   cfg.modules  // → per-role UI toggles. Anything omitted defaults to SHOWN (!== false), so the
 *                //   social_media_manager entry can leave them all out; non-social roles set the
 *                //   social-only ones false. Keys:
 *                //     hasReviewQueue, hasPostingSchedule, hasSocialStrategy   (original 3)
 *                //     hasImpactRoi            → Overview "Impact & ROI" card (post-based ROI)
 *                //     hasCreativeBrief        → Profile ▸ Creative Brief social cards
 *                //                               (Objective & Message, Audience & Voice, Reference)
 *                //     hasSalesContext         → Profile ▸ Creative Brief ▸ Sales Context card
 *                //     hasContentAutomation    → the Automation main tab (post/media autonomy)
 *                //     hasEmptyLibraryFallback → Profile ▸ Brand Safety ▸ Empty-Library Draft card
 *                //     hasReviewCadence        → Profile ▸ Notifications ▸ Review-alert cadence card
 *                //     hasContentPublishing    → Profile ▸ Notifications ▸ "Content & Publishing"
 *                //                               preference (post/draft alerts — social-only)
 *   cfg.primaryAction // → Overview's primary button { label, kind }. kind: 'generate_post' opens the
 *                //   post sheet (social); 'chat' opens the assistant's chat intake (Data Hub roles).
 *   cfg.reviewQueue // → the Review Queue tab's data model (ALWAYS present — every assistant has a
 *                //   review/approve gate). Shape: { kind: 'posts' | 'records', recordType? }.
 *                //   'posts'   → scheduled_posts lifecycle (social/blog), rendered by _detailRq*.
 *                //   'records' → assistant_records awaiting approval (approval_status), recordType
 *                //               matches hubTab.recordType.
 *   cfg.hubTab   // → the Data Hub tab config (ALWAYS present — every assistant has a workspace).
 *                //   kind: 'records' (default) → assistant_records table (Leads/Ledger/Tickets/…);
 *                //   kind: 'content_library'   → the social/blog post library, with source:
 *                //   'social_drafts' (scheduled_posts) | 'blog_posts'. See assistant-data-hub.js.
 *   cfg.kbTab    // → optional Knowledge Base tab config (assistant-knowledge-base.js);
 *                //   only tier1_support_agent has one — { label, description }
 *   cfg.inspoTab // → optional Inspo tab config (assistant-inspo.js); the content roles
 *                //   (social_media_manager, blog_writer) only — { label, description }
 *   cfg.myContentTab // → optional My Content tab config (assistant-my-content.js); the content
 *                //   roles (social_media_manager, blog_writer) only — { label }. Reuses the
 *                //   org-wide content library (my-content.html/.js), not assistant-scoped.
 *
 * UNIFORM TEMPLATE: every role exposes the same four core tabs in the same order —
 *   Overview · Data Hub · Review Queue · Calendar — so the layout builds user muscle
 *   memory. Only labels/content differ per role (via hubTab/reviewQueue). Calendar needs
 *   no registry config (assistant-calendar.js scopes the global calendar to this assistant).
 *   Secondary tabs (Goals, Automation, Activity, KB, Inspo, My Content) follow the core four
 *   and stay role-gated via `modules` (Automation) / `kbTab` (Knowledge Base) /
 *   `inspoTab` (Inspo) / `myContentTab` (My Content).
 *
 * hubTab shape:
 *   { id, label, recordType,            // recordType matches assistant_records.record_type
 *     description,                      // one-liner under the tab heading
 *     columns: [{ key, label }],        // table columns, key into record.data (or 'title'/'status'/'updatedAt')
 *     importHint,                       // CSV-import helper copy (Spreadsheet Fallback)
 *     importColumns: [ ... ] }          // suggested CSV headers, shown in the import panel
 *
 * Unknown or missing roleKeys fall back to the `social_media_manager` entry —
 * legacy assistants (hired before roleKey existed) are all Social Media
 * Managers, so the historic hardcoded layout is the correct generic default.
 * Adding a new assistant? Add its roleKey here; until then it inherits the
 * default dashboard.
 */
(function () {
  'use strict';

  const REGISTRY = {
    social_media_manager: {
      kpis: [
        {
          label: 'Engagement Rate by Reach',
          title: 'The Thumb Stopper',
          desc: 'Of everyone who saw your content, how many actually stopped to engage with it.',
        },
        {
          label: 'Organic Reach Growth',
          title: 'Escaping the Echo Chamber',
          desc: 'How far your content is spreading beyond your existing followers into new audiences.',
        },
        {
          label: 'Click-Through Rate',
          title: 'The "Pack Your Bags" Metric',
          desc: 'How many viewers clicked through and took the action your content asked for.',
        },
        {
          label: 'Meaningful Engagement',
          title: 'Saves, Shares & DMs',
          desc: 'The signals that convert trust into business — weighed above likes and view count.',
        },
      ],
      modules: { hasReviewQueue: true, hasPostingSchedule: true, hasSocialStrategy: true },
      primaryAction: { label: 'Create a Post', kind: 'generate_post' },
      // The Review Queue IS the social command centre — surfaced as "Posts" and used as the
      // landing tab (defaultMainTab) so users open straight into their content pipeline.
      reviewQueue: { kind: 'posts', label: 'Posts' },
      defaultMainTab: 'review-queue',
      // The old "Content Library" Data Hub tab is retired for social — the Posts pipeline is the
      // single home for every drafted/scheduled/published post, so the separate library tab is hidden.
      hideDataHub: true,
      // Data Hub = the content library: every post this assistant has drafted, across the
      // whole lifecycle (draft → scheduled → published). Backed by scheduled_posts via
      // get-social-drafts (assistant-data-hub.js content_library kind), not assistant_records.
      hubTab: {
        id: 'datahub',
        kind: 'content_library',
        source: 'social_drafts',
        label: 'Content Library',
        recordType: null,
        description: 'Every post this assistant has drafted — browse the full library across drafts, scheduled and published.',
        columns: [
          { key: 'title', label: 'Post' },
          { key: 'platform', label: 'Platform' },
          { key: 'status', label: 'Status' },
          { key: 'updatedAt', label: 'Updated' },
        ],
      },
      // Inspo tab (assistant-inspo.js) — the styles/tones/ideas this assistant studies
      // and keeps applying, so the user stops re-explaining their taste every time.
      inspoTab: {
        label: 'Inspo',
        description: 'The styles, tones and ideas you want your posts to sound like. Add a link, a file, a quick note or a voice memo — and say what you like about it. Your assistant studies these and applies them to everything it drafts.',
      },
      // My Content tab (assistant-my-content.js) — the org-wide media library (uploads, links,
      // AI-generated images/video) this assistant draws on for posts, or that feeds Inspo.
      // Placed right after Calendar (issue #213).
      myContentTab: { label: 'My Content' },
    },

    // Content Engine — Blog Writer. Uses assistant-detail.html, but its primary action is
    // special-cased in assistants.js to open the Blog Studio modal ("Write Blog Post") rather
    // than the social post sheet. Long-form drafts live in blog_posts (surfaced via Blog Studio),
    // NOT assistant_records — so no hubTab. All social-only modules are off (it has its own
    // review/approval + scheduling inside Blog Studio, not the social Review Queue / Posting Schedule).
    blog_writer: {
      kpis: [
        {
          label: 'Publishing Consistency',
          title: 'Posts Published',
          desc: 'Long-form posts drafted, approved and published on the cadence you set.',
        },
        {
          label: 'Search Visibility',
          title: 'Organic Traffic',
          desc: 'Readers arriving from search as your library compounds over time.',
        },
        {
          label: 'Hours Reclaimed',
          title: 'Time Saved',
          desc: 'Research, drafting and formatting hours this assistant has taken off your plate.',
        },
        {
          label: 'Needs You',
          title: 'Awaiting Approval',
          desc: 'Drafts sitting in review, waiting for your sign-off before they schedule.',
        },
      ],
      modules: {
        // hasPostingSchedule drives BOTH the schedule controls in Operational Setup and the
        // Autopilot status card. Blog Autopilot (blog-horizon-fill → process-blog-jobs) gives the
        // Blog Writer its own scheduled-drafting engine, reusing the same posting_frequency /
        // posting_days / posting_times / posting_timezone context keys as the social path — so the
        // same controls configure it, with the copy retitled for long-form.
        hasReviewQueue: false, hasPostingSchedule: true, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        // Mirrors PUBLISHING_ROLE_KEYS in src/utils/notification-prefs.ts, which is the source of
        // truth — the two must agree or the "Content & Publishing" toggle renders but the write is
        // rejected server-side. Blog Writer drafts and publishes, so it gets the category.
        hasContentPublishing: true,
      },
      // Ignored for blog_writer (assistants.js special-cases the button to open Blog Studio),
      // but kept coherent for any generic reader of the registry.
      primaryAction: { label: 'Write Blog Post', kind: 'chat' },
      // The "Blogs" tab is the single home for long-form work — create, edit, review, approve,
      // schedule and delete drafts (blog-posts.ts). It's the landing tab, and the old separate
      // Content Library / Data Hub tab is retired (hideDataHub) since it showed the same posts.
      reviewQueue: { kind: 'posts', source: 'blog_posts', label: 'Blogs' },
      defaultMainTab: 'review-queue',
      hideDataHub: true,
      // hubTab is retained (used by the Calendar's from/to feed + generic registry readers) even
      // though its tab is hidden; its data model still reads blog_posts.
      hubTab: {
        id: 'datahub',
        kind: 'content_library',
        source: 'blog_posts',
        label: 'Content Library',
        recordType: null,
        description: 'Every long-form post this assistant has written — drafts, scheduled and published.',
        columns: [
          { key: 'title', label: 'Post' },
          { key: 'status', label: 'Status' },
          { key: 'updatedAt', label: 'Updated' },
        ],
      },
      // Inspo tab (assistant-inspo.js) — see social_media_manager above. Blog drafts get
      // the same treatment via their own prompt path in generate-blog.ts.
      inspoTab: {
        label: 'Inspo',
        description: 'The styles, tones and ideas you want your writing to sound like. Add a link, a file, a quick note or a voice memo — and say what you like about it. Your assistant studies these and applies them to every draft.',
      },
      // My Content tab (assistant-my-content.js) — see social_media_manager above.
      myContentTab: { label: 'My Content' },
    },

    lead_qualifier: {
      kpis: [
        {
          label: 'Pipeline Volume',
          title: 'Leads Scored',
          desc: 'Every inbound enquiry scored against your ideal customer profile.',
        },
        {
          label: 'Quality Signal',
          title: 'High-Value Prospects',
          desc: 'Leads that matched your target industries and headcount — worth chasing first.',
        },
        {
          label: 'Hours Reclaimed',
          title: 'Time Saved',
          desc: 'Manual research and triage hours this assistant has taken off your plate.',
        },
        {
          label: 'Data Quality',
          title: 'CRM Enriched',
          desc: 'Lead records updated with scores, firmographics and suggested next steps.',
        },
      ],
      modules: {
        hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      primaryAction: { label: 'Score New Leads', kind: 'chat' },
      // `subtitle` overrides the generic records-queue line: approving a lead SENDS its drafted
      // email straight away (lead-generation.ts `send_outreach`) rather than scheduling it, so
      // the generic "approve, schedule or reject" copy described the wrong action entirely.
      reviewQueue: {
        kind: 'records',
        recordType: 'lead',
        // Hedged on the send because it's conditional: a user who picked manual outreach during
        // onboarding (outreachMode 'none'), or who hasn't connected an inbox, gets the draft to
        // send themselves — send_outreach returns 'no_provider' / 'not_connected' and nothing goes out.
        subtitle: 'Leads awaiting your approval — read the drafted email on each one. Approving sends it from your connected inbox, if you have one, and sets a chase reminder.',
      },
      hubTab: {
        id: 'datahub',
        label: 'Leads',
        recordType: 'lead',
        description: 'Every lead this assistant has scored — with its outreach draft — plus any lead lists you import.',
        // Manual entry: the Data Hub shows an "Add Lead" button (assistant-data-hub.js) that
        // scores a single hand-typed lead via netlify/functions/lead-generation.ts (score_lead).
        manualAdd: true,
        columns: [
          { key: 'title', label: 'Lead' },
          { key: 'score', label: 'Score' },
          { key: 'status', label: 'Rating' },
          { key: 'suggestedNextStep', label: 'Next step' },
          { key: 'updatedAt', label: 'Updated' },
        ],
        importHint: 'Upload a CSV of inbound leads — one row per lead. Exporting from Excel or Google Sheets? Use File → Download → CSV.',
        importColumns: ['name', 'company', 'email', 'website', 'industry', 'headcount', 'notes'],
      },
      // Overview "Review Lead Ideas" button (assistant-lead-ideas.js) — replaces the social
      // "Review Pending Items" shortcut (hidden here via hasReviewQueue:false). The assistant
      // proposes lead-generation ideas; on approval it finds, scores and files leads and tags
      // a next-best-action owner (handled here vs handed off). Backed by lead-generation.ts.
      ideasReview: {
        label: 'Review Lead Ideas',
        title: 'Lead Ideas',
        description: 'Ideas for where to find your next customers. Approve one and the Lead Generator finds matching companies, scores them into your Leads tab, and suggests the next best action for each.',
      },
      // Overview "Find New Leads" button (assistant-discovery-campaigns.js) — the outbound
      // discovery engine: author an Idea/Blueprint + cadence + guardrails; a background run
      // searches the web, scores what it finds, and files leads for approval. Backed by
      // discovery-campaigns.ts. Design: docs/lead-generator-discovery-plan.md.
      discoveryCampaigns: {
        label: 'Find New Leads',
        title: 'Find New Leads',
      },
      // Signal Inbox tab (assistant-signal-inbox.js → signal-inbox.ts). Everything that came IN
      // before it became a lead. Populated from saved searches with ONLY this assistant hired;
      // the social feed is additive (Phase 1b). Design: docs/lead-generator-revenue-engine-plan.md.
      signalInbox: {
        label: 'Signal Inbox',
      },
      // Conversations tab (assistant-lead-threads.js → lead-threads.ts). What happened after a
      // lead was approved: the outreach thread, the reply, the classification, and what the
      // follow-up sequence did. Named for what's BUILT — the mockup's "Deal Thread" also showed
      // the deal envelope and Closing Agent, which are Phase 4 and don't exist.
      conversationsTab: {
        label: 'Conversations',
      },
      // Strategy tab (assistant-strategy.js → strategy-proposals.ts). Phase 5a §7: changes the
      // agent proposes to how it targets and writes, each with its evidence, none applied until a
      // human clicks Apply.
      //
      // ⚠️ Declaring it here does NOT reveal it. The tab is additionally gated on the
      // `strategy_agent` plan feature, which is DEFAULT OFF, and the component hides its own button
      // until the server confirms the workspace has it. Deliberately not the `autonomous` tier gate
      // that admits the goal optimizer — that rewrites brand voice for an org's own content, where
      // this redirects cold outreach at real strangers. §7.1: "the difference is blast radius".
      strategyTab: {
        label: 'Strategy',
      },
      // The Signal Inbox is the landing tab: it's the top of the funnel, so it's what the user
      // should see first. Stated explicitly rather than relying on _activateDefaultMainTab's
      // "first visible tab" fallback, which gave the right answer only by accident of tab order.
      defaultMainTab: 'signals',
      // "Ask your memory" panel inside the Data Hub tab (assistant-memory-query.js →
      // memory-query.ts). Phase 3 §5.5: natural-language questions answered from account_memory,
      // account_edges and revenue_events, every claim cited back to the record it came from.
      // Lead roles only — they are the roles that HAVE conversations to remember. The panel
      // self-hides when the organisation has no memory yet, so enabling it early is harmless.
      memoryPanel: {
        label: 'Ask your memory',
      },
    },

    accounts_receivable_clerk: {
      kpis: [
        {
          label: 'Collections Activity',
          title: 'Invoices Chased',
          desc: 'Overdue invoices followed up according to your collections cadence.',
        },
        {
          label: 'Money In',
          title: 'Cash Recovered',
          desc: 'Value of overdue invoices settled after this assistant chased them.',
        },
        {
          label: 'Hours Reclaimed',
          title: 'Time Saved',
          desc: 'Chasing, reconciling and reminder-drafting hours handled for you.',
        },
        {
          label: 'Needs You',
          title: 'Escalations',
          desc: 'Accounts flagged for your personal attention — disputes or repeat non-payers.',
        },
      ],
      modules: {
        hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      primaryAction: { label: 'Chase an Invoice', kind: 'chat' },
      reviewQueue: { kind: 'records', recordType: 'invoice' },
      hubTab: {
        id: 'datahub',
        label: 'Ledger',
        recordType: 'invoice',
        description: 'Outstanding invoices this assistant is chasing — who has been emailed, when, and what stage each debt is at.',
        columns: [
          { key: 'title', label: 'Client' },
          { key: 'invoices.0.daysPastDue', label: 'Days overdue' },
          { key: 'invoices.0.amount', label: 'Amount' },
          { key: 'status', label: 'Stage' },
          { key: 'lastChasedAt', label: 'Last chased' },
        ],
        importHint: 'Upload a CSV of outstanding invoices — one row per invoice. Exporting from Excel or Google Sheets? Use File → Download → CSV.',
        importColumns: ['client', 'amount', 'days overdue', 'invoice number', 'due date'],
      },
    },

    tier1_support_agent: {
      kpis: [
        {
          label: 'Deflection Rate',
          title: 'Tickets Auto-Resolved',
          desc: 'Customer queries answered end-to-end without a human touching them.',
        },
        {
          label: 'Speed',
          title: 'Avg Resolution Time',
          desc: 'How quickly customers get an answer, from first message to resolution.',
        },
        {
          label: 'Hours Reclaimed',
          title: 'Time Saved',
          desc: 'Support hours this assistant has handled instead of your team.',
        },
        {
          label: 'Needs You',
          title: 'Human Escalations',
          desc: 'Conversations handed to a person — below your confidence threshold or by request.',
        },
      ],
      modules: {
        hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      primaryAction: { label: 'Handle a Query', kind: 'chat' },
      reviewQueue: {
        kind: 'records',
        recordType: 'ticket',
        subtitle: 'Triaged queries awaiting your approval — read the drafted reply on each one. Approving files it for you to send; nothing is emailed automatically.',
      },
      hubTab: {
        id: 'datahub',
        label: 'Tickets',
        recordType: 'ticket',
        description: 'Triaged support queries with their drafted replies — forward your support@ emails into chat, or import a CSV of tickets.',
        columns: [
          { key: 'title', label: 'Ticket' },
          { key: 'status', label: 'Status' },
          { key: 'confidenceScore', label: 'Confidence' },
          { key: 'updatedAt', label: 'Updated' },
        ],
        importHint: 'Upload a CSV of open tickets or customer emails — one row per query. Exporting from Excel or Google Sheets? Use File → Download → CSV.',
        importColumns: ['subject', 'customer', 'email', 'message'],
      },
      // Knowledge Base tab (assistant-knowledge-base.js) — the support articles this
      // assistant grounds its Resolved answers in (kb_articles via kb-articles.ts).
      kbTab: {
        label: 'Knowledge Base',
        description: 'The support articles your assistant answers from — returns policies, pricing, product guides. Questions your Knowledge Base can\'t answer are escalated to you instead of guessed at.',
      },
    },

    crm_enricher: {
      kpis: [
        {
          label: 'Coverage',
          title: 'Records Enriched',
          desc: 'CRM records this assistant has researched and brought up to date.',
        },
        {
          label: 'Gaps Closed',
          title: 'Blank Fields Populated',
          desc: 'Missing fields — industry, size, location and more — filled in automatically.',
        },
        {
          label: 'Hours Reclaimed',
          title: 'Time Saved',
          desc: 'Manual data-entry and research hours this assistant has absorbed.',
        },
        {
          label: 'Trust Signal',
          title: 'Data Accuracy',
          desc: 'How reliably enriched values survive your review without correction.',
        },
      ],
      modules: {
        hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      primaryAction: { label: 'Enrich Records', kind: 'chat' },
      reviewQueue: { kind: 'records', recordType: 'enrichment' },
      hubTab: {
        id: 'datahub',
        label: 'Database',
        recordType: 'enrichment',
        description: 'Current vs. enriched diffs for every record this assistant has researched — apply them to your CRM or export as CSV.',
        columns: [
          { key: 'title', label: 'Record' },
          { key: 'fields', label: 'Fields enriched' },
          { key: 'crmProvider', label: 'CRM' },
          { key: 'status', label: 'Status' },
          { key: 'updatedAt', label: 'Updated' },
        ],
        importHint: 'Upload a CSV of accounts with missing fields — populated columns are kept as current values, blank ones get enriched. Exporting from Excel or Google Sheets? Use File → Download → CSV.',
        importColumns: ['name', 'company', 'website', 'industry', 'company size', 'linkedin url'],
      },
    },

    meeting_note_taker: {
      kpis: [
        {
          label: 'Throughput',
          title: 'Meetings Summarized',
          desc: 'Transcripts and rough notes turned into structured, shareable summaries.',
        },
        {
          label: 'Follow-Through',
          title: 'Action Items Extracted',
          desc: 'Commitments captured with owners and deadlines, so nothing slips.',
        },
        {
          label: 'Hours Reclaimed',
          title: 'Time Saved',
          desc: 'Write-up and minute-taking hours this assistant has taken over.',
        },
        {
          label: 'Connected Work',
          title: 'Tasks Synced',
          desc: 'Action items pushed into your task tool of choice, ready to work.',
        },
      ],
      modules: {
        hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      primaryAction: { label: 'Summarise a Meeting', kind: 'chat' },
      // Per-role tab label ("Inbox") — the brief forbids heavy "Review Queue" terminology for
      // the note-taker; other roles keep the default. Applied in _applyDashboardRegistry.
      reviewQueue: {
        kind: 'records',
        recordType: 'meeting',
        label: 'Inbox',
        subtitle: 'Meetings awaiting your approval — read the drafted follow-up email on each one. Approving runs your handoff recipes, which can email the attendees and file action items.',
      },
      hubTab: {
        id: 'datahub',
        label: 'Meeting Notes',
        recordType: 'meeting',
        // NOT the same thing as a check-in with this assistant — this is a library
        // of the user's own business meetings.
        description: 'Notes from your business meetings — browse summaries and tick off action items.',
        columns: [
          { key: 'title', label: 'Meeting' },
          { key: 'tasks', label: 'Action items' },
          { key: 'targetDestination', label: 'Destination' },
          { key: 'status', label: 'Status' },
          { key: 'updatedAt', label: 'Updated' },
        ],
        importHint: 'Paste transcripts into chat for processing — or upload a CSV of past meetings (one row per meeting) to build your library.',
        importColumns: ['meeting title', 'date', 'summary', 'action items'],
      },
    },
  };

  /**
   * Dashboard config for a roleKey. Unknown/missing keys fall back to the
   * social_media_manager entry (the pre-registry hardcoded layout).
   */
  function get(roleKey) {
    return REGISTRY[roleKey] || REGISTRY.social_media_manager;
  }

  window.AssistantDashboardRegistry = { get, REGISTRY };
})();
