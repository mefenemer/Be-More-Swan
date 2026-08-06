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
 *                //     hasPostingSchedule, hasSocialStrategy
 *                //     ...hasPostingSchedule doubles as "this role publishes": the Calendar tab
 *                //        reads it (assistant-calendar.js) to drop the platform filter and the
 *                //        posted/overdue legend for roles that publish nothing.
 *                //     (There was a third original flag, hasReviewQueue. Deleted: the Review Queue
 *                //      became a core tab on every role, so it gated nothing — while every
 *                //      non-social entry went on declaring `false`, which then read as an
 *                //      explanation for UI that was in fact still rendering. Gate on
 *                //      reviewQueue.kind instead, and don't reintroduce a flag nothing reads.)
 *                //     hasImpactRoi            → Overview "Impact & ROI" card (post-based ROI)
 *                //     hasCreativeBrief        → Profile ▸ Creative Brief social cards
 *                //                               (Objective & Message, Audience & Voice, Reference)
 *                //     hasSalesContext         → Profile ▸ Creative Brief ▸ Sales Context card
 *                //     hasContentAutomation    → the Automation main tab (post/media autonomy)
 *                //     hasEmptyLibraryFallback → Profile ▸ Brand Safety ▸ Empty-Library Draft card
 *                //     hasReviewCadence        → Profile ▸ Notifications ▸ Review-alert cadence card
 *                //     hasContentPublishing    → Profile ▸ Notifications ▸ "Content & Publishing"
 *                //                               preference (post/draft alerts — social-only)
 *   cfg.primaryAction // → OPTIONAL. The workspace tab's primary button { label, kind }. kind:
 *                //   'generate_post' opens the post sheet (social); 'chat' opens the assistant's
 *                //   chat intake (Data Hub roles). Omit it for a role with no single "do the
 *                //   thing" action and the button is hidden outright — see lead_qualifier.
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
 *   memory. Only labels/content differ per role (via hubTab/reviewQueue). Calendar has no config
 *   block of its own — assistant-calendar.js scopes the global calendar to this assistant — but it
 *   does read modules.hasPostingSchedule to strip the publishing-only chrome for records roles.
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
      modules: { hasPostingSchedule: true, hasSocialStrategy: true },
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
        hasPostingSchedule: true, hasSocialStrategy: false,
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

    // Campaign Assistant. The only role whose output is other assistants' work, so nearly every
    // social module is off and the Data Hub lists ORDERS it issued rather than artefacts it made.
    //
    // ⚠️ This entry is load-bearing purely by existing. A missing roleKey falls back to
    // social_media_manager, and for this role that fallback is wrong in every cell — it would show
    // "Engagement Rate by Reach" for an assistant that has never published anything.
    campaign_orchestrator: {
      // Campaign-LIFETIME window, not "last 30 days". A 30-day window across a 6-week flight is
      // arithmetic that cliff-drops at rollover; roi-hero-defaults-all-time already cost us this
      // once. Card 2 swaps its unit by campaign mode — an organic campaign showing
      // "Cost per Outcome: £0" is a lie about a real cost, so it reports tasks instead.
      kpis: [
        {
          label: 'Outcomes Delivered',
          title: 'What It Actually Produced',
          desc: 'Leads, replies and published work this campaign caused — not clicks, not impressions.',
        },
        {
          label: 'Effort per Outcome',
          title: 'The Real Price',
          desc: 'Every task your assistants spent, divided by the outcomes those tasks produced.',
        },
        {
          label: 'Decisions Taken For You',
          title: 'Reallocations',
          desc: 'Work it moved between your assistants without waking you, each with its evidence.',
        },
        {
          label: 'Needs You',
          title: 'Awaiting Approval',
          desc: 'Decisions parked above your threshold, and campaigns blocked on something only you can fix.',
        },
      ],
      // Publishes nothing, sells nothing, writes no content of its own. hasPostingSchedule:false
      // also strips the platform filter and posted/overdue legend from the Calendar tab.
      modules: {
        hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      // Chat is where an objective becomes a strategy proposal. `kind: 'chat'` only redirects to
      // the chat page, which is honest here — unlike the Lead Generator's retired "Score New
      // Leads", setting an objective genuinely IS a conversation and has no one-click form.
      //
      // ⚠️ It cannot start anything. Approving in chat SAVES a draft campaign; starting it is a
      // separate human click on the Campaigns tab, with the numbers visible. See
      // chat-creates-draft-campaigns and plan §1.3.
      primaryAction: { label: 'Set an Objective', kind: 'chat' },
      // Decisions the assistant wants to take, above the user's autonomy threshold. Records-kind,
      // so the existing approve/reject gate renders it with no new client code.
      //
      // Reject captures a reason chip AND has a built consumer: the reason is written to the
      // campaign's constraint set and restated in the prompt that generates the next proposal
      // (src/config/campaign-reject-reasons.ts → renderCampaignConstraints, reaching generation
      // via campaign-directive.ts). lead-rejection-teaches-nothing was the alternative.
      reviewQueue: {
        kind: 'records',
        recordType: 'campaign_decision',
        label: 'Decisions',
        // Explicitly not the generic "approve, schedule or reject" line: approving a decision
        // issues ORDERS to other assistants, whose output then comes back for review separately.
        // Approving here is never the last gate before something reaches the outside world.
        subtitle: 'Decisions your Campaign Assistant wants to make — each with the evidence behind it and what happens if you do nothing. Approving briefs your other assistants; their work still comes back to you for approval.',
      },
      // Data Hub = ORDERS, not artefacts. This is the role's defining difference: its workspace is
      // a ledger of instructions it issued to other assistants. The Result column carries the chain
      // objective → order → artefact, which nothing else in the product can show.
      hubTab: {
        id: 'datahub',
        label: 'Orders',
        recordType: 'campaign_order',
        description: 'Every instruction this assistant has issued to your other assistants — what it asked for, what it cost, and what came back.',
        columns: [
          { key: 'title', label: 'Order' },
          { key: 'campaign', label: 'Campaign' },
          { key: 'assignedTo', label: 'Assigned to' },
          { key: 'taskCost', label: 'Tasks' },
          { key: 'status', label: 'Status' },
          { key: 'result', label: 'Result' },
        ],
        // Golden Rule 1 — never require an external system. A founder can bring last quarter's
        // numbers in from a spreadsheet and get a real baseline on day one instead of an empty
        // dashboard they have to wait a month to fill.
        importHint: 'Upload a CSV of past campaign activity — one row per channel per period. This gives your Campaign Assistant a baseline to compare new campaigns against.',
        importColumns: ['campaign', 'channel', 'spend', 'outcomes', 'date'],
      },
      // ⊕ Campaigns tab (assistant-campaigns.js → campaigns.ts). One row per campaign, each row
      // stating what it is doing right now. Modelled on the Searches tab, whose lesson was learned
      // expensively: a list that does not say what is happening reads as broken.
      //
      // ⚠️ If you rename this tab, grep the chat-orchestrator system prompt too — it names the tab
      // to the assistant, and tests/campaign-prompt-surfaces.test.ts fails until both agree.
      campaignsTab: {
        label: 'Campaigns',
      },
      // The Campaigns tab is the landing tab: it is the thing the role is FOR. Stated explicitly
      // rather than relying on _activateDefaultMainTab's "first visible tab" fallback, which gives
      // the right answer only by accident of tab order.
      defaultMainTab: 'campaigns',
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
        hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
      },
      // No primaryAction — deliberately. It read "Score New Leads", which promised an action it
      // could not perform: `kind: 'chat'` only redirects to the chat page. Scoring is not a thing
      // the user triggers here anyway — discovery runs score what they find (dispatch-discovery-runs
      // hourly + process-discovery-jobs), CSV imports are scored on import, and the one genuinely
      // manual path already has its own button ("Add Lead" in the Leads tab → score_lead). The
      // always-visible header "Chat" CTA covers talking to the assistant. Omitting the key HIDES
      // the button (assistants.js gates on `!!pa`); it does not fall back to a default label.
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
        // `approvalStatus` sits second, right after the name: this tab holds every lead in every
        // state, so "where is it in the gate" is the first thing you need after "which one is it".
        // Without it a pending, an approved and a rejected lead were pixel-identical here — which
        // is exactly why the Review tab (the same rows, filtered to pending_approval) read as a
        // pointless duplicate of this one. Resolved off the record ENVELOPE, not record.data —
        // assistant-data-hub.js cellValue special-cases it alongside title/status/updatedAt.
        // `contact` is SYNTHETIC — there is no such field on the record. assistant-data-hub.js
        // `contactState()` derives it from contactEmail + emailKind + the rating, because outreach
        // is email-only and a lead with no address cannot be worked at all. It sits beside Approval
        // so the two "can I act on this?" questions read together.
        columns: [
          { key: 'title', label: 'Lead' },
          { key: 'approvalStatus', label: 'Approval' },
          { key: 'contact', label: 'Contact' },
          { key: 'score', label: 'Score' },
          { key: 'status', label: 'Rating' },
          { key: 'suggestedNextStep', label: 'Next step' },
          { key: 'updatedAt', label: 'Updated' },
        ],
        importHint: 'Upload a CSV of inbound leads — one row per lead. Exporting from Excel or Google Sheets? Use File → Download → CSV.',
        importColumns: ['name', 'company', 'email', 'website', 'industry', 'headcount', 'notes'],
      },
      // "Review Lead Ideas" (assistant-lead-ideas.js), in the Searches toolbar. The assistant
      // proposes lead-generation ideas; on approval it finds, scores and files leads and tags
      // a next-best-action owner (handled here vs handed off). Backed by lead-generation.ts.
      ideasReview: {
        label: 'Review Lead Ideas',
        title: 'Lead Ideas',
        description: 'Ideas for where to find your next customers. Approve one and the Lead Generator finds matching companies, scores them into your Leads tab, and suggests the next best action for each.',
      },
      // "Find New Leads" (assistant-discovery-campaigns.js) — the outbound discovery engine:
      // author an Idea/Blueprint + cadence + guardrails; a background run searches the web,
      // scores what it finds, and files leads for approval. Backed by discovery-campaigns.ts.
      // Design: docs/lead-generator-discovery-plan.md.
      //
      // Its button lives in the SIGNAL INBOX toolbar, not the Leads tab action bar — a search
      // files its results into the inbox and nothing into Leads directly, so the Leads-tab entry
      // point was downstream of its own action. assistant-signal-inbox.js reads this config from
      // the registry itself; nothing in assistants.js wires it any more.
      discoveryCampaigns: {
        label: 'Find New Leads',
        title: 'Find New Leads',
      },
      // "Searches" tab (assistant-signal-inbox.js → signal-inbox.ts). Everything that came IN
      // before it became a lead. Populated from saved searches with ONLY this assistant hired;
      // the social feed is additive (Phase 1b). Design: docs/lead-generator-revenue-engine-plan.md.
      //
      // The internals are all still named "signal inbox" — the key, the component, the function,
      // the table — because that is what the thing IS. Only the user-facing label changed, and it
      // changed because users read this tab as "where my searches live": both of its buttons
      // ("Find New Leads", "Review Lead Ideas") start a search, and the filter chips ARE searches.
      // ⚠️ If you rename it again, grep the chat-orchestrator system prompt too — it names this
      // tab to the assistant, and a stale name there sends users to a tab that does not exist.
      signalInbox: {
        label: 'Searches',
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
        hasPostingSchedule: false, hasSocialStrategy: false,
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
        hasPostingSchedule: false, hasSocialStrategy: false,
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
        hasPostingSchedule: false, hasSocialStrategy: false,
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
        hasPostingSchedule: false, hasSocialStrategy: false,
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
