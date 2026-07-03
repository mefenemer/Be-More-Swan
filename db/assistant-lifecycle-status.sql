-- Digital Assistant Lifecycle Management — US1 foundation.
-- Introduces the canonical 6-state machine column `lifecycle_status` on ai_assistants:
--   provisioning | ready_for_work | working | paused | system_paused | archived
--
-- Design (see memory: assistant-lifecycle-epic):
--   • The legacy (provisioning_status, is_active) pair stays as-is. A BEFORE trigger keeps
--     lifecycle_status DERIVED from that pair, so every existing write site (onboarding,
--     stripe-webhook, trial-expiry, manage-assistant, provision-assistant-async, …) stays
--     consistent without being individually edited.
--   • The forward-only state `ready_for_work` has no (provisioning_status, is_active) equivalent.
--     It is written EXPLICITLY by the transitionAssistantStatus() helper; the trigger detects an
--     explicit lifecycle_status change on UPDATE and leaves it untouched.
--
-- APPLY THIS FILE manually (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle; a push can propose
-- DROP POLICY. These plain ALTERs cannot touch RLS; the new column inherits the table's grants
-- and row policies automatically. Idempotent — safe to re-run.

-- 1. Column (nullable first so we can backfill before enforcing NOT NULL) ---------
ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS lifecycle_status text;

-- 2. Derivation function: legacy (provisioning_status, is_active) → lifecycle_status.
--    Mirrors LEGACY_TO_LIFECYCLE in src/utils/assistant-lifecycle.ts.
CREATE OR REPLACE FUNCTION assistant_lifecycle_from_legacy(ps text, active boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ps = 'cancelled'                       THEN 'archived'
    WHEN ps IN ('paused_payment','paused_limit')THEN 'system_paused'
    WHEN ps IN ('pending','pending_payment','failed') OR ps IS NULL THEN 'provisioning'
    WHEN ps = 'complete' AND active             THEN 'working'
    WHEN ps = 'complete' AND NOT active         THEN 'paused'
    ELSE 'provisioning'
  END
$$;

-- 3. Backfill existing rows (only where unset, so re-runs never clobber forward states).
UPDATE ai_assistants
   SET lifecycle_status = assistant_lifecycle_from_legacy(provisioning_status, is_active)
 WHERE lifecycle_status IS NULL;

-- 4. Enforce default + NOT NULL now that every row has a value.
ALTER TABLE ai_assistants ALTER COLUMN lifecycle_status SET DEFAULT 'provisioning';
ALTER TABLE ai_assistants ALTER COLUMN lifecycle_status SET NOT NULL;

-- 5. CHECK constraint: only the six valid states.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_assistants_lifecycle_status_check') THEN
    ALTER TABLE ai_assistants ADD CONSTRAINT ai_assistants_lifecycle_status_check
      CHECK (lifecycle_status IN
        ('provisioning','ready_for_work','working','paused','system_paused','archived'));
  END IF;
END $$;

-- 6. Sync trigger: keep lifecycle_status derived from the legacy pair, EXCEPT when a caller
--    (the transition helper) explicitly changed lifecycle_status in the same statement.
CREATE OR REPLACE FUNCTION ai_assistants_derive_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Explicit forward write (e.g. → ready_for_work) on UPDATE: respect the caller.
  IF TG_OP = 'UPDATE' AND NEW.lifecycle_status IS DISTINCT FROM OLD.lifecycle_status THEN
    RETURN NEW;
  END IF;
  -- Otherwise derive from (provisioning_status, is_active).
  NEW.lifecycle_status := assistant_lifecycle_from_legacy(NEW.provisioning_status, NEW.is_active);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ai_assistants_lifecycle_sync ON ai_assistants;
CREATE TRIGGER ai_assistants_lifecycle_sync
  BEFORE INSERT OR UPDATE ON ai_assistants
  FOR EACH ROW EXECUTE FUNCTION ai_assistants_derive_lifecycle();

-- 7. Index for dashboard/admin lifecycle filters.
CREATE INDEX IF NOT EXISTS ai_assistants_org_lifecycle_idx
  ON ai_assistants (organisation_id, lifecycle_status);
