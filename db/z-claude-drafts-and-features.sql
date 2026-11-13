-- db/z-claude-drafts-and-features.sql — Claude's drafts in the Inbox, and Claude's work on feature requests.
--
-- Owner, 2026-11-13 (docs/claude-inbox-and-features.md):
--   • Inbox: Claude drafts a reply to a support question; the owner reviews, edits and sends it from the
--     ticket. Nothing is sent until the owner presses Send Reply. Sending clears the draft.
--   • Feature requests: the owner chooses what to build; Claude moves the request along the board from its
--     session (scripts/feature-requests.ts), with notes and its pull request, and a "Claude working" pill.
--
-- Not declared in db/schema.ts (Drizzle names every declared column in an INSERT), read and written raw
-- behind claudeWorkColumnsReady() in src/utils/claude-work.ts. Additive and idempotent: run on BOTH DBs.

BEGIN;

ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS draft_reply TEXT,
    ADD COLUMN IF NOT EXISTS draft_note TEXT,
    ADD COLUMN IF NOT EXISTS draft_at TIMESTAMP;

ALTER TABLE feature_requests
    ADD COLUMN IF NOT EXISTS dev_runner_id TEXT,
    ADD COLUMN IF NOT EXISTS dev_runner_heartbeat TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_pr_url TEXT,
    ADD COLUMN IF NOT EXISTS dev_notes TEXT;

COMMIT;

-- Check (expect 7):
-- SELECT count(*) FROM information_schema.columns
--  WHERE (table_name = 'support_tickets' AND column_name IN ('draft_reply','draft_note','draft_at'))
--     OR (table_name = 'feature_requests' AND column_name IN ('dev_runner_id','dev_runner_heartbeat','dev_pr_url','dev_notes'));
