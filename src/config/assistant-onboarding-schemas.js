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
    // assistant-scheduled "Approve & Schedule" (posting_frequency + draft_horizon_days are read by
    // src/config/posting-cadence.ts via schedule-blog's approve path).
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
            // How far ahead approvals may be scheduled. Stored as draft_horizon_days (clamped 1–30
            // by computeScheduleSlots); the approve path finds the next free slot within it.
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
        description: 'How your Lead Generator runs day to day — when it scores leads, where they come from, and where the good ones go.',
        operational: true,
        fields: [
          {
            key: 'leadIntake',
            label: 'Where do new leads arrive?',
            type: 'dropdown',
            required: true,
            placeholder: 'Choose a source…',
            options: [
              { value: 'web_form', label: 'Web form' },
              { value: 'shared_inbox', label: 'Shared inbox' },
              { value: 'crm', label: 'CRM' },
              { value: 'manual', label: 'Manual entry' },
            ],
          },
          {
            key: 'qualifyTrigger',
            label: 'When should it qualify leads?',
            type: 'radio',
            required: true,
            options: [
              { value: 'on_arrival', label: 'Instantly on arrival', description: 'Every new lead is scored the moment it lands.' },
              { value: 'scheduled', label: 'Scheduled batches', description: 'Leads are scored together on a regular schedule.' },
              { value: 'on_demand', label: 'On demand', description: 'It scores leads only when I ask.' },
            ],
          },
          {
            key: 'qualifiedRouting',
            label: 'Where should qualified leads go?',
            type: 'text',
            required: false,
            placeholder: 'e.g. Notify sales@company.com, tag as Hot',
            helpText: 'What should happen to a lead once it passes qualification.',
          },
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
