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
 *                //     hasLeadOutreach         → Calendar tab also draws the PENDING follow-up
 *                //                               emails (sequence_enrolments), draggable to
 *                //                               reschedule the send. lead roles only.
 *   cfg.activitySource // → OPTIONAL. Which feed the Activity tab reads. Omitted → the content
 *                //   feed (get-assistant-activity). 'lead' → get-lead-activity.ts (the revenue
 *                //   ledger + task runs), for roles whose work never touches a content table.
 *                //   Both return the same item shape, so only the URL differs.
 *   cfg.roiSource // → OPTIONAL. Where the hero's Effort/Money Saved strip gets its figures.
 *                //   Omitted → the post-based get-assistant-metrics path, gated by
 *                //   modules.hasImpactRoi. 'lead' → get-lead-roi.ts (the revenue ledger). The two
 *                //   are separate switches on purpose; see the note on lead_qualifier.
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
      // ⚠️ These four labels must describe what get-blog-performance.ts actually returns. They used
      // to sit over cards fed by get-assistant-performance (engagement rate, reach growth, CTR,
      // meaningful engagement, all off the Instagram post_insights table) — so the label and the
      // number underneath it were about different things, on a card that could never populate.
      // `metricsSource: 'blog'` below is what routes them to the right source.
      kpis: [
        {
          label: 'Publishing Consistency',
          title: 'Posts Published',
          desc: 'Long-form posts drafted, approved and published on the cadence you set.',
        },
        {
          // "Organic Traffic" was the old title and it over-claimed: what is stored is the peak
          // search IMPRESSIONS per post (blog_posts.traffic_baseline, kept by ingest-gsc-metrics
          // to detect decay). Clicks are not recorded anywhere, so the card cannot report them.
          label: 'Search Visibility',
          title: 'Search Impressions',
          desc: 'How often your posts have appeared in Google search results, from Search Console.',
        },
        {
          // Was "Hours Reclaimed / Time Saved". It moved out, it did not disappear: the hero's
          // Time Saved / Money Saved strip (roiSource: 'blog' below) is now the ONE place that
          // figure appears, and leaving a copy here meant the same page printed two different
          // numbers for the same thing over two different windows.
          //
          // Clicks are the honest partner to Search Impressions above. That card says Google SHOWED
          // the post; this one says somebody actually came — which is the only one of the two that
          // tells the author whether their titles and meta descriptions are doing any work.
          label: 'Organic Clicks',
          title: 'Search Visits',
          desc: 'Visitors who clicked through from Google search results to read your posts.',
        },
        {
          // Was "Needs You / Awaiting Approval". That count still has a home — the Blogs tab badge
          // carries it, and it is a live number better read where the drafts actually are.
          //
          // This card is the quality counterweight to the three above it, and the one that matters
          // most for an AI writer: cards 1-3 can all look healthy while the content is thin. High
          // impressions with a short read time is precisely that failure, and nothing else on this
          // page would catch it.
          //
          // ⚠️ Measured on the widget embed only — a customer who republishes to their own CMS has
          // readers we never see. The description says "measured reads" for that reason; do not
          // reword it to imply total audience.
          label: 'Reader Engagement',
          title: 'Average Read Time',
          desc: 'How long readers actually spend with your posts, averaged over measured reads on your embedded blog.',
        },
      ],
      // Routes _loadAssistantMetrics to _loadBlogMetrics / get-blog-performance. Without it the
      // Blog Writer falls through to the social post_insights endpoint, which holds none of its data.
      metricsSource: 'blog',
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
      // The Overview's "Audience" block is follower/subscriber counts pulled from the SOCIAL
      // platform APIs — Instagram, Facebook, YouTube, X. A Blog Writer publishes to none of them,
      // so it was showing this assistant a chart of an audience it does not write for (and the
      // counts are org-wide, so they moved for reasons nothing on this page caused).
      //
      // Its blog connectors live in a different store entirely (workspace_integrations, via
      // src/utils/blog-destinations), and none of those platforms exposes a follower count — so the
      // honest replacement is WHERE this assistant publishes, not how many read it.
      audienceSource: 'blog_destinations',
      // ⊕ The hero's "Time Saved / Money Saved" strip.
      //
      // ⚠️ A SECOND, independent switch from modules.hasImpactRoi — same pairing as the Lead
      // Generator above, and for the same reason. hasImpactRoi stays false so the post-based
      // "Content by platform" breakdown (scheduled_posts) is kept off a role that writes none;
      // roiSource re-reveals the strip alone.
      //
      // Why it is 'blog' and not simply true: the figures come from get-assistant-metrics, whose
      // hours are counted by src/utils/roi-activity.ts — and that module already prices blog_posts.
      // So a Blog Writer's hours were correct at the source the whole time and simply had nowhere
      // to appear: the strip was hidden, and "Time Saved" instead showed up as one of the four KPI
      // cards, in a different shape, in a different place, over a different window from the same
      // figure on the Social Media Manager and Lead Generator pages.
      roiSource: 'blog',
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
      //
      // These four cards are fed by get-campaign-performance, NOT by the shared
      // get-assistant-performance the other roles use — that one reads post_insights scoped to the
      // assistant's own id, and this assistant owns no posts, so it returned hasData:false for
      // ever and the section rendered its "nothing to report" panel permanently. `metricsSource`
      // below is what routes it. A role without the flag keeps the social endpoint.
      metricsSource: 'campaign',
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
        // ⚠️ This card used to read "Decisions Taken For You / Reallocations — work it moved
        // between your assistants without waking you". Nothing in the product does that. The
        // autonomy dial that would authorise it (campaign_budgets.autonomy_threshold_work) is
        // written and validated by campaigns.ts and then read by NOTHING: no path auto-approves a
        // decision, so every reallocation waits for a human and the card could only ever have
        // reported 0. Reworded 2026-08-07 to what the autonomous run genuinely does — it spots
        // these unprompted and files them with their evidence, which is the real product claim and
        // is measurable today. Restore the old wording only in the commit that ships auto-approval.
        {
          label: 'Decisions Raised',
          title: 'Spotted Without You Asking',
          desc: 'Escalations and halts the assistant found in your own numbers and put to you, each with its evidence.',
        },
        {
          label: 'Needs You',
          title: 'Awaiting Approval',
          desc: 'Decisions waiting on your answer, and finished work sitting in another assistant’s review queue.',
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
      // These four cards are fed by get-lead-performance, NOT by the shared
      // get-assistant-performance the social roles use — that one reads post_insights, and this
      // assistant publishes nothing, so it returned hasData:false for ever and the section told
      // every Lead Generator user that "nothing has been published in the last 30 days". True,
      // permanent, and about a different product. `metricsSource` is what routes it; a role
      // without the flag keeps the social endpoint.
      metricsSource: 'lead',
      // ⚠️ The window is 90 days, not the 30 the social cards use — a B2B cycle runs weeks to
      // months and a 30-day window reports zero closed deals for a healthy pipeline. The endpoint
      // returns periodDays and the client prints it; never hardcode a period into this copy.
      //
      // Rewritten 2026-08-15. The four labels here used to be "Pipeline Volume / Quality Signal /
      // Hours Reclaimed / Data Quality" — written before anything computed them, and two of them
      // were unmeasurable in principle: nothing in the platform times a human doing this work by
      // hand, so "Hours Reclaimed" could only ever have been an estimate presented as a
      // measurement. Each card below is now one question in the standard lead funnel, and each is
      // a figure the ledger genuinely holds.
      kpis: [
        {
          label: 'Pipeline Volume',
          title: 'Qualified Leads',
          // ⚠️ The last sentence exists because a SMART goal on the same page carries the same two
          // words and a different number, and users read the pair as one figure computed twice.
          // This card counts `lead_approved` events in the 90-day window (get-lead-performance.ts →
          // the revenue ledger), so it is a record of what HAPPENED and never falls. The goal
          // (qualified_leads in src/config/goal-metrics.ts) counts the Approved + Awaiting-reply
          // columns as they stand RIGHT NOW, over all time, so it drops when a lead is rejected or
          // deleted. Both are correct; only their being unlabelled was not. Keep the two
          // descriptions in step — they are the only thing on the page that reconciles them.
          desc: 'Leads this assistant found that you judged worth pursuing, against how many it sifted to get there. '
            + 'Counts approvals made in the window — a lead you approved and later deleted still counts here, which is '
            + 'why this can read higher than a Qualified Leads goal (that one counts the leads sitting in Approved and '
            + 'Awaiting reply right now).',
        },
        {
          label: 'Targeting Accuracy',
          title: 'Qualification Rate',
          desc: 'Of the leads you ruled on, the share you kept. Measured over decided leads only, so a review backlog never reads as bad targeting.',
        },
        {
          label: 'Outreach Engagement',
          title: 'Reply Rate',
          desc: 'Prospects who wrote back, out of those actually emailed. Opt-outs are shown beside it — a reply rate means little without them.',
        },
        {
          label: 'Conversion',
          title: 'Deals Won',
          desc: 'Closed-won value from these leads, and how many of the prospects contacted became customers.',
        },
      ],
      modules: {
        // hasImpactRoi stays FALSE and must. It gates the POST-based ROI pair fed by
        // get-assistant-metrics, whose formula is posts × content_drafted (+ task runs, + the
        // wrong `leads` table) — structurally zero for an assistant that publishes nothing.
        // The strip is still shown for this role, from a different source: see `roiSource` below.
        hasPostingSchedule: false, hasSocialStrategy: false,
        hasImpactRoi: false, hasCreativeBrief: false, hasSalesContext: false,
        hasContentAutomation: false, hasEmptyLibraryFallback: false, hasReviewCadence: false,
        hasContentPublishing: false,
        // ⊕ The Calendar tab also draws this role's PENDING OUTREACH — the follow-up emails the
        // cadence is going to send (sequence_enrolments.next_send_at, via lead-threads.ts
        // `calendar`). Opt-in, because this is the only role with a send queue that is not
        // scheduled_posts: everything else on a records-role calendar is a reminder or a
        // completed run, and neither is a thing the product is about to do to a third party.
        //
        // ⚠️ Distinct from the yellow 🗓 record chips, which are ALSO on this calendar and mean
        // very nearly the opposite — a lead's `scheduled_for` is the chase reminder left behind
        // AFTER its email went out. See calendar.js on _recordChip vs _followUpChip.
        hasLeadOutreach: true,
      },
      // ⊕ The Activity tab's source. Omitted → get-assistant-activity, which reads content
      // generation jobs, scheduled posts, post ideas and media jobs: all four are tables this role
      // never writes to, so the tab read "No activity yet" in every timeframe for an assistant
      // that had spent the week finding, scoring, emailing and closing leads. 'lead' routes it to
      // get-lead-activity.ts (the revenue ledger + task runs) — the same routing the KPI grid does
      // via `metricsSource`, and the same wire shape, so the renderer is unchanged.
      activitySource: 'lead',
      // ⊕ The hero's "Effort Saved / Money Saved" strip, fed by get-lead-roi.ts (the revenue
      // ledger + the platform's own time multipliers + the user's hourly rate) rather than by
      // get-assistant-metrics.
      //
      // ⚠️ This is a SECOND, independent switch from modules.hasImpactRoi, and both are needed.
      // hasImpactRoi=false keeps the post-based fetch and the "Content by platform" breakdown away
      // from a role that has neither; roiSource='lead' re-reveals the strip alone and points it at
      // the endpoint that can actually answer for this role. Setting hasImpactRoi=true instead
      // would fetch the post endpoint, get zeroes, and hide the strip again — which is exactly the
      // state this key exists to end. See _applyDashboardRegistry / _fetchAndRenderAssistantMetrics.
      //
      // ⚠️ The figure is an ESTIMATE at the platform's configured rate card, and the strip says so
      // in its own caption. That distinction is why "Hours Reclaimed" was struck off the four KPI
      // cards below and this is still fair: the KPI grid prints measurements, this prints a costing
      // that shows its workings on hover.
      roiSource: 'lead',
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
        // "Outreach", not the default "Review". For every other role this tab is a generic approval
        // gate; here the approve button is literally labelled "Approve & send email" and pressing it
        // puts a cold email in front of a stranger. "Review" understated that, and it is a large
        // part of why this tab read as a duplicate of Leads — two tabs called something generic,
        // showing the same rows. The label also makes the columns below cohere: pending → approved
        // → awaiting reply → rejected is one story, and that story is about emails.
        //
        // ⚠️ Renaming this fails tests/lead-prompt-surfaces.test.ts until leadGeneratorSurfaces()
        // in chat-orchestrator.ts names the tab too — the assistant tells users which tab to go to,
        // and a stale name there sends them to a tab that does not exist.
        label: 'Outreach',
        // Per-column label overrides, keyed by the column's `data-status`. Only the ones that differ
        // from the shared lifecycle wording need to appear.
        //
        // ⚠️ "Scheduled" was an outright lie on this role. It reads as "an email is queued to go out
        // later"; it means the OPPOSITE — the email has already gone, and `scheduled_for` is the
        // chase reminder that appears on the Calendar. "Awaiting reply" states the true state, and
        // deliberately reuses the wording of the Conversations tab's own filter chip so the two
        // tabs describe one fact with one phrase.
        //
        // Post-backed queues keep "Scheduled", where it is correct — hence an override rather than
        // an edit to the markup.
        //
        // ⚠️ ORDER IS LOAD-BEARING HERE, in two directions at once.
        // tests/lead-outreach-lifecycle.test.ts reads `label:` within 1400 characters of
        // `reviewQueue: {` and `columnLabels` within 2400. So this block sits AFTER the label and
        // BEFORE the subtitle: growing the subtitle once pushed columnLabels past 2400, and moving
        // this to the top to fix that pushed `label` past 1400. Either way the assertion silently
        // stops reaching the thing it checks. Long prose goes below both keys.
        columnLabels: { scheduled: 'Awaiting reply' },
        // Hedged on the send because it's conditional: a user who picked manual outreach during
        // onboarding (outreachMode 'none'), or who hasn't connected an inbox, gets the draft to
        // send themselves — send_outreach returns 'no_provider' / 'not_connected' and nothing goes out.
        //
        // ⚠️ THE LAST SENTENCE IS THE CONSENT DISCLOSURE — do not trim it back. This copy used to stop
        // at "sets a chase reminder", which describes a diary entry; what approving actually starts is
        // up to three further emails to a stranger (src/config/outreach-sequences.ts
        // DEFAULT_SEQUENCE_STEPS, gated on the `outreachFollowUps` setup answer). A user cannot
        // consent to a sequence they were told was a reminder. Where to switch it off is stated in the
        // setup question itself and in the post-send toast, not crammed in here.
        subtitle: 'Leads awaiting your approval — read the drafted email on each one. Approving sends it from your connected inbox, if you have one, '
          + 'and sets a chase reminder. With automatic chasing on, it also starts up to three follow-ups — 3 days, a week, then a sign-off — '
          + 'stopping the moment they reply.',
      },
      hubTab: {
        id: 'datahub',
        // "Enrichment", not "Leads". The strip reads Searches → Enrichment → Outreach →
        // Conversations, and each tab is now named for the WORK done on it rather than for the
        // noun it contains — "Leads" sat between two verbs and was the only one that did not say
        // what you go there to do.
        //
        // ⚠️ The tab is still the role's Data Hub, and it still holds every lead in every state.
        // The name is a promise about what happens here, so the enrichment actions have to be
        // real: "Send back for enrichment" runs an actual scrape + paid-lookup pass on the spot
        // (lead-generation.ts `send_back_for_enrichment`), rather than clearing a stamp and
        // waiting for a discovery run the way "Look again" does.
        //
        // ⚠️ Renaming this fails tests/lead-prompt-surfaces.test.ts until leadGeneratorSurfaces()
        // in chat-orchestrator.ts names the tab too — the assistant tells users which tab to go
        // to, and a stale name there sends them to a tab that does not exist. Same coupling the
        // reviewQueue label above carries.
        label: 'Enrichment',
        recordType: 'lead',
        // ⚠️ The last two sentences state the RETENTION RULES, and they belong here rather than
        // only on the Deleted section below. The table on this tab carries a "Deletes in" column
        // on every row, so a user reads a countdown to a deletion before they reach any copy
        // explaining it — and the two notices that DO explain it (LeadRetention.NOTICE above the
        // Outreach columns, LeadRetention.DELETED_NOTICE on the Deleted section) both sit
        // somewhere the user has to already be looking. A countdown nobody has explained reads as
        // a threat to their data.
        //
        // The day count is read from window.LeadRetention rather than typed, so it cannot drift
        // from LEAD_RETENTION_DAYS (src/config/lead-retention.ts) — platform-constants.js loads
        // before this file in workspace.html, so the global is there when this literal evaluates.
        // The `?? 30` is the load-order insurance, not a second opinion about the number.
        //
        // ⚠️ Says "moved", never "permanently deleted". A retained lead is still readable, still
        // countable and still recoverable through "Send back for enrichment"; overstating it would
        // make the Deleted section that follows look like a bug rather than the destination.
        description: 'Every lead this assistant has scored — with its outreach draft — plus any lead lists you import. '
          + 'This is where a lead is enriched: contact details found, details corrected, and cold leads worked up into warm ones. '
          + `A lead you delete, and any lead left sitting in Outreach ▸ Review or ▸ Archived for ${(window.LeadRetention && window.LeadRetention.DAYS) || 30} days without a decision, `
          + 'is moved to the Deleted section at the foot of this tab — nothing is destroyed, and the reason it was dropped is kept with it '
          + 'so a later search does not put the same company back in front of you as though it were new. '
          + 'Any action on a lead restarts its clock, and "Send back for enrichment" returns it to the pipeline.',
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
          // The 30-day retention countdown (src/config/lead-retention.ts). SYNTHETIC, like
          // `contact` above — there is no such field on the record; assistant-data-hub.js
          // `retentionCell()` derives it from the approval state and the envelope's updatedAt.
          //
          // It sits immediately before Updated because the two are the same fact read in opposite
          // directions: Updated is when the clock last restarted, Deletes in is what that means
          // for this lead. Reading them side by side is what makes the countdown explicable
          // rather than arbitrary.
          { key: 'retention', label: 'Deletes in' },
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
        description: 'Ideas for where to find your next customers. Approve one and the Lead Generator finds matching companies, scores them into your Enrichment tab, and suggests the next best action for each.',
      },
      // "Find New Leads" (assistant-discovery-campaigns.js) — the outbound discovery engine:
      // author an Idea/Blueprint + cadence + guardrails; a background run searches the web,
      // scores what it finds, and files leads for approval. Backed by discovery-campaigns.ts.
      // Design: docs/lead-generator-discovery-plan.md.
      //
      // Its button lives in the SEARCHES toolbar, not the Leads tab action bar: creating a search
      // is an act about searches, and the Leads-tab entry point sat downstream of its own result.
      // assistant-signal-inbox.js reads this config from the registry itself; nothing in
      // assistants.js wires it any more.
      //
      // ⚠️ This comment used to say a search "files its results into the inbox and nothing into
      // Leads directly". That has not been true since the worker began mirroring each scored
      // company on the spot (process-discovery-jobs.ts promoteOne): EVERY company a search finds —
      // hot, warm or cold — is an assistant_records lead as soon as it is scored, and the Searches
      // tab only projects those same rows. Approving is a decision about OUTREACH, not about
      // becoming a lead, and it belongs to the Leads tab.
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
      // ⚠️ There is no `memoryPanel` key any more, and re-adding one wires up nothing — the
      // component is deleted. It declared the "Ask your memory" panel that sat above this tab's
      // table (Phase 3 §5.5): an account picker, a question box and an Ask button, answering from
      // account_memory. Retired because a question box INSIDE the Leads tab reads as a search over
      // the leads, and it could not see them — "how many hot leads do I have" got a truthful,
      // useless answer about a store the user had never heard of. One door for questions (the
      // header's Chat button), and the lead_qualifier prompt now carries the live record counts.
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

  /**
   * Write a tab button's label with its record count: "Enrichment (48)".
   *
   * ── Why this is one function and not four ────────────────────────────────
   * The Lead Generator's four tabs had four different answers to "how many?", and the
   * inconsistency read as four unrelated features rather than one funnel:
   *   Searches      "Searches (12)" + an amber pill
   *   Leads         "Leads (48)"
   *   Outreach      no number at all — just an amber pill holding a DIFFERENT quantity
   *                 (pending approvals, not the tab's contents)
   *   Conversations nothing
   *
   * One rule now, and it separates two questions that were being answered in the same place:
   *   • the PARENTHETICAL is inventory — what this tab holds. Always this function.
   *   • the amber PILL is "needs you now" — a subset, and never the same number.
   * The pill stays where each component sets it; only the parenthetical is centralised, because
   * that is the part that has to look identical across tabs to read as one strip.
   *
   * `(0)` is suppressed on every tab, matching what Searches and the Data Hub already did
   * independently: an empty tab says so in its own body, and a zero on the button reads as a
   * counter that failed to load rather than an empty list.
   *
   * ⚠️ Callers pass the BASE label, never the current textContent. Reading the element back would
   * re-wrap an already-wrapped label into "Enrichment (48) (49)" on the second call, and these are
   * all called repeatedly — every refresh, every approve, every filter change.
   *
   * @param {string} elId       id of the <span> inside the tab button
   * @param {string} baseLabel  the role's label for this tab, from the registry
   * @param {number|null} count null/undefined leaves the bare label (the count is not known yet)
   */
  function setTabCount(elId, baseLabel, count) {
    const el = document.getElementById(elId);
    if (!el || !baseLabel) return;
    const n = Number(count);
    el.textContent = Number.isFinite(n) && n > 0 ? `${baseLabel} (${n})` : baseLabel;
  }

  window.AssistantDashboardRegistry = { get, REGISTRY, setTabCount };
})();
