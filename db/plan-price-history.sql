-- Plan Price History — dated audit trail of every subscription price change.
-- Drizzle mirror: db/schema.ts (planPriceHistory). Powers Admin → Master Data → Plans →
-- "Manage Price" (single-source price management) and the scheduled-price activation worker
-- (netlify/functions/activate-scheduled-prices.ts).
--
-- master_plans.monthly_price_gbp + the GBP plan_prices row remain the "current live" values
-- read by checkout (create-plan-checkout-intent.ts) and the plan gate (get-plans.ts). This
-- table records HOW the live price changed over time, with start/end dates, so the Super
-- Admin can see and schedule price changes from one place.
--
-- Status model (one 'active' row per plan+currency at a time):
--   scheduled  — effective_from in the future; not yet applied to the live price/Stripe.
--   active     — currently live; effective_to is null.
--   superseded — a newer price took over; effective_to = the moment it was replaced.
--
-- Scope: GBP only today (currency column present for future multi-currency use).
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS plan_price_history (
  id                       SERIAL PRIMARY KEY,
  master_plan_id           INTEGER NOT NULL REFERENCES master_plans(id) ON DELETE CASCADE,
  currency                 TEXT NOT NULL DEFAULT 'GBP',           -- ISO 4217; GBP is canonical
  monthly_price_major_unit NUMERIC(10,2) NOT NULL,                -- e.g. 29.00
  stripe_price_id          TEXT,                                  -- Stripe price minted for this point; null until active
  effective_from           TIMESTAMP NOT NULL,                    -- when this price becomes / became live
  effective_to             TIMESTAMP,                             -- null = live or still pending; set when superseded
  status                   TEXT NOT NULL DEFAULT 'active',        -- 'scheduled' | 'active' | 'superseded'
  created_by               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_price_history_plan_idx ON plan_price_history(master_plan_id, currency);
CREATE INDEX IF NOT EXISTS plan_price_history_due_idx  ON plan_price_history(status, effective_from);

-- Backfill: seed one 'active' history row per plan from its current live GBP price so every
-- plan starts with a current row to close on its first change. Runs once (WHERE NOT EXISTS).
INSERT INTO plan_price_history
  (master_plan_id, currency, monthly_price_major_unit, stripe_price_id, effective_from, effective_to, status)
SELECT
  mp.id,
  'GBP',
  COALESCE(pp.monthly_price_major_unit, mp.monthly_price_gbp),
  pp.stripe_price_id,
  mp.created_at,
  NULL,
  'active'
FROM master_plans mp
LEFT JOIN plan_prices pp
  ON pp.master_plan_id = mp.id AND pp.currency = 'GBP'
WHERE NOT EXISTS (
  SELECT 1 FROM plan_price_history h
  WHERE h.master_plan_id = mp.id AND h.currency = 'GBP'
);
