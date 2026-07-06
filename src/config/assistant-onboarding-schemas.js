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
 * Usage:
 *   const schema = window.AssistantOnboardingSchemas['lead_qualifier'];
 *   if (schema) AssistantOnboardingShell.mount({ container, assistantId, configurationSchema: schema });
 */
(function () {
  'use strict';

  window.AssistantOnboardingSchemas = {
    // Tier 1, Batch 1 — Lead Qualifier. Captures the ideal customer profile the
    // orchestrator scores every inbound lead against.
    lead_qualifier: [
      {
        title: 'Who is your ideal customer?',
        description: 'Your Lead Qualifier scores every enquiry against this profile, so you only spend time on leads worth chasing.',
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
    ],

    // Tier 1, Batch 1 — Accounts Receivable Clerk. Captures the collections policy the
    // orchestrator applies when reviewing aged receivables.
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
        title: 'Set your chasing policy',
        description: 'How often to follow up, and which invoices are worth the effort.',
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

    // Tier 1, Batch 2 — CRM Enricher. Captures which CRM to enrich, what data to hunt
    // for, and whether existing field values may be overwritten.
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
        title: 'How should we handle existing data?',
        description: 'Decide whether enrichment may replace values already in your CRM.',
        fields: [
          {
            key: 'overwriteLogic',
            label: 'Overwrite behaviour',
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

    // Tier 1, Batch 2 — Tier 1 Support Agent. Captures the helpdesk, the auto-resolve
    // confidence bar, where escalations go, and the support voice.
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
        title: 'Set your escalation policy',
        description: 'When your agent is unsure — or a customer is upset — a human takes over.',
        fields: [
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
    ],

    // Tier 1, Batch 3 — Meeting Note Taker. Captures where meetings happen, where
    // extracted action items should be synced, and how summaries should read.
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
        title: 'Where should action items go?',
        description: 'Every task extracted from a meeting is prepared for sync to this tool.',
        fields: [
          {
            key: 'taskDestination',
            label: 'Task destination',
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
    ],
  };

  // ── Shared "Operational Set-Up" step ───────────────────────────────────────────
  // Every role — like the Social Media Manager — captures WHEN it runs and WHERE its
  // input comes from during onboarding. Appended as the final step of each role's schema
  // below so the answers land in onboardingContext under trigger_type / content_source —
  // the same keys the detail page's "Operational Setup" section and "Your Onboarding
  // Answers" summary read (see assistants.js _detailHydrate / _renderOnboardingSummary).
  const OPERATIONAL_SETUP_STEP = {
    title: 'Operational set-up',
    description: 'Tell us when this assistant should run and where its work comes from.',
    fields: [
      {
        key: 'trigger_type',
        label: 'Trigger / Schedule',
        type: 'radio',
        required: true,
        options: [
          { value: 'on_demand', label: 'On Demand', description: 'I trigger it manually when I need it.' },
          { value: 'reactive', label: 'Reactive', description: 'It runs automatically when a new brief or data arrives.' },
          { value: 'scheduled', label: 'Scheduled', description: 'It runs on a fixed recurring schedule.' },
        ],
      },
      {
        key: 'content_source',
        label: 'Content Source',
        type: 'radio',
        required: true,
        options: [
          { value: 'client_provided', label: 'Client Provided', description: 'I supply the drafts, data or notes — the assistant processes it.' },
          { value: 'assistant_generated', label: 'Assistant Generated', description: 'The assistant researches and produces everything independently.' },
          { value: 'hybrid', label: 'Hybrid', description: 'A mix — I provide direction, the assistant fills the gaps.' },
        ],
      },
    ],
  };

  // Append a fresh copy of the operational step to every role's schema (deep-cloned so the
  // roles never share a mutable step object).
  Object.keys(window.AssistantOnboardingSchemas).forEach((roleKey) => {
    window.AssistantOnboardingSchemas[roleKey].push(
      JSON.parse(JSON.stringify(OPERATIONAL_SETUP_STEP))
    );
  });
})();
