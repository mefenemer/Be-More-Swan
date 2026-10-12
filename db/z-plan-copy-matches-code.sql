-- db/z-plan-copy-matches-code.sql
-- 2026-10-12: the pricing comparison table (plan_features + master_plans.features) brought into
-- line with what the code actually does. Idempotent: every statement is guarded on the old value.
--   • Advanced Reporting / Custom Reporting — every plan sees the same dashboard (roi-stats has no
--     tier gate) and no custom reporting exists → rows off.
--   • Early Access to New Roles — earned by completed tasks on ANY plan (hire-assistant.ts), not
--     sold by tier → row off.
--   • Roadmap voting — nothing gates it → ticked on every plan.
--   • Basic Reporting described the never-scheduled weekly-digest as a "monthly summary" → now names
--     the in-app Time-Saved Dashboard.
--   • "Guarantee" and "legally compliant" dropped: the benchmark is a prompt rule, not an output filter.
--   • Busywork Buster support said "Chat"; there is no chat support channel.

UPDATE plan_features SET is_enabled = false, updated_at = now()
WHERE key IN ('advanced_reporting', 'custom_reporting', 'early_access_roles') AND is_enabled = true;

UPDATE plan_features
SET label = 'Time-Saved Dashboard',
    description = 'See what your assistants completed and the hours they saved you',
    updated_at = now()
WHERE key = 'basic_reporting' AND label <> 'Time-Saved Dashboard';

UPDATE plan_features SET label = 'Brand Protection', updated_at = now()
WHERE key = 'brand_protection' AND label = 'Brand Protection Guarantee';

UPDATE plan_features
SET description = 'Brand-safety rules placed ahead of your own instructions in every assistant', updated_at = now()
WHERE key = 'safe_content_benchmark' AND description ILIKE '%legally compliant%';

UPDATE master_plans
SET features = jsonb_set(features, '{roadmap_voting}', 'true'::jsonb)
WHERE tier_key IN ('saver', 'buster', 'employee', 'beta')
  AND COALESCE(features ->> 'roadmap_voting', 'false') <> 'true';

UPDATE master_plans
SET features = jsonb_set(features, '{support_channel}', '"Priority Email"'::jsonb)
WHERE tier_key = 'buster' AND features ->> 'support_channel' = 'Priority Email & Chat';

-- Plan-card blurb (DB-driven, master_plans.description).
UPDATE master_plans
SET description = 'Scale your business with autonomous goal tracking, an in-house editor, and your own mini digital department.'
WHERE tier_key = 'buster' AND description ILIKE '%advanced analytics%';
