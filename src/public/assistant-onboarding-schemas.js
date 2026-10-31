/**
 * src/config/assistant-onboarding-schemas.js
 *
 * Per-role onboarding configurationSchema definitions, keyed by masterAssistants.roleKey.
 * Feed these straight into window.AssistantOnboardingShell.mount({ configurationSchema })
 * — the shell saves the answers to aiAssistants.onboardingContext, which the chat
 * orchestrator (netlify/functions/chat-orchestrator.ts ROUTES) injects into every
 * conversation's system prompt. Field `key`s here must therefore match the
 * onboardingValue() lookups in the orchestrator route for the same roleKey.
 *
 * OPERATIONAL STEP: each role ends with one step flagged `operational: true` — the
 * questions that govern HOW the assistant runs day to day (trigger/schedule, intake,
 * routing, cadences, thresholds, destinations). The detail page renders ALL of a role's
 * fields (operational + non-operational) together in the profile's "Operational Setup"
 * section instead of the generic Social Media Manager trigger/source radios (assistants.js
 * _renderOperationSection via _roleSchemaFields) — that's the one editable home for these
 * answers. The read-only "Your Onboarding Answers" summary on the home tab mirrors the same
 * fields for reference only (see issue #169).
 *
 * Usage:
 *   const schema = window.AssistantOnboardingSchemas['lead_qualifier'];
 *   if (schema) AssistantOnboardingShell.mount({ container, assistantId, configurationSchema: schema });
 */
(function (root, factory) {
  // Also read on the server (src/utils/setup-field.ts validates a set-up answer card against it), the
  // same UMD shape as brand-contrast.js: module.exports there, window.AssistantOnboardingSchemas here.
  var schemas = factory();
  if (typeof module === 'object' && module.exports) module.exports = schemas;
  else root.AssistantOnboardingSchemas = schemas;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  return {
    // Content Engine — Blog Writer. Topics + brand voice, then the publishing cadence that drives
    // assistant-scheduled "Approve & Schedule" (posting_frequency is read from onboarding_context by
    // src/config/posting-cadence.ts via schedule-blog's approve path; draft_horizon_days is promoted
    // out of here onto the ai_assistants.draft_horizon_days COLUMN, which is what every reader uses).
    newsletter_editor: [
      {
        title: 'What is your newsletter about?',
        description: 'Your Email Marketing Assistant drafts each email in your brand voice from your own business information — you read and approve every one before it sends.',
        fields: [
          {
            key: 'newsletterTopics',
            label: 'Topics & themes',
            type: 'text',
            required: true,
            placeholder: 'e.g. new stock, opening hours, customer stories, seasonal offers',
            helpText: 'Comma-separate what your subscribers actually want to hear about.',
          },
          {
            // Same key as the Blog Writer: onboardingContext.tone_of_voice is what
            // newsletter-generate.ts reads for voice. A different key here would silently
            // fall back to the default tone.
            key: 'tone_of_voice',
            label: 'Writing voice',
            type: 'radio',
            required: true,
            options: [
              { value: 'Professional', label: 'Professional', description: 'Polished and authoritative.' },
              { value: 'Casual', label: 'Casual', description: 'Friendly and conversational.' },
              { value: 'Confident', label: 'Confident', description: 'Bold and direct.' },
              { value: 'Friendly', label: 'Friendly', description: 'Warm and approachable.' },
            ],
          },
        ],
      },
      {
        title: 'How often should it write one?',
        description: 'The assistant drafts on this cadence and leaves each email waiting for you. Nothing is ever sent without your approval.',
        operational: true,
        fields: [
          {
            // Read by the autopilot cron via POSTING_CADENCES / postsPerWeekFor(). 'On demand'
            // means the cron never drafts — the user starts each issue themselves.
            key: 'posting_frequency',
            label: 'Drafting cadence',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose a cadence…',
            options: [
              { value: 'Weekly', label: 'Weekly' },
              { value: '2 times a week', label: 'Twice a week' },
              { value: 'Monthly', label: 'Monthly' },
              { value: 'On demand', label: 'On demand (I start each email)' },
            ],
          },
          {
            key: 'newsletterSendDay',
            label: 'Day you usually send',
            type: 'dropdown',
            required: false,
            placeholder: 'Any day',
            helpText: 'Only used to time the draft so it is ready before you need it.',
            options: [
              { value: 'Monday', label: 'Monday' }, { value: 'Tuesday', label: 'Tuesday' },
              { value: 'Wednesday', label: 'Wednesday' }, { value: 'Thursday', label: 'Thursday' },
              { value: 'Friday', label: 'Friday' },
            ],
          },
        ],
      },
      {
        title: 'Who is it for?',
        description: 'Your audience is shared across every assistant you hire — a sign-up here is a sign-up everywhere, and an unsubscribe stops all of them.',
        fields: [
          {
            key: 'newsletterAudience',
            label: 'Describe your subscribers',
            type: 'textarea',
            required: false,
            placeholder: 'e.g. existing customers who have bought in the last year, plus people who signed up in the shop',
            helpText: 'Helps the assistant pitch each email at the right reader.',
          },
        ],
      },
    ],

    blog_writer: [
      {
        title: 'What should your {role:blog_writer} cover?',
        description: 'Your {role:blog_writer} drafts long-form posts in your brand voice — you review and approve each one before it publishes.',
        fields: [
          {
            key: 'blogTopics',
            label: 'Topics & themes',
            type: 'text',
            required: true,
            placeholder: 'e.g. AI for small teams, productivity, remote work',
            helpText: 'Comma-separate the subjects you want to publish about.',
          },
          {
            // Stored to onboardingContext.tone_of_voice — the field blog-tone.ts + generate-blog read.
            key: 'tone_of_voice',
            label: 'Writing voice',
            type: 'radio',
            required: true,
            options: [
              { value: 'Professional', label: 'Professional', description: 'Polished and authoritative.' },
              { value: 'Casual', label: 'Casual', description: 'Friendly and conversational.' },
              { value: 'Confident', label: 'Confident', description: 'Bold and direct.' },
              { value: 'Friendly', label: 'Friendly', description: 'Warm and approachable.' },
            ],
          },
        ],
      },
      {
        title: 'How often should it publish?',
        description: 'When you approve a post, your {role:blog_writer} schedules it into the next free slot of this cadence — you never pick a date by hand.',
        operational: true,
        fields: [
          {
            // Stored as posting_frequency — POSTING_CADENCES labels, parsed by postsPerWeekFor().
            key: 'posting_frequency',
            label: 'Publishing frequency',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose a cadence…',
            options: [
              { value: 'Daily', label: 'Daily' },
              { value: '3 times a week', label: '3 times a week' },
              { value: '2 times a week', label: '2 times a week' },
              { value: 'Weekly', label: 'Weekly' },
              { value: 'On demand', label: 'On demand (I schedule each one)' },
            ],
          },
          {
            // How far ahead approvals may be scheduled. update-assistant-context.ts promotes this
            // answer onto the ai_assistants.draft_horizon_days COLUMN (clamped 1–30) — that column is
            // the single source of truth; the copy left in onboarding_context is never read. The
            // approve path finds the next free slot within the resulting window.
            key: 'draft_horizon_days',
            label: 'How far ahead to schedule',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose a window…',
            options: [
              { value: '7', label: '1 week ahead' },
              { value: '14', label: '2 weeks ahead' },
              { value: '30', label: '1 month ahead' },
            ],
          },
        ],
      },
    ],
    // Campaign Assistant — the only role whose output is other assistants' work. Its onboarding
    // captures the DEFAULTS every new campaign inherits, not one campaign's brief: a campaign is
    // created on the Campaigns tab and carries its own objective.
    //
    // ⚠️ No money is asked for anywhere in here, and that is deliberate rather than an omission.
    // Phase 1 campaigns are organic-only and the budget they allocate is CAPACITY — the plan's
    // monthly task allowance, already hard-capped server-side by atomicCapCheck. A £ field would be
    // a control that renders, promises and can never return a value, which is the exact bug the
    // paid rails are being held back to avoid (docs/campaign-orchestrator-plan.md §1.1).
    campaign_orchestrator: [
      {
        title: 'What are your campaigns for?',
        description: 'Your Campaign Assistant turns one objective into briefs for your other assistants. These answers become the starting point for every campaign you create — you can change them per campaign.',
        fields: [
          {
            key: 'campaignAudience',
            label: 'Who are your campaigns aimed at?',
            type: 'text',
            required: true,
            placeholder: 'e.g. Operations managers at UK construction firms, 20–200 staff',
            helpText: 'Carried into every brief this assistant writes, so the work your other assistants produce is aimed at the same people.',
          },
          {
            key: 'campaignAngle',
            label: 'What should campaigns lead with?',
            type: 'textarea',
            required: false,
            placeholder: 'e.g. We save site managers a day a week on compliance paperwork.',
            helpText: 'Optional. The argument you want made. Leave blank and each campaign sets its own — this is only the default.',
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'How your Campaign Assistant runs day to day — what it measures, how much of your monthly allowance one campaign may use, and when it has to ask you first.',
        operational: true,
        fields: [
          {
            // Must stay in step with CAMPAIGN_OUTCOME_METRICS in src/config/campaign-vocab.ts,
            // minus UNAVAILABLE_OUTCOME_METRICS (email engagement waits for §9.7 — an outcome that
            // always reads zero is worse than one the user did not pick). A campaign's stage can
            // still overrule this default: an awareness campaign is never measured on leads.
            key: 'defaultOutcomeMetric',
            label: 'How should a campaign measure success?',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose what to count…',
            options: [
              { value: 'leads', label: 'New leads found' },
              { value: 'replies', label: 'Replies received' },
              { value: 'published_content', label: 'Pieces published' },
              { value: 'signups', label: 'Signups captured' },
              { value: 'engagement', label: 'Engagements on its posts' },
              { value: 'clicks', label: 'Clicks on its tracked links' },
            ],
          },
          {
            // The capacity budget, expressed as a share of the monthly allowance rather than a
            // raw number — the number differs per plan and changes when a plan changes, so a
            // stored integer would silently mean something different after an upgrade.
            key: 'capacityPosture',
            label: 'How much of your monthly allowance may one campaign use?',
            type: 'radio',
            required: true,
            options: [
              { value: 'conservative', label: 'Up to a quarter', description: 'Leaves most of your allowance for everyday work outside campaigns.' },
              { value: 'balanced', label: 'Up to a half', description: 'A campaign and your routine work share the month evenly.' },
              { value: 'aggressive', label: 'Up to three quarters', description: 'Campaigns come first. Your other assistants will have less room in the same month.' },
            ],
          },
        ],
      },
    ],
    // Tier 1, Batch 1 — Lead Generator. Captures the ideal customer profile the
    // orchestrator scores every inbound lead against, then how it runs operationally.
    // Brand Designer (docs/brand-designer-plan.md §4). These answers are read on EVERY round's art
    // direction (src/utils/visual-briefs.ts readBriefContext) and by its chat route — the keys must
    // match those lookups exactly, or a typo reads as "never answered" and the steer silently drops.
    // Phase 2 (2026-10-08): the workspace's picture guidelines (organisations.brand_guidelines, edited
    // on Business Information ▸ Brand Assets or from this assistant's chat) are what every AI image
    // reads. These two answers only fill a guideline the workspace has left EMPTY
    // (visual-briefs.ts withSetupFallback) — the help text below must keep saying exactly that.
    // Website Assistant (docs/website-assistant-plan.md). pagesWanted, siteStyle and siteGoal are read
    // by every AI draft of the site (src/utils/site-store.ts runSiteDraft, SITE_SETUP_KEYS) — the keys
    // must match there. currentWebsite fills "Import my current site" (sites.ts importSuggestUrl).
    // Business name, description and audience come from Business Information, not from here.
    website_assistant: [
      {
        title: 'Your website',
        description: 'Your Website Assistant writes your pages from your business details and products. Tell it anything else it should know — you can change all of it later.',
        fields: [
          {
            key: 'currentWebsite',
            label: 'Do you already have a website?',
            type: 'text',
            required: false,
            placeholder: 'e.g. yourbusiness.co.uk',
            helpText: 'Optional. If you do, type its address — the Website tab offers to bring its words and pictures over, so you start from what you have.',
          },
          {
            key: 'pagesWanted',
            label: 'Which pages do you want?',
            type: 'textarea',
            required: false,
            placeholder: 'e.g. Home, a page for each service, About us, Contact',
            helpText: 'Optional. It suggests pages if you leave this blank. Your plan sets how many pages you can have.',
          },
          {
            key: 'siteStyle',
            label: 'How should it sound and feel?',
            type: 'textarea',
            required: false,
            placeholder: 'e.g. Friendly and plain-spoken, like talking to a neighbour. No jargon.',
            helpText: 'Optional. Colours, font and logo come from your brand kit.',
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'The one thing every page should lead a visitor towards.',
        operational: true,
        fields: [
          {
            key: 'siteGoal',
            label: 'What should a visitor do?',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose one…',
            options: [
              { value: 'Book a call or consultation', label: 'Book a call or consultation' },
              { value: 'Buy online', label: 'Buy online' },
              // Same choices as the Mystery Shopper's own question below, so the two can agree.
              { value: 'Start a free trial or sign up', label: 'Start a free trial or sign up' },
              { value: 'Ask for a quote', label: 'Ask for a quote' },
              { value: 'Phone us', label: 'Phone us' },
              { value: 'Visit us in person', label: 'Visit us in person' },
              { value: 'Join the mailing list', label: 'Join the mailing list' },
            ],
          },
        ],
      },
    ],

    // Mystery Shopper (docs/mystery-shopper-plan.md §4.2). Saving these copies them into its audit
    // (src/utils/site-audit-setup.ts syncSiteAuditFromSetup, from update-assistant-context.ts) and,
    // the first time, starts the first check. The keys must match SETUP_KEYS there exactly.
    mystery_shopper: [
      {
        title: 'Your website',
        description: 'Your Mystery Shopper reads your site the way a buyer would and tells you what is costing you customers. It only reads public pages — it never fills in forms or buys anything.',
        fields: [
          {
            key: 'siteUrl',
            label: 'Which website should it check?',
            type: 'text',
            required: true,
            placeholder: 'yourbusiness.co.uk',
            helpText: 'Your homepage, or the page most visitors land on.',
          },
          {
            key: 'idealCustomer',
            label: 'Who is your website for?',
            type: 'textarea',
            required: false,
            placeholder: 'e.g. Owners of 10–50 person service firms who are drowning in admin',
            helpText: 'One or two sentences. It reads your site as this person would.',
          },
          {
            key: 'conversionGoal',
            label: 'What should a visitor do?',
            type: 'dropdown',
            required: false,
            placeholder: 'Choose one…',
            options: [
              { value: 'book_call', label: 'Book a call or consultation' },
              { value: 'buy', label: 'Buy online' },
              { value: 'start_trial', label: 'Start a free trial or sign up' },
              { value: 'get_quote', label: 'Ask for a quote' },
              { value: 'phone', label: 'Phone us' },
              { value: 'visit', label: 'Visit us in person' },
              { value: 'subscribe', label: 'Join the mailing list' },
            ],
          },
          {
            key: 'competitorUrls',
            label: 'Competitors to compare you with (up to 3)',
            type: 'textarea',
            required: false,
            placeholder: 'competitor-one.co.uk\ncompetitor-two.com',
            helpText: 'Optional. One per line. It reads their homepage and up to two more pages, and tells you when they change their headline, prices or offer.',
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'When it checks your site again. A check where nothing has changed is free; one that re-scores uses 1 task.',
        operational: true,
        fields: [
          {
            key: 'checkWeekday',
            label: 'Which day should it check every week?',
            type: 'dropdown',
            required: true,
            defaultValue: '1',
            options: [
              { value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' }, { value: '3', label: 'Wednesday' },
              { value: '4', label: 'Thursday' }, { value: '5', label: 'Friday' }, { value: '6', label: 'Saturday' },
              { value: '0', label: 'Sunday' },
            ],
          },
        ],
      },
    ],

    brand_designer: [
      {
        title: 'Your look',
        description: 'Your Brand Designer already uses your brand colours, font and logo. Tell it what your pictures should feel like — it reads this every time it makes options.',
        fields: [
          {
            key: 'photoStyle',
            label: 'What should your pictures look like?',
            type: 'textarea',
            required: false,
            placeholder: 'e.g. Bright and natural, real people at work, never posed. Lots of white space.',
            helpText: 'Optional. Used when your workspace has no photo style set under Business Information ▸ Brand Assets — that one applies to every assistant’s AI images.',
          },
          {
            key: 'avoidAlways',
            label: 'Anything it must never show?',
            type: 'text',
            required: false,
            placeholder: 'e.g. handshakes, suits, stock-photo smiles',
            helpText: 'Optional. Used when your workspace has no "never show" set under Business Information ▸ Brand Assets.',
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'Where new briefs get their options from, unless you choose otherwise on the brief.',
        operational: true,
        fields: [
          {
            // Read by brand-briefs.ts `list` as the new-brief default. A brief can always change it.
            key: 'defaultSources',
            label: 'Where should options come from by default?',
            type: 'radio',
            required: true,
            options: [
              { value: 'all', label: 'Stock photos, AI images and branded cards', description: 'The widest choice. AI images use 1 AI credit per round of four; the rest are free.' },
              { value: 'free_only', label: 'Stock photos and branded cards only', description: 'Never spends AI credits unless you tick AI images on a brief.' },
            ],
          },
        ],
      },
    ],

    // Video Producer (docs/video-producer-plan.md §5.2). Keys read by video-projects.ts / the Videos tab
    // as the new-video defaults (every video can change them) and by its chat route — keep in step with
    // chat-orchestrator.ts ROUTES.video_producer and src/components/assistant-videos.js.
    video_producer: [
      {
        title: 'Your videos',
        description: 'Your Video Producer writes the script from your business details and Products & Services. Set how your videos usually sound — you can change it on any video.',
        fields: [
          {
            key: 'defaultVoice',
            label: 'Which voice should read your voiceovers?',
            type: 'dropdown',
            required: true,
            options: [
              { value: 'coral', label: 'Warm and friendly' },
              { value: 'sage', label: 'Calm and clear' },
              { value: 'verse', label: 'Bright and upbeat' },
              { value: 'alloy', label: 'Neutral and steady' },
              { value: 'onyx', label: 'Deep and confident' },
              { value: 'shimmer', label: 'Light and lively' },
            ],
          },
          {
            key: 'defaultLength',
            label: 'How long should your videos usually be?',
            type: 'radio',
            required: true,
            options: [
              { value: '15', label: '15 seconds', description: 'One quick point — the most likely to be watched to the end.' },
              { value: '30', label: '30 seconds', description: 'Room for a problem, the answer and a call to action.' },
              { value: '60', label: '60 seconds', description: 'A short explainer or product walk-through.' },
            ],
          },
          {
            key: 'defaultCta',
            label: 'What should viewers do at the end?',
            type: 'text',
            required: false,
            placeholder: 'e.g. Book through the link in our bio',
            helpText: 'Optional. Used as the call to action unless you give a different one on a video.',
          },
          {
            // src/utils/video-autopilot.ts (owner decision D7: off by default; always reviewed).
            // Storyboards only — making the video stays a click, so autopilot never spends a credit.
            key: 'autopilotPerWeek',
            label: 'Should it plan videos for you each week?',
            type: 'radio',
            required: false,
            options: [
              { value: '0', label: 'No, I\u2019ll ask for each video', description: 'Nothing is planned until you ask on the Videos tab or in chat.' },
              { value: '1', label: 'One a week', description: 'A storyboard about one of your products or services, ready for you to check. Nothing is made or spent until you press \u201cMake the video\u201d.' },
              { value: '2', label: 'Two a week', description: 'The same, twice a week. It waits while two storyboards are still waiting for you.' },
              { value: '3', label: 'Three a week', description: 'The same, three times a week. It waits while two storyboards are still waiting for you.' },
            ],
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'Where its footage and pictures come from unless you choose otherwise on a video.',
        operational: true,
        fields: [
          {
            key: 'defaultAllowAi',
            label: 'Where should scenes come from by default?',
            type: 'radio',
            required: true,
            options: [
              { value: 'stock_and_ai', label: 'Stock first, AI where stock won\u2019t fit', description: 'Stock footage and photos are free. AI pictures use 1 credit, AI clips 5 (at most 3 per video).' },
              { value: 'stock_only', label: 'Stock footage, photos and my own pictures only', description: 'Never spends credits on pictures. A voiceover still uses 1.' },
              { value: 'ai_first', label: 'Lean on AI', description: 'More AI scenes when they suit the video — still at most 3 AI clips.' },
            ],
          },
        ],
      },
    ],

    lead_qualifier: [
      {
        title: 'Who is your ideal customer?',
        description: 'Your {role:lead_qualifier} scores every enquiry against this profile, so you only spend time on leads worth chasing.',
        fields: [
          {
            key: 'targetIndustries',
            label: 'Target industries',
            type: 'text',
            required: true,
            placeholder: 'e.g. Construction, Hospitality, Professional services',
            helpText: 'Comma-separate as many as apply. Leads from these industries score higher.',
          },
          {
            key: 'minHeadcount',
            label: 'Minimum company headcount',
            type: 'number',
            required: true,
            placeholder: 'e.g. 10',
            helpText: 'Companies smaller than this are usually a poor fit — leads below it score lower.',
            min: 1,
          },
          {
            // Read by icpFromOnboarding() → every campaign's icp_snapshot, and rendered into all
            // three scoring prompts by src/config/icp-profile.ts.
            //
            // ⚠️ OPTIONAL ON PURPOSE. Every assistant hired before this field existed has no answer,
            // and icpBlock() omits the line entirely when it is blank — so their scoring is
            // unchanged rather than silently shifted by a new prompt line about an empty list.
            key: 'excludeProfile',
            label: 'Who is NOT a customer?',
            type: 'text',
            required: false,
            placeholder: 'e.g. marketing agencies, other consultancies, recruiters',
            helpText: 'Businesses that match the industries above but are peers or competitors rather than buyers. Discovery treats these as a hard no — not a low score — so they never reach your review queue.',
          },
        ],
      },
      {
        title: 'How should we talk to leads?',
        description: 'This sets the voice for lead replies and suggested next steps.',
        fields: [
          {
            key: 'salesTone',
            label: 'Sales tone',
            type: 'radio',
            required: true,
            options: [
              { value: 'formal', label: 'Formal', description: 'Polished and professional — suits corporate or regulated buyers.' },
              { value: 'casual', label: 'Casual', description: 'Friendly and conversational — suits consumer and small-business buyers.' },
            ],
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'How your {role:lead_qualifier} sends the outreach you approve.',
        operational: true,
        // ⚠️ THREE QUESTIONS WERE REMOVED HERE — do not reinstate without wiring them first.
        //   leadIntake        'Where do new leads arrive?'
        //   qualifyTrigger    'When should it qualify leads?'
        //   qualifiedRouting  'Where should qualified leads go?'
        //
        // None was ever read by code — each key appeared only in this file. But an unread answer
        // here is not inert: buildSystemPrompt() in chat-orchestrator.ts dumps EVERY non-empty
        // onboarding_context key into <strict_configuration> under "You MUST obey these rules at
        // all times", so chat was being ordered to honour an intake path, a scoring trigger and a
        // routing rule that nothing implements. Two of leadIntake's own options (web_form,
        // shared_inbox) had no ingest behind them at all.
        //
        // What actually governs each of these, for anyone tempted to re-add them:
        //   intake    — outbound discovery (process-discovery-jobs.ts), plus the chat/csv_import/
        //               integration SOURCES set in assistant-records.ts. Nothing "arrives".
        //   trigger   — scoring happens at discovery time and on demand via enrich_lead; the real
        //               schedule is per-search, in search_schedules.
        //   routing   — fixed by the product: qualified leads land in the Outreach tab.
        fields: [
          {
            // Read by the outreach-send flow: when set to google/microsoft AND that provider is
            // connected, approving a lead sends its outreach email from the user's own inbox.
            // 'google' → OAuth provider 'gmail'; 'microsoft' → OAuth provider 'outlook'.
            key: 'outreachEmailProvider',
            label: 'Send outreach emails from your own inbox?',
            type: 'radio',
            required: true,
            helpText: 'Connect an email account and your {role:lead_qualifier} can send approved outreach for you. You can connect it right after setup.',
            options: [
              { value: 'none', label: "No — I'll send outreach myself", description: 'Approved leads get a ready-to-send draft; you send it from your own email.' },
              { value: 'google', label: 'Yes — Google (Gmail / Workspace)', description: 'BMS sends approved outreach from your connected Google account.' },
              // Honest about the admin-approval wall: until Microsoft publisher verification
              // completes, work/school accounts are likely to be blocked at the consent screen.
              // Better said here than discovered as a dead end mid-connect.
              { value: 'microsoft', label: 'Yes — Microsoft (Outlook / 365)', description: 'BMS sends approved outreach from your connected Outlook or Microsoft 365 account. Work and school accounts may need your IT administrator to approve the connection.' },
            ],
          },
          {
            // Read by every outreach prompt through loadSenderIdentity (src/config/outreach-offer.ts,
            // src/utils/outreach-offer.ts). Optional: blank = "reply", how every email was written
            // before offers existed. WHICH gift form is chosen on the Outreach tab's offer strip (or in
            // chat) — this form can't list them — and defaults to the newest form with a free download.
            key: 'outreachOffer',
            label: 'What should your first emails offer?',
            type: 'radio',
            required: false,
            helpText: 'First emails stay under 75 words, open with their problem, carry no link and never ask for a call — they ask permission instead. The link goes in the first follow-up, or in your reply when they say yes. Change it any time on the Outreach tab.',
            options: [
              { value: 'gift', label: 'A free gift', description: 'Offers the free download from one of your sign-up forms ("Mind if I send it over?"). A sign-up through the link is credited to the lead.' },
              { value: 'intro_offer', label: 'Our free trial or introductory offer', description: 'Uses the offer saved in Business Information ▸ Products & Services, exactly as written.' },
              { value: 'reply', label: 'No offer — just ask a question', description: 'Asks one simple question that invites a reply.' },
            ],
          },
          {
            // Read by enrolInSequence (src/utils/outreach-sequences.ts) on the send path.
            //
            // ⚠️ THIS QUESTION EXISTS BECAUSE APPROVING ONE EMAIL USED TO AUTHORISE FOUR. Every
            // confirmed send enrolled the lead in a three-step cadence with no question asked and no
            // way to turn it off — only a per-conversation Stop, after the first chaser had already
            // gone. The AR Clerk, which chases the user's OWN customers, asks how chasers go out; the
            // assistant that emails strangers did not.
            //
            // Optional on purpose, and 'automatic' is the documented default for a blank answer:
            // every assistant hired before this field existed already has cadences running, and
            // reading "no answer" as "stop chasing" would silently halt live sequences on deploy.
            // The default is stated in the option's own copy so it is a choice, not a surprise.
            key: 'outreachFollowUps',
            label: 'Chase leads who do not reply?',
            type: 'radio',
            required: true,
            // What a blank answer DOES (outreach-sequences.ts reads anything but 'none' as chase).
            // The Business Mentor sees this, so it can't call a blank answer "one email only"
            // (prod 2026-10-26: it did, and proposed "fixing" it).
            blankMeans: 'automatic',
            helpText: 'Chasers are written in the context of each conversation and sent from the same mailbox. They stop the moment someone replies, and the last one always says it is the last.',
            options: [
              { value: 'automatic', label: 'Yes — chase automatically', description: 'Your follow-up plan: three follow-ups to start with — 3 days after the first email, then a week later, then a polite sign-off. Change them any time with Follow-up plan on the Outreach tab.' },
              { value: 'none', label: 'No — one email only', description: 'Approving a lead sends exactly one email. You can still send follow-ups yourself from the Conversations tab.' },
            ],
          },
          {
            // Read by src/utils/outreach-signature.ts at all three send sites (first email,
            // follow-ups, Conversations replies) and by sender-identity, which tells the drafting
            // prompts NOT to sign off while one is set. Blank = no signature, as before.
            //
            // ⚠️ PLAIN TEXT on purpose — outreach is sent text/plain for deliverability, so there are
            // no fonts or images: the recipient's email app picks the typeface. Said in the help text
            // so nobody expects a styled or handwritten signature to survive.
            key: 'outreachSignature',
            label: 'Email signature',
            type: 'textarea',
            required: false,
            placeholder: 'Sam Taylor\nFounder, Taylor & Co\n07700 900123 · taylorandco.example',
            helpText: 'Added under every outreach email — first emails, follow-ups and replies. Plain text, exactly as you type it (your recipient\'s email app chooses the font). When this is set, your {role:lead_qualifier} stops signing off its drafts so the email is not signed twice. Leave blank for no signature.',
          },
        ],
      },
    ],

    // Tier 1, Batch 1 — Accounts Receivable Clerk. Captures the platform, then the
    // collections policy the orchestrator applies when reviewing aged receivables.
    accounts_receivable_clerk: [
      {
        title: 'Where do your invoices live?',
        description: 'Your AR Clerk tailors its advice to the platform your books are on.',
        fields: [
          {
            key: 'accountingPlatform',
            label: 'Accounting platform',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose your platform…',
            options: [
              { value: 'xero', label: 'Xero' },
              { value: 'quickbooks', label: 'QuickBooks' },
            ],
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'How your AR Clerk works — how often it chases, and which invoices are worth chasing. Every chaser it drafts waits for your approval; nothing is sent automatically.',
        operational: true,
        fields: [
          {
            key: 'followUpCadence',
            label: 'Follow-up cadence',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose a cadence…',
            options: [
              { value: 'daily', label: 'Daily', description: 'Chase every business day until paid.' },
              { value: 'every_3_days', label: 'Every 3 days' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'fortnightly', label: 'Fortnightly' },
            ],
          },
          {
            key: 'minInvoiceValue',
            label: 'Minimum invoice value to chase',
            type: 'number',
            required: true,
            placeholder: 'e.g. 100',
            helpText: 'Invoices below this amount are left alone — chasing them costs more than they are worth.',
            min: 0,
          },
        ],
      },
    ],

    // Tier 1, Batch 2 — CRM Enricher. Captures which CRM to enrich and what to hunt for,
    // then how it runs: trigger, scope, and whether existing values may be overwritten.
    // Business Mentor (docs/business-mentor-plan.md). Provisioned for every workspace, so this is
    // rarely shown as a wizard; the Mentor asks the same question in chat on first visit (§3.1).
    // Read by chat-orchestrator.ts ROUTES.business_mentor.
    business_mentor: [
      {
        title: 'Where is your business today?',
        description: 'Your Business Mentor starts from the right place: what you already have, or the idea you want to test.',
        fields: [
          {
            key: 'businessStage',
            label: 'Which describes you best?',
            type: 'radio',
            required: true,
            options: [
              { value: 'existing', label: 'I run an established business', description: 'Start from what is already set up here.' },
              { value: 'new_idea', label: "I'm starting something new", description: 'Start by testing the idea.' },
            ],
          },
        ],
      },
      {
        title: 'How should your Mentor work?',
        description: 'Your Business Mentor is included with your plan and can’t be paused or archived. Quiet mode keeps it in the background instead.',
        operational: true,
        fields: [
          {
            // Read by chat-orchestrator.ts ROUTES.business_mentor (and, from Phase 3, the weekly review).
            key: 'quietMode',
            label: 'Quiet mode',
            type: 'radio',
            required: false,
            options: [
              { value: 'off', label: 'Suggest things', description: 'Your Mentor points out what to fix and suggests next steps.' },
              { value: 'on', label: 'Only when I ask', description: 'No health checks, suggestions or weekly review — it answers your questions and helps with Be More Swan.' },
            ],
          },
          {
            // The weekly review (docs/business-mentor-plan.md §5; src/utils/mentor-review.ts reviewSettings).
            // Quiet mode also stops it. Owners and admins are told by their own notification settings.
            key: 'weeklyReview',
            label: 'Weekly review',
            type: 'radio',
            required: false,
            options: [
              { value: 'on', label: 'Review my week', description: 'Once a week your Mentor compares what happened with your plan and suggests up to 3 changes. 1 task each week.' },
              { value: 'off', label: 'No weekly review', description: 'You can still ask for one any time.' },
            ],
          },
          {
            key: 'reviewDay',
            label: 'Review day',
            type: 'dropdown',
            required: false,
            options: [
              { value: 'Monday', label: 'Monday' },
              { value: 'Tuesday', label: 'Tuesday' },
              { value: 'Wednesday', label: 'Wednesday' },
              { value: 'Thursday', label: 'Thursday' },
              { value: 'Friday', label: 'Friday' },
              { value: 'Saturday', label: 'Saturday' },
              { value: 'Sunday', label: 'Sunday' },
            ],
          },
        ],
      },
    ],
    crm_enricher: [
      {
        title: 'Where does your customer data live?',
        description: 'Your CRM Enricher tailors its field names and workflow to your CRM.',
        fields: [
          {
            key: 'primaryCrm',
            label: 'Primary CRM',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose your CRM…',
            options: [
              { value: 'hubspot', label: 'HubSpot' },
              { value: 'salesforce', label: 'Salesforce' },
              { value: 'pipedrive', label: 'Pipedrive' },
            ],
          },
          {
            key: 'targetEnrichmentData',
            label: 'What data should we find?',
            type: 'text',
            required: true,
            placeholder: 'e.g. LinkedIn, Revenue, Size',
            helpText: 'Comma-separate the fields you want filled in for every company or contact.',
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'How your CRM Enricher works — whether it may replace values you already have. It researches the records you give it in chat or by spreadsheet, and every change waits for your review.',
        operational: true,
        fields: [
          {
            key: 'overwriteLogic',
            label: 'How should existing data be handled?',
            type: 'radio',
            required: true,
            options: [
              { value: 'fill_blanks_only', label: 'Only fill blank fields', description: 'Existing values are never touched — the safest option.' },
              { value: 'overwrite_existing', label: 'Overwrite existing fields', description: 'Fresher enriched data replaces what is already there.' },
            ],
          },
        ],
      },
    ],

    // Tier 1, Batch 2 — Tier 1 Support Agent. Captures the helpdesk and support voice,
    // then how it runs: trigger, reply autonomy, auto-resolve bar and where escalations go.
    // NOTE: roleKey is tier1_support_agent (no underscore after "tier") to match
    // masterAssistants.roleKey seeded by db/seed-catalog.ts.
    tier1_support_agent: [
      {
        title: 'Where do support requests arrive?',
        description: 'Your Support Agent frames its replies and workflow around your helpdesk.',
        fields: [
          {
            key: 'helpdeskPlatform',
            label: 'Helpdesk platform',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose your platform…',
            options: [
              { value: 'zendesk', label: 'Zendesk' },
              { value: 'intercom', label: 'Intercom' },
              { value: 'shared_inbox', label: 'Shared Inbox' },
            ],
          },
        ],
      },
      {
        title: 'How should we sound?',
        description: 'This sets the voice for every customer-facing reply.',
        fields: [
          {
            key: 'supportTone',
            label: 'Support tone',
            type: 'radio',
            required: true,
            options: [
              { value: 'empathetic', label: 'Empathetic', description: 'Leads with understanding — suits sensitive or high-stakes products.' },
              { value: 'professional', label: 'Professional', description: 'Courteous and to the point — suits B2B and regulated industries.' },
              { value: 'energetic', label: 'Energetic', description: 'Upbeat and friendly — suits consumer brands with a playful voice.' },
            ],
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'How your Support Agent works — when it may call a ticket resolved, and who picks up the ones it cannot. It drafts every reply for your review; nothing is sent to a customer automatically.',
        operational: true,
        fields: [
          {
            key: 'autoResolveThreshold',
            label: 'Auto-resolve confidence threshold (%)',
            type: 'number',
            required: true,
            placeholder: 'e.g. 80',
            helpText: 'Your assistant marks a ticket Resolved, with a drafted reply, only when it is at least this confident; anything below is marked Escalated for a person.',
            min: 1,
            max: 100,
          },
          {
            key: 'escalationEmail',
            label: 'Escalation email',
            type: 'text',
            required: true,
            placeholder: 'e.g. support-team@yourbusiness.com',
            helpText: 'Shown on escalated tickets as who should pick them up. Nothing is emailed to it automatically.',
          },
        ],
      },
    ],

    // Tier 1, Batch 3 — Meeting Note Taker. Captures where meetings happen and how
    // summaries read, then how it runs: capture method, task destination, delivery timing.
    meeting_note_taker: [
      {
        title: 'Where do your meetings happen?',
        description: 'Your Note Taker frames its workflow around the platform your calls run on.',
        fields: [
          {
            key: 'meetingPlatform',
            label: 'Meeting platform',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose your platform…',
            options: [
              { value: 'zoom', label: 'Zoom' },
              { value: 'google_meet', label: 'Google Meet' },
              { value: 'teams', label: 'Teams' },
            ],
          },
        ],
      },
      {
        title: 'How should summaries read?',
        description: 'This sets the shape of every meeting summary your Note Taker writes.',
        fields: [
          {
            key: 'summaryFormat',
            label: 'Summary format',
            type: 'radio',
            required: true,
            options: [
              { value: 'executive_bullets', label: 'Executive Bullet Points', description: 'Crisp, scannable bullets — decisions and outcomes at a glance.' },
              { value: 'paragraph_narrative', label: 'Paragraph Narrative', description: 'A flowing prose recap that reads like formal minutes.' },
            ],
          },
        ],
      },
      {
        title: 'Operational set-up',
        description: 'How your Minute Taker works — where its action items go. You give it a transcript or notes (paste them in chat, or import a spreadsheet); it writes the summary, decisions and action items for your review.',
        operational: true,
        fields: [
          {
            key: 'taskDestination',
            label: 'Where should action items go?',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose your tool…',
            options: [
              { value: 'notion', label: 'Notion' },
              { value: 'jira', label: 'Jira' },
              { value: 'asana', label: 'Asana' },
              // Monday.com removed 2026-10-09: sync-action has no Monday handler, so choosing it gave a
              // sync button that could only fail. Restore it in the commit that adds the handler.
            ],
          },
        ],
      },
    ],
  };
}));
