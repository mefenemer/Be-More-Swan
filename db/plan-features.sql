-- Plan Features — DB-driven definition of the pricing.html comparison table.
-- Drizzle mirror: db/schema.ts (planFeatures + plans.feature_overrides). Seed: db/seed-plan-features.ts.
-- Powers Admin → Master Data → Plan Features and the dynamic pricing.html comparison table.
--
-- Storage model (hybrid): this catalog is metadata only. The VALUES stay in master_plans —
-- capacity limits as typed columns (assistant_limit, monthly_task_limit, ...), everything else in
-- the features jsonb. Each catalog row records WHERE its value lives (storage_target / column_name)
-- and HOW to render it (value_type, unlimited_label).
--
-- feature_overrides (on plans): frozen limits/features snapshot for the "new subscribers only" cohort.
-- When set, enforcement (check-capacity, hire/manage/chat gates, ai-credits) reads it instead of the
-- live master_plans values, so an admin can change a plan for NEW subscribers without moving existing
-- ones. null (default) = read live.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS plan_features (
  id              SERIAL PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,                 -- 'assistant_limit', 'monthly_ai_credits', 'ai_video_generation'
  label           TEXT NOT NULL,                        -- pricing-table row title
  description     TEXT,                                 -- pricing-table row sub-caption
  category        TEXT NOT NULL,                        -- section header: 'Capacity' | 'AI Media Generation' | ...
  value_type      TEXT NOT NULL DEFAULT 'boolean',      -- 'number' | 'boolean' | 'text'
  storage_target  TEXT NOT NULL DEFAULT 'feature',      -- 'column' | 'feature'
  column_name     TEXT,                                 -- master_plans column (camelCase) when storage_target='column'
  unlimited_label TEXT,                                 -- how to render null, e.g. 'Custom' | 'Unlimited'
  enterprise_value TEXT,                                -- display value for the contact-sales "Custom Enterprise" column
  display_order   INTEGER NOT NULL DEFAULT 0,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,        -- false = globally disabled (hidden from pricing, treated as off)
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_features_order_idx ON plan_features(category, display_order);

-- Frozen per-subscription snapshot for the "new subscribers only" cohort.
ALTER TABLE plans ADD COLUMN IF NOT EXISTS feature_overrides JSONB;
