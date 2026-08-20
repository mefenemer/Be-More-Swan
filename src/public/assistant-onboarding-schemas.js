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
(function () {
  'use strict';

  window.AssistantOnboardingSchemas = {
    // Content Engine — Blog Writer. Topics + brand voice, then the publishing cadence that drives
    // assistant-scheduled "Approve & Schedule" (posting_frequency is read from onboarding_context by
    // src/config/posting-cadence.ts via schedule-blog's approve path; draft_horizon_days is promoted
    // out of here onto the ai_assistants.draft_horizon_days COLUMN, which is what every reader uses).
    newsletter_editor: [
      {
        title: 'What is your newsletter about?',
        description: 'Your Newsletter Assistant drafts each issue in your brand voice from your own business information — you read and approve every one before it sends.',
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
        description: 'The assistant drafts on this cadence and leaves each issue waiting for you. Nothing is ever sent without your approval.',
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
              { value: 'On demand', label: 'On demand (I start each issue)' },
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
            helpText: 'Helps the assistant pitch each issue at the right reader.',
          },
        ],
      },
    ],

    blog_writer: [
      {
        title: 'What should your Blog Writer cover?',
        description: 'Your Blog Writer drafts long-form posts in your brand voice — you review and approve each one before it publishes.',
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
        description: 'When you approve a post, your Blog Writer schedules it into the next free slot of this cadence — you never pick a date by hand.',
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
            // minus UNAVAILABLE_OUTCOME_METRICS. `signups` is deliberately absent: nothing counts
            // it until the Phase 2 capture page exists, and an outcome that always reads zero is
            // worse than one the user did not pick.
            key: 'defaultOutcomeMetric',
            label: 'How should a campaign measure success?',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose what to count…',
            options: [
              { value: 'leads', label: 'New leads found' },
              { value: 'replies', label: 'Replies from prospects' },
              { value: 'published_content', label: 'Pieces published' },
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
          {
            // The autonomy gate. Note that NONE of these settings can authorise starting a spend,
            // raising a ceiling or resuming a paused campaign — those three always need a human
            // click on the campaign surface, whatever is chosen here.
            key: 'autonomyLevel',
            label: 'When should it act without asking?',
            type: 'radio',
            required: true,
            options: [
              { value: 'propose_only', label: 'Ask me about everything', description: 'Every brief waits in your Decisions queue until you approve it.' },
              { value: 'reallocate_freely', label: 'Let it move work between assistants', description: 'It can shift the remaining allowance between your assistants on its own. Starting a campaign, raising a limit and resuming a paused campaign still need you.' },
            ],
          },
        ],
      },
    ],
    // Tier 1, Batch 1 — Lead Generator. Captures the ideal customer profile the
    // orchestrator scores every inbound lead against, then how it runs operationally.
    lead_qualifier: [
      {
        title: 'Who is your ideal customer?',
        description: 'Your Lead Generator scores every enquiry against this profile, so you only spend time on leads worth chasing.',
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
        description: 'How your Lead Generator sends the outreach you approve.',
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
            helpText: 'Connect an email account and your Lead Generator can send approved outreach for you. You can connect it right after setup.',
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
            helpText: 'Chasers are written in the context of each conversation and sent from the same mailbox. They stop the moment someone replies, and the last one always says it is the last.',
            options: [
              { value: 'automatic', label: 'Yes — chase automatically', description: 'Up to three follow-ups: 3 days after the first email, then a week later, then a polite sign-off. Nothing after that.' },
              { value: 'none', label: 'No — one email only', description: 'Approving a lead sends exactly one email. You can still send follow-ups yourself from the Conversations tab.' },
            ],
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
        description: 'How your AR Clerk runs — when it reviews receivables, which invoices are worth chasing, and how chasers go out.',
        operational: true,
        fields: [
          {
            key: 'chaseTrigger',
            label: 'When should it review receivables?',
            type: 'radio',
            required: true,
            options: [
              { value: 'when_overdue', label: 'Automatically when overdue', description: 'It reviews invoices the moment they pass their due date.' },
              { value: 'scheduled', label: 'Scheduled', description: 'It reviews the ledger on a regular schedule.' },
              { value: 'on_demand', label: 'On demand', description: 'It reviews only when I ask.' },
            ],
          },
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
          {
            key: 'sendMode',
            label: 'How should chasers be sent?',
            type: 'radio',
            required: true,
            options: [
              { value: 'draft_for_approval', label: 'Draft for my approval', description: 'I review every chaser before it goes out.' },
              { value: 'send_automatically', label: 'Send automatically', description: 'Chasers go out on cadence without me.' },
            ],
          },
        ],
      },
    ],

    // Tier 1, Batch 2 — CRM Enricher. Captures which CRM to enrich and what to hunt for,
    // then how it runs: trigger, scope, and whether existing values may be overwritten.
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
        description: 'How your CRM Enricher runs — when it enriches, which records it processes, and whether it may replace existing values.',
        operational: true,
        fields: [
          {
            key: 'enrichTrigger',
            label: 'When should it enrich?',
            type: 'radio',
            required: true,
            options: [
              { value: 'on_create', label: 'On new record created', description: 'Each new company or contact is enriched as it appears.' },
              { value: 'scheduled_sweep', label: 'Scheduled sweep', description: 'It works through records on a regular schedule.' },
              { value: 'on_demand', label: 'On demand', description: 'It enriches only when I ask.' },
            ],
          },
          {
            key: 'enrichScope',
            label: 'Which records should it process?',
            type: 'radio',
            required: true,
            options: [
              { value: 'new_only', label: 'New records only', description: 'Only records created from now on.' },
              { value: 'new_and_backlog', label: 'New + existing backlog', description: 'Also work back through records already in the CRM.' },
            ],
          },
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
        description: 'How your Support Agent runs — when it engages, whether replies auto-send, and when to hand off to a human.',
        operational: true,
        fields: [
          {
            key: 'ticketTrigger',
            label: 'When should it engage?',
            type: 'radio',
            required: true,
            options: [
              { value: 'real_time', label: 'Real-time on new ticket', description: 'It picks up every ticket as it arrives.' },
              { value: 'on_demand', label: 'On demand', description: 'It works tickets only when I ask.' },
            ],
          },
          {
            key: 'replyMode',
            label: 'How should replies be handled?',
            type: 'radio',
            required: true,
            options: [
              { value: 'auto_send', label: 'Auto-send confident replies', description: 'Replies above the confidence bar go out automatically.' },
              { value: 'draft_for_review', label: 'Draft everything for review', description: 'I review every reply before it is sent.' },
            ],
          },
          {
            key: 'autoResolveThreshold',
            label: 'Auto-resolve confidence threshold (%)',
            type: 'number',
            required: true,
            placeholder: 'e.g. 80',
            helpText: 'Tickets are only resolved automatically when the agent is at least this confident; anything below escalates.',
            min: 1,
            max: 100,
          },
          {
            key: 'escalationEmail',
            label: 'Escalation email',
            type: 'text',
            required: true,
            placeholder: 'e.g. support-team@yourbusiness.com',
            helpText: 'Escalated tickets are flagged for this inbox with full context.',
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
        description: 'How your Note Taker runs — how it captures meetings, where action items sync, and when notes land.',
        operational: true,
        fields: [
          {
            key: 'captureMethod',
            label: 'How should it capture meetings?',
            type: 'radio',
            required: true,
            options: [
              { value: 'auto_join', label: 'Auto-join my calls', description: 'It joins scheduled meetings and captures them live.' },
              { value: 'upload', label: 'I upload recordings & transcripts', description: 'I provide the recording or transcript afterwards.' },
            ],
          },
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
              { value: 'monday', label: 'Monday.com' },
            ],
          },
          {
            key: 'deliveryTiming',
            label: 'When should notes be delivered?',
            type: 'radio',
            required: true,
            options: [
              { value: 'immediately', label: 'Immediately after the meeting', description: 'Notes land as soon as the meeting ends.' },
              { value: 'batched', label: 'Batched (end of day)', description: 'Notes are delivered together at the end of the day.' },
            ],
          },
        ],
      },
    ],
  };
})();
