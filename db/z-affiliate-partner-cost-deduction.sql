-- db/z-affiliate-partner-cost-deduction.sql — Affiliate Partner Programme: commission is worked out AFTER COSTS.
-- Plan: docs/affiliate-partner-programme-plan.md §4.1. Drizzle mirror: db/schema.ts (partner* tables).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partner-cost-deduction.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partner-cost-deduction.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first.
--
-- Owner decision 2026-10-22 (Partner Terms 1.1): a fixed percentage is taken off what the customer
-- paid (excluding VAT) for our costs, then the commission rate is applied to what is left.
--   commission = floor(net × (1 − cost deduction) × rate)
-- The deduction belongs to the RATE PERIOD and is locked onto the customer at their first payment
-- with the rate, so changing it later never cuts what a partner earns on a customer who already paid.
--
-- Existing rows keep the meaning they were written with: periods and commissions default to 0%,
-- and terms already locked on a customer are locked at 0%. The one exception is a programme-wide
-- period nobody has been locked to yet — no customer was promised anything under it — which takes
-- the new 20% default.

BEGIN;

ALTER TABLE partner_rate_periods ADD COLUMN IF NOT EXISTS cost_deduction_bps INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
    ALTER TABLE partner_rate_periods ADD CONSTRAINT partner_rate_periods_cost_deduction_bps_check
        CHECK (cost_deduction_bps BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE partner_referrals ADD COLUMN IF NOT EXISTS cost_deduction_bps INTEGER;
DO $$ BEGIN
    ALTER TABLE partner_referrals ADD CONSTRAINT partner_referrals_cost_deduction_bps_check
        CHECK (cost_deduction_bps IS NULL OR cost_deduction_bps BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE partner_referrals SET cost_deduction_bps = 0 WHERE subscribed_at IS NOT NULL AND cost_deduction_bps IS NULL;

ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS cost_deduction_bps INTEGER NOT NULL DEFAULT 0;
DO $$ BEGIN
    ALTER TABLE partner_commissions ADD CONSTRAINT partner_commissions_cost_deduction_bps_check
        CHECK (cost_deduction_bps BETWEEN 0 AND 10000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Programme-wide periods no customer is locked to yet take the 20% default. Runs once: a later
-- re-run finds them already non-zero (or locked to) and leaves them alone.
UPDATE partner_rate_periods rp SET cost_deduction_bps = 2000, updated_at = now()
WHERE rp.partner_id IS NULL
  AND rp.cost_deduction_bps = 0
  AND NOT EXISTS (SELECT 1 FROM partner_referrals pr WHERE pr.rate_period_id = rp.id AND pr.subscribed_at IS NOT NULL);

COMMIT;

-- Check (both should return rows, the second showing 2000 on the open programme period):
-- SELECT column_name, table_name FROM information_schema.columns WHERE column_name = 'cost_deduction_bps';
-- SELECT id, partner_id, rate_bps, cost_deduction_bps, starts_at::text, ends_at::text FROM partner_rate_periods ORDER BY id;
