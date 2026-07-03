-- Migration: Dynamic Product Catalog & Subscription Engine — master_plans Stripe product id + features.
-- Applied manually (like db/gamification.sql) rather than via `drizzle-kit push`, which would also try to
-- DISABLE RLS on ai_assistants (RLS lives in db/rls/). Idempotent: safe to re-run.

ALTER TABLE master_plans ADD COLUMN IF NOT EXISTS stripe_product_id text;
ALTER TABLE master_plans ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

-- plan_prices already has stripe_price_id + is_active — no change needed.
