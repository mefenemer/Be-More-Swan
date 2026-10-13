-- db/z-billing-coupons.sql — Coupons managed from Admin → Revenue → Coupons, mirrored to Stripe.
-- Code: netlify/functions/admin-coupons.ts. Drizzle mirror: db/schema.ts (billingCoupons).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-billing-coupons                              (staging)
--   npm run db:migrate:apply -- --only z-billing-coupons --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: the Coupons screen cannot list or save until this exists. Checkout does not read it —
-- Stripe stays the authority on whether a code is valid — so nothing customer-facing depends on it.
--
-- One row per coupon + its customer-facing promotion code. Stripe never lets a coupon's discount or
-- duration change after creation, so those columns are written once; name, notes and is_active are
-- the editable fields. A delete deactivates the code and deletes the coupon in Stripe (customers
-- already on it keep their discount — Stripe's rule) and stamps deleted_at here, keeping the record.
-- livemode records which Stripe account the row belongs to: staging runs on test keys, prod on live.

BEGIN;

CREATE TABLE IF NOT EXISTS billing_coupons (
    id                        SERIAL PRIMARY KEY,
    name                      TEXT NOT NULL,
    code                      TEXT NOT NULL,
    notes                     TEXT,
    percent_off               NUMERIC(5, 2),
    amount_off_pence          INTEGER,
    currency                  TEXT NOT NULL DEFAULT 'gbp',
    duration                  TEXT NOT NULL CHECK (duration IN ('once', 'repeating', 'forever')),
    duration_in_months        INTEGER,
    max_redemptions           INTEGER,
    redeem_by                 TIMESTAMP,
    stripe_coupon_id          TEXT NOT NULL,
    stripe_promotion_code_id  TEXT NOT NULL,
    livemode                  BOOLEAN NOT NULL,
    is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
    created_by                INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at                TIMESTAMP NOT NULL DEFAULT now(),
    updated_at                TIMESTAMP NOT NULL DEFAULT now(),
    deleted_at                TIMESTAMP,
    CONSTRAINT billing_coupons_one_discount CHECK ((percent_off IS NULL) <> (amount_off_pence IS NULL)),
    CONSTRAINT billing_coupons_percent_range CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off <= 100)),
    CONSTRAINT billing_coupons_amount_positive CHECK (amount_off_pence IS NULL OR amount_off_pence > 0),
    CONSTRAINT billing_coupons_months CHECK ((duration = 'repeating') = (duration_in_months IS NOT NULL))
);

-- A code is unique among the coupons that still exist in one Stripe account.
CREATE UNIQUE INDEX IF NOT EXISTS billing_coupons_code_live_uniq
    ON billing_coupons (upper(code), livemode) WHERE deleted_at IS NULL;

COMMIT;
