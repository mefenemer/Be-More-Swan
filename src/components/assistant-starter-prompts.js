/**
 * src/components/assistant-starter-prompts.js
 *
 * Zero-state starter prompts for the chat window (chat-session.js), keyed by the
 * assistant's roleKey (db/seed-catalog.ts — snake_case, verbatim). Each entry is a
 * list of ready-to-send messages rendered as clickable pills when a brand-new
 * session opens with no history.
 *
 * Usage:
 *   const prompts = window.AssistantStarterPrompts.get(roleKey);
 *   // → string[] — falls back to the `default` set for unknown/missing keys.
 *
 * Load before chat-session.js. Adding a new assistant? Add its roleKey here;
 * until then it inherits the default prompts.
 */
(function () {
  'use strict';

  const PROMPTS = {
    // Phrased so the first turn produces an OBJECTIVE, which is the only input this assistant
    // needs. Nothing here asks it to start, spend or launch — those are clicks on the Campaigns
    // tab, and a starter prompt that implied otherwise would set up the exact expectation
    // chat-creates-draft-campaigns says we must not create.
    campaign_orchestrator: [
      'I want to plan a campaign — here is what I am trying to achieve this quarter.',
      'Which of my assistants should work on my next launch, and on what?',
      'How is my current campaign doing, and what would you change about it?',
    ],
    lead_qualifier: [
      'Score these leads for me — I’ll paste in a list of company URLs.',
      'What information do you need from me to qualify a new lead?',
      'Which of my recent leads should sales follow up with first?',
    ],
    accounts_receivable_clerk: [
      'Show me a summary of all overdue invoices.',
      'Draft a polite payment reminder for an invoice that’s 14 days overdue.',
      'Which clients should I chase for payment first this week?',
    ],
    crm_enricher: [
      'Enrich the record for Acme Corp — find their industry, size and website.',
      'Find the company size and headquarters for a company I’ll name.',
      'Which fields on my contacts can you fill in automatically?',
    ],
    tier1_support_agent: [
      'How should I handle a refund request?',
      'Draft a calm, professional response to an angry customer email.',
      'When should a ticket be escalated instead of answered directly?',
    ],
    meeting_note_taker: [
      'Extract the action items from a transcript I’ll paste in.',
      'Summarize my last meeting as a short executive briefing.',
      'Turn my rough meeting notes into structured minutes.',
    ],
    blog_writer: [
      'Draft a blog post on a topic I’ll give you.',
      'Suggest a few article ideas that fit my audience and niche.',
      'Which of my published posts are losing search traffic and need a refresh?',
    ],
    default: [
      'What can you help me with?',
      'What information do you need from me to get started?',
      'Show me an example of the work you do best.',
    ],
  };

  /** Prompts for a roleKey, falling back to the generic default set. */
  function get(roleKey) {
    const list = PROMPTS[roleKey];
    return Array.isArray(list) && list.length ? list : PROMPTS.default;
  }

  window.AssistantStarterPrompts = { get, PROMPTS };
})();
