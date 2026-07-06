/**
 * src/config/assistant-role-content.js
 *
 * Marketing copy for the assistant role detail pages (assistant-role-detail.html).
 * Keyed by roleKey — must match db/seed-catalog.ts verbatim (note: it is
 * tier1_support_agent, with no underscore after "tier").
 *
 * Loaded by:
 *   - assistant-role-detail.html (renders the full detail view)
 *   - workspace.html (the catalogue links any role listed here to its detail page)
 *
 * Usage:
 *   const content = window.AssistantRoleContent['lead_qualifier'];
 */
(function () {
  'use strict';

  window.AssistantRoleContent = {

    // The flagship role — without this entry its card is the only live one that
    // doesn't open the detail modal (cards are clickable only when copy exists here).
    // CTA routing is already safe for schema-less roles: assistant-setup.html and
    // _catHire both fall back to the legacy onboarding flow.
    social_media_manager: {
      name: 'The Social Media Manager',
      category: 'Marketing & Sales',
      iconKey: 'megaphone',
      iconColor: 'pink',
      tagline: 'Consistent, on-brand content — without the daily grind.',
      description: 'Plans, writes, and schedules branded content across all your social channels. Every post lands in your Review Queue for approval, so nothing goes out without your sign-off.',
      keyFeatures: [
        'Automated Content Drafting & Scheduling',
        'Human-in-the-loop Review Queue',
        'Per-platform Hashtag & Format Strategy',
      ],
      integrations: ['Facebook', 'Instagram', 'LinkedIn', 'X (Twitter)', 'Threads', 'TikTok', 'YouTube'],
    },

    lead_qualifier: {
      name: 'The Lead Qualifier',
      category: 'Marketing & Sales',
      iconKey: 'chart',
      iconColor: 'blue',
      tagline: 'Stop chasing cold leads. Let AI find your next best customer.',
      description: 'Researches inbound leads, scores them based on your Ideal Customer Profile (ICP), and drafts personalized outreach emails—so your sales team only talks to winners.',
      keyFeatures: [
        'Automated Lead Scoring',
        'Personalized Outreach Drafting',
        'Handoff to CRM Enricher for missing data',
      ],
      integrations: ['HubSpot', 'Salesforce', 'LinkedIn', 'Gmail'],
    },

    accounts_receivable_clerk: {
      name: 'The Accounts Receivable Clerk',
      category: 'Finance & Bookkeeping',
      iconKey: 'chart',
      iconColor: 'orange',
      tagline: 'Protect your cash flow without the awkward conversations.',
      description: 'Politely but persistently chases unpaid invoices, drafts payment reminders, and logs notes directly into your accounting software.',
      keyFeatures: [
        'Automated Dunning Sequences',
        'Smart Thresholds (ignores small balances)',
        'Live Ledger Syncing',
      ],
      integrations: ['Xero', 'QuickBooks', 'Gmail'],
    },

    crm_enricher: {
      name: 'The CRM Enricher',
      category: 'Marketing & Sales',
      iconKey: 'cog',
      iconColor: 'purple',
      tagline: 'Keep your CRM spotless and actionable.',
      description: 'Scours the web to fill in missing contact details—company size, funding stage, LinkedIn profiles—for every new lead in your database.',
      keyFeatures: [
        'Deep Data Enrichment',
        'Blank-Field Detection',
        'Smart Overwrite Protection',
      ],
      integrations: ['HubSpot', 'Salesforce', 'LinkedIn'],
    },

    tier1_support_agent: {
      name: 'The Tier 1 Support Agent',
      category: 'Customer Success & Support',
      iconKey: 'smile',
      iconColor: 'teal',
      tagline: 'Cut your first-response times to zero.',
      description: 'Instantly resolves common FAQs—refunds, password resets, shipping times—and seamlessly escalates complex issues to your human team with full context.',
      keyFeatures: [
        'Automated Ticket Resolution',
        'Sentiment Analysis',
        'Smart Human Escalation',
      ],
      integrations: ['Zendesk', 'Intercom', 'Gmail'],
    },

    meeting_note_taker: {
      name: 'The Meeting Note Taker',
      category: 'Project Management',
      iconKey: 'document',
      iconColor: 'blue',
      tagline: 'Never lose an action item again.',
      description: 'Attends virtual meetings, transcribes the conversation, and instantly extracts action items—assigning them to the right people before the call even ends.',
      keyFeatures: [
        'Executive Summaries',
        'Action Item Extraction',
        'Direct Project Board Syncing',
      ],
      integrations: ['Zoom', 'Slack', 'Notion', 'Jira'],
    },

  };

  // Legacy roleKey aliases — assistants hired before the namespace unification
  // (db/rolekey-namespace-unification.sql) were all Social Media Managers under the
  // retired 'social_media' / 'community_mgmt' keys. Alias them to the canonical SMM
  // entry so an un-migrated roleKey resolves to real content instead of undefined.
  ['social_media', 'community_mgmt'].forEach(function (legacyKey) {
    if (!window.AssistantRoleContent[legacyKey]) {
      window.AssistantRoleContent[legacyKey] = window.AssistantRoleContent.social_media_manager;
    }
  });
})();
