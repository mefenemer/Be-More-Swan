-- db/z-plan-app-connections-no-premium.sql
-- 2026-10-12: The Digital Employee's "App Connection Details" row said it "unlocks Premium Tool
-- integrations like CRM and e-commerce". No integration is marked premium (see
-- z-plan-tool-vault-withdrawn.sql), so every plan can connect the same tools; only the count
-- differs. The live comparison table reads this value from master_plans.features. Idempotent.

UPDATE master_plans
SET features = jsonb_set(features, '{app_connections}',
                         '"Connect up to 15 apps to power your whole digital department"'::jsonb)
WHERE tier_key IN ('employee', 'beta')   -- beta is a copy of employee
  AND features ->> 'app_connections' ILIKE '%Premium Tool%';
