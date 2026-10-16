-- db/ops/task-allowance-cutover.sql
-- ONE-OFF OPERATIONAL SCRIPT — the 1 December 2026 move to a single task allowance
-- (docs/task-metering.md). Not a migration: it lives in db/ops/ so scripts/db-migrate.mjs never
-- picks it up and runs it early. Run it by hand, staging first, at 00:05 UTC on 1 Dec, as the owner.
--
-- Prerequisites (check before running):
--   • db/task-ledger.sql applied (task_ledger, task_bonus, the 'unified_task_metering' flag)
--   • the code that reads the flag is deployed
--   • the advance notice (tasks_model_change_notice) went out ≥ 30 days ago and the updated terms
--     are live
--
-- What it does, in ONE transaction so no org is ever half-converted:
--   1. Converts each org's leftover balances into non-expiring bonus tasks:
--        AI media credits × 4   (a 5-credit video is 20 tasks)
--      + unused PURCHASED X credits × 1  (x_bonus less what November's posting already ate)
--      Held credits (jobs in flight) are NOT converted — those jobs settle in tasks once the flag is
--      on, so converting them too would pay twice.
--   2. Raises the monthly task limits to absorb the media allowance (old + media credits × 4,
--      rounded): saver 500→600, buster 2500→2750, employee 10000→10500, and the beta row.
--      Frozen "new subscribers only" snapshots get the same increase, once.
--   3. Hides the retired pricing-table rows.
--   4. Turns the flag on for everyone.
--
-- Idempotent: the conversion is guarded by task_ledger's one-conversion-per-org unique index, the
-- limit changes only move a value still at its old figure, and snapshots carry a marker. Safe to
-- re-run; a second run changes nothing.
--
-- Step 0 (read-only, run first and keep the output): what will be converted.
--   SELECT b.organisation_id, b.balance AS media_credits, b.held,
--          b.x_bonus, b.x_used, COALESCE((mp.features->>'monthly_x_credits')::int, 0) AS x_allowance
--     FROM ai_credit_balance b
--     LEFT JOIN plans p ON p.organisation_id = b.organisation_id AND p.status IN ('active','past_due')
--     LEFT JOIN master_plans mp ON mp.id = p.master_plan_id
--    ORDER BY b.organisation_id;

BEGIN;

-- ── 1. Balances → bonus tasks ────────────────────────────────────────────────────────────────────
WITH x_allow AS (
    SELECT DISTINCT ON (p.organisation_id) p.organisation_id,
           COALESCE(NULLIF(CASE WHEN p.feature_overrides IS NOT NULL
                                THEN p.feature_overrides -> 'features' ->> 'monthly_x_credits'
                                ELSE mp.features ->> 'monthly_x_credits' END, '')::int, 0) AS allowance
      FROM plans p JOIN master_plans mp ON mp.id = p.master_plan_id
     WHERE p.status IN ('active', 'past_due')
     ORDER BY p.organisation_id, p.status, p.started_at
),
src AS (
    SELECT b.organisation_id,
           GREATEST(b.balance, 0) * 4 AS from_media,
           -- Same settlement ensureXPeriod would do at the month roll: bonus consumed = what was
           -- posted beyond the included allowance in the period x_used belongs to.
           GREATEST(b.x_bonus - GREATEST(b.x_used - COALESCE(a.allowance, 0), 0), 0) AS from_x
      FROM ai_credit_balance b
      LEFT JOIN x_allow a ON a.organisation_id = b.organisation_id
),
conv AS (
    INSERT INTO task_ledger (organisation_id, period_start, kind, units, source, note)
    SELECT organisation_id, date_trunc('month', now() AT TIME ZONE 'UTC'), 'bonus_grant',
           from_media + from_x, 'conversion',
           format('Converted at cutover: %s media credits ×4 + %s purchased X credits', from_media / 4, from_x)
      FROM src
     WHERE from_media + from_x > 0
    ON CONFLICT (organisation_id) WHERE source = 'conversion' DO NOTHING
    RETURNING organisation_id, units
)
INSERT INTO task_bonus (organisation_id, bonus_tasks)
SELECT organisation_id, units FROM conv
ON CONFLICT (organisation_id)
DO UPDATE SET bonus_tasks = task_bonus.bonus_tasks + EXCLUDED.bonus_tasks, updated_at = now();

-- ── 2. New task limits ───────────────────────────────────────────────────────────────────────────
UPDATE master_plans SET monthly_task_limit = 600 WHERE tier_key = 'saver'    AND monthly_task_limit = 500;
UPDATE master_plans SET monthly_task_limit = 2750 WHERE tier_key = 'buster'   AND monthly_task_limit = 2500;
UPDATE master_plans SET monthly_task_limit = 10500 WHERE tier_key = 'employee' AND monthly_task_limit = 10000;
-- Beta was copied from employee once (db/beta-tester-plan.sql) and never follows it.
UPDATE master_plans SET monthly_task_limit = 10500 WHERE tier_key = 'beta'     AND monthly_task_limit = 10000;

-- Frozen snapshots: the same increase per tier, once (marker: taskAllowanceCutover).
UPDATE plans p
   SET feature_overrides = jsonb_set(p.feature_overrides, '{monthlyTaskLimit}',
           to_jsonb((p.feature_overrides ->> 'monthlyTaskLimit')::int
                    + CASE mp.tier_key WHEN 'saver' THEN 100 WHEN 'buster' THEN 250 ELSE 500 END))
           || '{"taskAllowanceCutover": "2026-12-01"}'::jsonb,
       updated_at = now()
  FROM master_plans mp
 WHERE mp.id = p.master_plan_id
   AND mp.tier_key IN ('saver', 'buster', 'employee', 'beta')
   AND p.feature_overrides IS NOT NULL
   AND jsonb_typeof(p.feature_overrides -> 'monthlyTaskLimit') = 'number'
   AND NOT (p.feature_overrides ? 'taskAllowanceCutover');

-- ── 3. Retired pricing-table rows ────────────────────────────────────────────────────────────────
UPDATE plan_features SET is_enabled = false, updated_at = now()
 WHERE key IN ('monthly_ai_credits', 'credits_rollover', 'monthly_x_credits') AND is_enabled;

-- ── 4. Everyone on the single task allowance ────────────────────────────────────────────────────
UPDATE feature_flags SET enabled = true, rollout_percentage = 100, updated_at = now()
 WHERE key = 'unified_task_metering';

COMMIT;

-- Afterwards (read-only): totals should match Step 0.
--   SELECT source, COUNT(*), SUM(units) FROM task_ledger WHERE source = 'conversion' GROUP BY source;
--   SELECT tier_key, monthly_task_limit FROM master_plans ORDER BY monthly_task_limit;
