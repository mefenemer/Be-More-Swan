-- db/z-business-mentor-plan-feature.sql — "Business Mentor" on the pricing page (docs/business-mentor-plan.md §8.6).
--
-- The Mentor went live for every workspace on 2026-10-26 (flag business_mentor, 100%). This adds its row to
-- the pricing.html comparison table, FIRST in "Core Features — included on every plan", and sets the value
-- on every plan, so the table shows a tick in each column. db/seed-plan-features.ts carries the same row, so
-- a re-seed keeps it.
--
-- The wording is only what the code does (the plan's competitor check, §8.6): included on every plan, takes
-- no assistant place (assistant-capacity.ts WORKSPACE_ROLE_KEYS), suggestions only happen when approved.
--
-- Idempotent. Paste into the Neon SQL Editor, staging then prod. Expect 1 row from each RETURNING.

BEGIN;

INSERT INTO plan_features (key, label, description, category, value_type, storage_target,
                           enterprise_value, display_order, is_enabled)
VALUES (
  'business_mentor',
  'Business Mentor',
  'A business coach that sees what your team does and suggests changes you approve. Takes no assistant place',
  'Core Features — included on every plan', 'boolean', 'feature', 'true',
  (SELECT COALESCE(MIN(display_order), 1) - 1 FROM plan_features WHERE category = 'Core Features — included on every plan'),
  true
)
ON CONFLICT (key) DO UPDATE SET
  label            = EXCLUDED.label,
  description      = EXCLUDED.description,
  category         = EXCLUDED.category,
  value_type       = EXCLUDED.value_type,
  storage_target   = EXCLUDED.storage_target,
  enterprise_value = EXCLUDED.enterprise_value,
  is_enabled       = true,
  updated_at       = now()
RETURNING key, label, display_order;

-- Every plan has the Mentor, the trial included.
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || '{"business_mentor": true}'::jsonb
WHERE NOT COALESCE((features ->> 'business_mentor')::boolean, false)
RETURNING tier_key, features ->> 'business_mentor' AS business_mentor;

COMMIT;
