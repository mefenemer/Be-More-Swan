-- db/z-pr-approval.sql — staging / prod PR pills and the Approve button on the Fix pipeline and the
-- Feature requests board (owner, 2026-11-13; src/utils/pr-approval.ts).
--
--   prod_pr_url            the PR into main that ships this ticket (the staging PR stays in dev_pr_url)
--   approval_pr_url        the PR Claude is asking the owner to approve (NULL = no Approve button)
--   approval_note          one line from Claude on what the owner is approving
--   approval_requested_at  when Claude asked
--
-- Claude sets the request from its session (scripts/fix-tickets.ts / scripts/feature-requests.ts
-- ask-approval); the owner's Approve click clears it. Not declared in db/schema.ts, read raw behind
-- prApprovalColumnsReady(). Additive and idempotent: run on BOTH DBs.
-- (feature_requests.dev_pr_url comes from db/z-claude-drafts-and-features.sql; added here too, harmlessly.)

BEGIN;

ALTER TABLE issue_reports
    ADD COLUMN IF NOT EXISTS prod_pr_url TEXT,
    ADD COLUMN IF NOT EXISTS approval_pr_url TEXT,
    ADD COLUMN IF NOT EXISTS approval_note TEXT,
    ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMP;

ALTER TABLE feature_requests
    ADD COLUMN IF NOT EXISTS dev_pr_url TEXT,
    ADD COLUMN IF NOT EXISTS prod_pr_url TEXT,
    ADD COLUMN IF NOT EXISTS approval_pr_url TEXT,
    ADD COLUMN IF NOT EXISTS approval_note TEXT,
    ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMP;

COMMIT;

-- Check (expect 8):
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_name IN ('issue_reports', 'feature_requests')
--    AND column_name IN ('prod_pr_url', 'approval_pr_url', 'approval_note', 'approval_requested_at');
