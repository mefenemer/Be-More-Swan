-- db/z-trial-plan.sql
-- The free 14-day trial, no card (src/utils/trial.ts). Owner decisions 2026-10-17: every new
-- workspace gets it when its owner verifies their email; it is the £79 Busywork Buster's features
-- (every assistant) with a 150-task allowance; at the end, assistants pause and scheduled work is
-- held — nothing is deleted.
--
-- Idempotent; apply as the owner (staging, then prod) BEFORE the code that starts trials deploys.

BEGIN;

CREATE TABLE IF NOT EXISTS trials (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at        TIMESTAMP NOT NULL,
  ends_at           TIMESTAMP NOT NULL,
  reminder_sent_at  TIMESTAMP,
  ended_at          TIMESTAMP,
  converted_at      TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trials_due_idx  ON trials (ends_at);
CREATE INDEX IF NOT EXISTS trials_user_idx ON trials (user_id);

-- The trial plan row: the Busywork Buster's limits and features, with 150 tasks. Copied from the
-- LIVE buster row each run (like db/beta-tester-plan.sql), never sold (is_active false), £0.
UPDATE master_plans t
   SET name                 = 'Free Trial',
       tier_description     = '14-day free trial',
       description          = 'Every assistant for 14 days, no card needed.',
       monthly_price_gbp    = 0,
       assistant_limit      = b.assistant_limit,
       monthly_task_limit   = 150,
       monthly_token_limit  = b.monthly_token_limit,
       app_connection_limit = b.app_connection_limit,
       seat_limit           = b.seat_limit,
       storage_limit_bytes  = b.storage_limit_bytes,
       features             = b.features,
       is_active            = false
  FROM master_plans b
 WHERE t.tier_key = 'trial' AND b.tier_key = 'buster';

-- Assistants paused because their workspace's trial ended carry provisioning_status
-- 'paused_trial_ended'. Same body as db/z-beta-endings.sql plus the new value — without it the
-- lifecycle falls through to 'provisioning' and the workspace shows the assistant as still building.
CREATE OR REPLACE FUNCTION assistant_lifecycle_from_legacy(ps text, active boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN ps = 'cancelled'                                                                                    THEN 'archived'
    WHEN ps IN ('paused_payment','paused_limit','paused_quota','paused_beta_ended','paused_trial_ended')   THEN 'system_paused'
    WHEN ps IN ('pending','pending_payment','failed','blocked') OR ps IS NULL                                THEN 'provisioning'
    WHEN ps = 'complete' AND active                                                                          THEN 'working'
    WHEN ps = 'complete' AND NOT active                                                                      THEN 'paused'
    ELSE 'provisioning'
  END
$$;

COMMIT;
