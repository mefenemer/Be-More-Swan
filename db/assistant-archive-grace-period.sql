-- Issue #191 — Safe Archiving grace period.
-- Archiving an assistant now starts a 14-day, plan-rule-gated reinstate window instead of
-- being immediately terminal. These two columns track the window; purge-archived-assistants.ts
-- (daily cron) hard-deletes any assistant whose scheduled_deletion_at has passed.
ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS archived_at timestamp;
ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS scheduled_deletion_at timestamp;
