-- db/x-credit-packs.sql
-- Phase 2: self-serve X credit "booster packs".
--
-- Adds a PERSISTENT purchased-credit pool (x_bonus) on top of the monthly included allowance from
-- db/x-post-credits.sql. Unlike the included allowance (x_used, reset each UTC month), purchased
-- credits do NOT expire — the customer paid for them.
--
-- Accounting is deferred to keep the hot publish path unchanged: within a month, x_used simply
-- counts total X spend and the cap check is `x_used + cost <= monthly_x_credits + x_bonus`. At the
-- monthly reset (ensureXPeriod), the bonus actually consumed last month — max(x_used - allowance, 0)
-- — is subtracted from x_bonus, then x_used resets to 0. See src/utils/ai-credits.ts.
--
-- Manual-apply migration (idempotent). Apply to staging + prod.

-- Persistent purchased X-credit balance (never reset monthly; decremented at period rollover only
-- for the portion actually consumed).
ALTER TABLE ai_credit_balance
  ADD COLUMN IF NOT EXISTS x_bonus INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ai_credit_balance DROP CONSTRAINT IF EXISTS ai_credit_balance_x_bonus_nonneg;
ALTER TABLE ai_credit_balance ADD  CONSTRAINT ai_credit_balance_x_bonus_nonneg CHECK (x_bonus >= 0);

-- Ledger reason for a purchased pack (a positive delta — a grant, not a debit).
ALTER TABLE ai_credit_ledger DROP CONSTRAINT IF EXISTS ai_credit_ledger_reason_check;
ALTER TABLE ai_credit_ledger ADD  CONSTRAINT ai_credit_ledger_reason_check CHECK (reason IN (
  'monthly_grant', 'image_generation', 'video_generation', 'admin_adjustment',
  'x_post_text', 'x_post_link', 'x_credit_purchase'
));
