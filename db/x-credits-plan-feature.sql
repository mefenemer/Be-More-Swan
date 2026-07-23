-- db/x-credits-plan-feature.sql
-- Advertise the monthly X posting allowance in the pricing.html comparison table.
--
-- plan_features is metadata only — the per-plan VALUES already live in master_plans.features
-- .monthly_x_credits (set by db/x-post-credits.sql: saver 150 / buster 500 / employee 1500 / trial 0).
-- This just adds the catalog ROW so the table renders that number per tier. storage_target='feature'
-- tells pricing.html to read the value from master_plans.features by this key.
--
-- display_order sorts it LAST within the 'Capacity' section (dynamic MAX+1, so it slots in cleanly
-- regardless of the existing rows). Idempotent (ON CONFLICT on the unique key).

INSERT INTO plan_features (key, label, description, category, value_type, storage_target,
                           unlimited_label, enterprise_value, display_order, is_enabled)
VALUES (
  'monthly_x_credits',
  'X (Twitter) Posting Credits / Month',
  'Credits for posting to X each month — a text post costs 1 credit, a post with a link costs 13. Buy more any time; purchased credits never expire.',
  'Capacity', 'number', 'feature', 'Custom', 'Custom',
  (SELECT COALESCE(MAX(display_order), 0) + 1 FROM plan_features WHERE category = 'Capacity'),
  true
)
ON CONFLICT (key) DO UPDATE SET
  label            = EXCLUDED.label,
  description      = EXCLUDED.description,
  category         = EXCLUDED.category,
  value_type       = EXCLUDED.value_type,
  storage_target   = EXCLUDED.storage_target,
  unlimited_label  = EXCLUDED.unlimited_label,
  enterprise_value = EXCLUDED.enterprise_value,
  is_enabled       = true,
  updated_at       = now();
