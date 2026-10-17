-- db/ops/retire-digital-employee.sql
-- ONE-OFF OPERATIONAL SCRIPT (17 October 2026) — not a migration; scripts/db-migrate.mjs never runs it.
-- Run by hand as the owner, staging first, AFTER the two-plan pricing page is deployed.
--
-- Owner decision: stop selling The Digital Employee (£349) and give the £79 Busywork Buster every
-- assistant. Nothing else moves between the plans.
--   • employee: is_active = false. get-plans, checkout, billing-upgrade and the admin feature matrix
--     stop offering it. Existing Digital Employee subscribers keep their plan, limits and price:
--     enforcement (resolveTaskLimit, assistant-capacity, check-capacity) never filters on is_active,
--     exactly like the inactive 'beta' plan.
--   • buster: assistant_limit = NULL (unlimited — how every capacity check reads null), and the same
--     for buster subscribers frozen on a "new subscribers only" snapshot, so nobody stays capped at 3.
--
-- Idempotent: re-running changes nothing.

BEGIN;

UPDATE master_plans SET is_active = false WHERE tier_key = 'employee' AND is_active;

UPDATE master_plans SET assistant_limit = NULL WHERE tier_key = 'buster' AND assistant_limit IS NOT NULL;

UPDATE plans p
   SET feature_overrides = jsonb_set(p.feature_overrides, '{assistantLimit}', 'null'::jsonb), updated_at = now()
  FROM master_plans mp
 WHERE mp.id = p.master_plan_id
   AND mp.tier_key = 'buster'
   AND p.feature_overrides IS NOT NULL
   AND jsonb_typeof(p.feature_overrides -> 'assistantLimit') = 'number';

COMMIT;

-- Check (read-only):
--   SELECT tier_key, is_active, assistant_limit FROM master_plans ORDER BY monthly_price_gbp;
