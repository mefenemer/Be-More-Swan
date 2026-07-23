-- db/x-post-credits.sql
-- Phase 1: metered X (Twitter) posting with a hard, per-month cap.
--
-- Option A — a SEPARATE X budget, kept apart from the image/video AI-credit pool so a link-heavy X
-- month can't starve media generation, and the very different unit economics never get conflated.
--
-- Model: X posts do NOT draw down `balance`. ai_credit_balance carries a per-UTC-month USED counter
-- (x_used) that RESETS on the first X op of a new month (deliberately unlike monthly_ai_credits,
-- which rolls over — a fixed monthly reset keeps per-tier exposure predictable). The ceiling is the
-- active plan's master_plans.features.monthly_x_credits. A text post costs 1 credit; a post
-- containing any URL costs 13 — mirroring X's ~$0.015 vs ~$0.20 per-request pricing.
-- See src/utils/ai-credits.ts (holdXCredits / settleXHold / getXUsage).
--
-- Manual-apply migration (idempotent). Apply to staging + prod.

-- 1) Per-org X usage counter — mirrors the existing autonomous_used / autonomous_period_start sub-cap.
ALTER TABLE ai_credit_balance
  ADD COLUMN IF NOT EXISTS x_used         INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS x_period_start DATE;

ALTER TABLE ai_credit_balance DROP CONSTRAINT IF EXISTS ai_credit_balance_x_used_nonneg;
ALTER TABLE ai_credit_balance ADD  CONSTRAINT ai_credit_balance_x_used_nonneg CHECK (x_used >= 0);

-- 2) Allow the two new ledger reasons for X post debits.
ALTER TABLE ai_credit_ledger DROP CONSTRAINT IF EXISTS ai_credit_ledger_reason_check;
ALTER TABLE ai_credit_ledger ADD  CONSTRAINT ai_credit_ledger_reason_check CHECK (reason IN (
  'monthly_grant', 'image_generation', 'video_generation', 'admin_adjustment',
  'x_post_text', 'x_post_link'
));

-- 3) Per-tier included monthly X allowance. Ordered correctly by PRICE (the tier_key names read
--    backwards): saver = £29 entry, buster = £99 mid, employee = £349 top, trial = none.
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_x_credits', 0)    WHERE tier_key = 'trial';
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_x_credits', 150)  WHERE tier_key = 'saver';
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_x_credits', 500)  WHERE tier_key = 'buster';
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('monthly_x_credits', 1500) WHERE tier_key = 'employee';
