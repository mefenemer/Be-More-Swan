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
 *   cfg.modules  // → { hasReviewQueue, hasPostingSchedule, hasSocialStrategy }
 *   cfg.hubTab   // → optional Internal Data Hub tab config (assistant-data-hub.js);
 *                //   absent = no Data Hub tab for this role (e.g. social_media_manager)
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
      modules: { hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false },
      hubTab: {
        id: 'datahub',
        label: 'Leads',
        recordType: 'lead',
        description: 'Every lead this assistant has scored — with its outreach draft — plus any lead lists you import.',
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
      modules: { hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false },
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
      modules: { hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false },
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
      modules: { hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false },
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
      modules: { hasReviewQueue: false, hasPostingSchedule: false, hasSocialStrategy: false },
      hubTab: {
        id: 'datahub',
        label: 'Meeting Notes',
        recordType: 'meeting',
        // NOT the same thing as the Progress Reviews tab (check-ins with this
        // assistant) — this is a library of the user's own business meetings.
        description: 'Notes from your business meetings — browse summaries and tick off action items. Check-ins with this assistant live in Progress Reviews.',
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
