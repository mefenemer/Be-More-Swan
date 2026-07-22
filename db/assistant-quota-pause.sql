-- db/assistant-quota-pause.sql
--
-- Adds 'paused_quota' to the assistant lifecycle derivation.
--
-- Why: task-volume-check.ts pauses assistants when the org exhausts its monthly task allowance.
-- It used to record that by setting is_active = false ONLY. is_active is also the user's own
-- on/off switch, so a quota pause was indistinguishable from "the user turned this off" — which
-- meant nothing could ever safely reverse it in bulk, and assistants stayed dark forever after a
-- single cap hit even though usage_counters rolls over on the 1st.
--
-- The pause is now stamped provisioning_status = 'paused_quota', which resume-quota-paused.ts
-- reverses (and only ever those rows). provisioning_status is a plain text column with no CHECK
-- constraint or enum, so the new value needs no column DDL — but assistant_lifecycle_from_legacy()
-- must learn to map it, or a quota-paused assistant falls through to 'provisioning' and the
-- workspace renders it as still being built.
--
-- Idempotent: CREATE OR REPLACE + a targeted re-derivation. Safe to run more than once.
--
-- Apply manually (this repo does not auto-run db/*.sql):
--   psql "$NETLIFY_DATABASE_URL" -f db/assistant-quota-pause.sql

-- 1. Teach the derivation function about the new status. Mirrors db/assistant-lifecycle-status.sql
--    and db/assistant-provisioning-blocked.sql — keep all three in step if this list changes.
CREATE OR REPLACE FUNCTION assistant_lifecycle_from_legacy(ps text, active boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ps = 'cancelled'                                        THEN 'archived'
    WHEN ps IN ('paused_payment','paused_limit','paused_quota')  THEN 'system_paused'
    WHEN ps IN ('pending','pending_payment','failed') OR ps IS NULL THEN 'provisioning'
    WHEN ps = 'complete' AND active                              THEN 'working'
    WHEN ps = 'complete' AND NOT active                          THEN 'paused'
    ELSE 'provisioning'
  END
$$;

-- 2. Re-derive any rows already carrying the new status. Scoped to 'paused_quota' so this cannot
--    clobber lifecycle_status values that other flows set deliberately.
UPDATE ai_assistants
   SET lifecycle_status = assistant_lifecycle_from_legacy(provisioning_status, is_active)
 WHERE provisioning_status = 'paused_quota'
   AND lifecycle_status IS DISTINCT FROM 'system_paused';

-- 3. Index the marker: resume-quota-paused.ts runs daily and, on almost every run, must cheaply
--    establish that there is nothing to do. Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS ai_assistants_paused_quota_idx
    ON ai_assistants (organisation_id)
 WHERE provisioning_status = 'paused_quota';
