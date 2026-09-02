-- db/campaign-cost-ceiling.sql — the customer's own cost-per-outcome ceiling.
-- Drizzle mirror: db/schema.ts (campaignBudgets.maxCostPerOutcomeGbp).
--
-- APPLY MANUALLY as the DB owner. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only campaign-cost-ceiling
--
-- ── Why this column has to exist before the rule can ─────────────────────────
-- src/utils/campaign-optimiser.ts has always had a cost-per-outcome rule: pause a variant whose
-- spend-per-conversion exceeds a ceiling. It has never fired, because the cron passes
-- `maxCostPerOutcomeGbp: null` — and null is deliberate, not a placeholder. There was nowhere for
-- a customer to set a ceiling, and the alternative considered (reuse the daily budget) would have
-- been the agent inventing what a lead is worth, which is a commercial judgement it has no
-- standing to make.
--
-- So half the kill switch has been dark since it was written. This column is the whole fix.
--
-- ⚠️ NULLABLE, AND NULL IS THE DEFAULT FOREVER. Null means "no ceiling — never pause on cost",
-- which is the only safe default: any number we picked would be us deciding what a customer's
-- lead is worth, and being wrong in the expensive direction means quietly pausing ads that were
-- working. A ceiling only ever exists because a human typed it.
--
-- ⚠️ Named in GBP to match max_spend_gbp, and stage_paid already refuses non-GBP ad accounts for
-- exactly this reason. Converting would need a rate we do not have.

BEGIN;

ALTER TABLE campaign_budgets
  ADD COLUMN IF NOT EXISTS max_cost_per_outcome_gbp NUMERIC(10,2);

-- A ceiling of zero would pause every variant the moment it recorded a single conversion, which
-- is not a ceiling anyone means to set — it is a typo, and a costly one. Refuse it at the database
-- as well as at the HTTP boundary.
ALTER TABLE campaign_budgets DROP CONSTRAINT IF EXISTS campaign_budgets_cost_ceiling_check;
ALTER TABLE campaign_budgets ADD  CONSTRAINT campaign_budgets_cost_ceiling_check
  CHECK (max_cost_per_outcome_gbp IS NULL OR max_cost_per_outcome_gbp > 0);

COMMIT;

-- RLS: deliberately not enabled here, for the same reason as every other campaign table — the app
-- connects as table OWNER and an owner bypasses RLS, so a policy would read as protection while
-- never evaluating. See the foot of db/campaigns.sql.
