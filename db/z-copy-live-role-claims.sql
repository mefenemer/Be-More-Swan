-- db/z-copy-live-role-claims.sql — Assistant Library copy for LIVE roles: drop claims the code does not honour (2026-10-20).
--
-- Checked against the code that implements each role, not against other copy:
--
-- · Minute Taker (meeting_note_taker) said it "Attends virtual meetings, transcribes the conversation"
--   and listed Zoom. Its chat route (netlify/functions/chat-orchestrator.ts, meeting_note_taker) works
--   only from text the user pastes, and no Zoom connector exists. Slack, Notion and Jira stay: they
--   are real sync-action.ts handlers. Zoom is kept as "(coming soon)".
-- · First-Line Support Assistant (tier1_support_agent) said it "Instantly resolves common FAQs —
--   refunds…". It drafts a reply the user sends, and a refund demand is a MANDATORY escalation in its
--   prompt. Zendesk/Intercom: the support/chat categories are not live in src/utils/connection-map.ts,
--   so its Connections tab shows them as coming soon. Gmail was never used by this role.
-- · Accounts Receivable Clerk said "Automated Dunning Sequences" and "Live Ledger Syncing". It drafts
--   chasing emails from invoices the user pastes or uploads; nothing is sent on a schedule and no
--   ledger is read. Xero/QuickBooks: payments/accounting are not live in connection-map.ts. No Gmail.
-- · Lead Generation Assistant listed LinkedIn, which lead discovery never reads; approved outreach
--   sends from Gmail or Outlook (MAILBOX_PROVIDERS), so Outlook replaces it.
--
-- Mirrored in db/seed-assistant-content.ts, db/seed-catalog.ts and seed/data/master_assistants.json.
-- Idempotent: every UPDATE is guarded on the OLD claim still being there, so a re-run is a no-op and
-- a later edit in Admin ▸ Assistants is never overwritten.
-- Apply (staging first): node scripts/db-migrate.mjs apply --only z-copy-live-role-claims --execute --yes

-- ── Minute Taker ──────────────────────────────────────────────────────────────
UPDATE master_assistants
   SET description = 'Turns the meeting transcripts and notes you paste in into clear minutes: a summary, the decisions made, and every action item with its owner, ready to send to Slack, Notion or Jira.',
       updated_at = now()
 WHERE role_key = 'meeting_note_taker'
   AND description LIKE 'Attends virtual meetings%';

UPDATE master_assistants
   SET integrations = '["Slack","Notion","Jira","Zoom (coming soon)"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'meeting_note_taker'
   AND integrations ? 'Zoom';

-- ── First-Line Support Assistant ──────────────────────────────────────────────
UPDATE master_assistants
   SET tagline = 'Faster first replies, answered from your own help articles.',
       updated_at = now()
 WHERE role_key = 'tier1_support_agent'
   AND tagline = 'Cut your first-response times to zero.';

UPDATE master_assistants
   SET description = 'Drafts replies to the customer questions you paste or forward, answering from your Knowledge Base, and hands the tricky ones (angry customers, refund demands, requests for a manager) to your team with a summary.',
       updated_at = now()
 WHERE role_key = 'tier1_support_agent'
   AND description LIKE 'Instantly resolves common FAQs%';

UPDATE master_assistants
   SET key_features = '["Drafted Replies from Your Knowledge Base","Angry Customers and Refund Demands Flagged","Smart Human Escalation"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'tier1_support_agent'
   AND key_features ? 'Automated Ticket Resolution';

UPDATE master_assistants
   SET integrations = '["Zendesk (coming soon)","Intercom (coming soon)"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'tier1_support_agent'
   AND (integrations ? 'Zendesk' OR integrations ? 'Intercom' OR integrations ? 'Gmail');

-- ── Accounts Receivable Clerk ─────────────────────────────────────────────────
UPDATE master_assistants
   SET description = 'Works through the overdue invoices you paste or upload and drafts a chasing email for each one, friendly at first and firmer as the debt ages, while leaving small balances alone.',
       updated_at = now()
 WHERE role_key = 'accounts_receivable_clerk'
   AND description LIKE 'Politely but persistently chases%';

UPDATE master_assistants
   SET key_features = '["Chasing Emails Matched to How Late Each Invoice Is","Smart Thresholds (ignores small balances)","You Approve Every Reminder"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'accounts_receivable_clerk'
   AND (key_features ? 'Automated Dunning Sequences' OR key_features ? 'Live Ledger Syncing');

UPDATE master_assistants
   SET integrations = '["Xero (coming soon)","QuickBooks (coming soon)"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'accounts_receivable_clerk'
   AND (integrations ? 'Xero' OR integrations ? 'QuickBooks' OR integrations ? 'Gmail');

-- ── Lead Generation Assistant ─────────────────────────────────────────────────
UPDATE master_assistants
   SET integrations = '["HubSpot","Salesforce","Gmail","Outlook"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'lead_qualifier'
   AND integrations ? 'LinkedIn';
