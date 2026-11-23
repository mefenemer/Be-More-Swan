-- db/z-partner-actual-costs.sql — Partner commission after ACTUAL costs (docs/partner-actual-costs-plan.md; owner
-- decisions 2026-11-23: the higher of 20% or that customer's actual monthly costs incl. card fees; shortfall carried
-- forward; annual plans as 12 monthly slices; USD costs at the ECB daily rate).
-- Drizzle mirror: db/schema.ts (partner_commissions, partner_referrals, fx_rates).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent, additive.
--   npm run db:migrate:apply -- --only z-partner-actual-costs.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-actual-costs.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first.
--
-- partner_commissions.cost_deduction_bps keeps its meaning as the MINIMUM deduction (20%). The new columns record the
-- month-end true-up so every commission can be checked: the service month, the measured costs, the card fee, which
-- deduction applied, and the shortfall carried in and out. costs_checked_at NULL = still provisional (not releasable).

ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS service_period_start timestamp;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS service_period_end   timestamp;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS cost_pence           integer;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS card_fee_pence       integer;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS deduction_pence      integer;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS deduction_basis      text;      -- 'minimum' | 'actual'
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS carry_in_pence       integer;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS carry_out_pence      integer;
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS usd_gbp_rate         numeric(12, 6);
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS costs_checked_at     timestamp;

-- The running shortfall for one customer: costs above what they paid, taken off their next months' commission.
ALTER TABLE partner_referrals ADD COLUMN IF NOT EXISTS cost_carry_pence integer NOT NULL DEFAULT 0;

-- Which rule a customer's commission follows, fixed when their terms lock at their first payment (review of #827):
--   'fixed'  — the fixed minimum deduction only, as before (every customer already locked, and any whose partner had not
--              accepted the Partner Terms version with actual costs when they first paid — v1.2 §3.3 / §8.1 promise that
--              the deduction on customers who have already paid never goes up);
--   'actual' — the higher of the minimum or that customer's actual costs, with carry-forward (Terms v1.3+ §3.2).
-- DEFAULT 'fixed' so every existing row keeps exactly what it was promised.
ALTER TABLE partner_referrals ADD COLUMN IF NOT EXISTS cost_basis text NOT NULL DEFAULT 'fixed';

-- The European Central Bank's daily reference rate, saved each day by the nightly partner sweep.
CREATE TABLE IF NOT EXISTS fx_rates (
    day         date PRIMARY KEY,
    usd_gbp     numeric(12, 6) NOT NULL,       -- pounds per US dollar
    source      text NOT NULL DEFAULT 'ECB',
    fetched_at  timestamp NOT NULL DEFAULT now()
);

-- The true-up looks for provisional rows whose month has ended.
CREATE INDEX IF NOT EXISTS partner_commissions_costs_due_idx ON partner_commissions (status, service_period_end) WHERE costs_checked_at IS NULL;

-- Check:
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'partner_commissions'
--      AND column_name IN ('service_period_start','service_period_end','cost_pence','card_fee_pence','deduction_pence',
--                          'deduction_basis','carry_in_pence','carry_out_pence','usd_gbp_rate','costs_checked_at');   → 10 rows
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'partner_referrals' AND column_name = 'cost_carry_pence';
--   SELECT to_regclass('fx_rates');
