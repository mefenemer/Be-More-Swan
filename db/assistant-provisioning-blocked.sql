-- Surface gate-blocked assistants stuck in provisioning.
--
-- Problem: provision-assistant-background.ts `return`s early when a compliance/readiness gate
-- blocks activation (missing AI disclosure, ToS not accepted, prohibited-use ack required, DPA
-- not accepted, high-risk EU conformity) WITHOUT changing provisioning_status. The row stayed
-- 'pending', the lifecycle trigger derived lifecycle_status='provisioning', and the assistant sat
-- there forever — the only signal a user got was the misleading 409 "still being set up" on
-- Start Working. There was no retry path either.
--
-- Fix: a distinguishable, user-actionable state. provisioning_status='blocked' + a machine reason
-- code in provisioning_blocked_reason. 'blocked' still derives lifecycle_status='provisioning'
-- (no new lifecycle state — the 6-state machine is unchanged), but the dashboard can show exactly
-- what to fix, kickoff-assistant can return the actionable reason, and retry-provision-assistant /
-- the auto-retry hooks can re-fire provisioning once the precondition is satisfied.
--
-- APPLY THIS FILE manually (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`
-- (see memory: db-push-disallowed-handwritten-sql). Idempotent — safe to re-run.

-- 1. Reason column (nullable; non-null only while provisioning_status='blocked').
ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS provisioning_blocked_reason text;

-- 2. Make the lifecycle derivation explicit about 'blocked' → 'provisioning'.
--    (The previous ELSE branch already returned 'provisioning', so behaviour is unchanged; this
--    spells it out and keeps the function in sync with the documented provisioning_status values.)
--    Mirrors assistant_lifecycle_from_legacy in db/assistant-lifecycle-status.sql.
CREATE OR REPLACE FUNCTION assistant_lifecycle_from_legacy(ps text, active boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ps = 'cancelled'                       THEN 'archived'
    WHEN ps IN ('paused_payment','paused_limit')THEN 'system_paused'
    WHEN ps IN ('pending','pending_payment','failed','blocked') OR ps IS NULL THEN 'provisioning'
    WHEN ps = 'complete' AND active             THEN 'working'
    WHEN ps = 'complete' AND NOT active         THEN 'paused'
    ELSE 'provisioning'
  END
$$;

-- 3. Re-derive existing rows (no-op for healthy rows; keeps any row consistent with the function).
--    Safe: this only rewrites lifecycle_status from the legacy pair and never clobbers the
--    forward-only 'ready_for_work' state (which has no legacy equivalent and isn't produced here).
UPDATE ai_assistants
   SET lifecycle_status = assistant_lifecycle_from_legacy(provisioning_status, is_active)
 WHERE provisioning_status = 'blocked'
   AND lifecycle_status IS DISTINCT FROM 'provisioning';
