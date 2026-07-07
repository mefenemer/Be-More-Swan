-- db/assistant-records-approval.sql
-- Human-in-the-loop approval gate for the Internal Data Hub (assistant_records).
-- Adds the approval lifecycle that powers the assistant-detail Review Queue + Calendar tabs.
-- APPLY MANUALLY (project convention — new db/*.sql are not pushed by drizzle-kit).
--
-- Lifecycle: pending_approval → approved → scheduled (with scheduled_for) ; or → rejected.
-- Every AI-produced record enters 'pending_approval'; CSV-imported rows are back-filled to
-- 'approved' below (user-supplied, not AI-generated, so no review gate needed).

BEGIN;

ALTER TABLE assistant_records
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending_approval',
  ADD COLUMN IF NOT EXISTS scheduled_for timestamp;

-- Existing CSV imports pre-date the gate — treat them as already-approved so they don't all
-- suddenly appear in the Review Queue.
UPDATE assistant_records SET approval_status = 'approved'
  WHERE source = 'csv_import' AND approval_status = 'pending_approval';

DO $$ BEGIN
  ALTER TABLE assistant_records ADD CONSTRAINT assistant_records_approval_check
    CHECK (approval_status IN ('pending_approval', 'approved', 'scheduled', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS assistant_records_approval_idx
  ON assistant_records (organisation_id, ai_assistant_id, record_type, approval_status);

COMMIT;
