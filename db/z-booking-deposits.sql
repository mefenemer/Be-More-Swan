-- db/z-booking-deposits.sql — bookings phase 4: deposits (docs/booking-plan.md).
-- Code: src/utils/booking-deposits.ts, product-price.ts (depositFor), org-products.ts, site-booking.ts,
-- site-classes.ts, stripe-connect-webhook.ts. Drizzle mirror: db/schema.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-booking-deposits.sql                              (staging)
--   npm run db:migrate:apply -- --only z-booking-deposits.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── org_products.deposit_type / deposit_amount ─────────────────────────────
-- Per service (or class): 'fixed' = deposit_amount PENCE per booking (per place for a class);
-- 'percent' = deposit_amount % (1–100) of the product's FIXED price. NULL = no deposit — booked as
-- before. Taken only through the workspace's own connected Stripe account (no platform fee); with
-- no account connected, bookings work without one.
--
-- ── bookings ───────────────────────────────────────────────────────────────
-- status 'awaiting_payment': made, holding its time (or places) until hold_expires_at while the
-- customer pays on Stripe Checkout; the Connect webhook turns it into pending / confirmed. An
-- unpaid hold stops counting at hold_expires_at and is tidied to 'cancelled' (payment 'expired').
-- deposit_pence: what was asked. payment_status: unpaid | paid | refunded | refund_failed | expired.
-- Refunds: the customer cancelling online (only possible before the notice cut-off), the owner
-- declining or cancelling, or a cancelled class session — always the full deposit.

BEGIN;

ALTER TABLE org_products ADD COLUMN IF NOT EXISTS deposit_type   TEXT;
ALTER TABLE org_products ADD COLUMN IF NOT EXISTS deposit_amount INTEGER;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'org_products'::regclass AND conname = 'org_products_deposit_check') THEN
        ALTER TABLE org_products ADD CONSTRAINT org_products_deposit_check CHECK (
            deposit_type IS NULL
            OR (deposit_type = 'fixed' AND deposit_amount BETWEEN 30 AND 100000000)
            OR (deposit_type = 'percent' AND deposit_amount BETWEEN 1 AND 100));
    END IF;
END $$;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_pence       INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status      TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checkout_session_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_intent_id   TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at     TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_checkout_session_uq ON bookings (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_payment_status_check') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_payment_status_check CHECK (
            payment_status IS NULL OR payment_status IN ('unpaid', 'paid', 'refunded', 'refund_failed', 'expired'));
    END IF;
    -- Widen the status check to include 'awaiting_payment' (nothing depends on a CHECK; guarded so a
    -- re-run that finds it widened changes nothing).
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'bookings'::regclass AND conname = 'bookings_status_check'
          AND pg_get_constraintdef(oid) LIKE '%awaiting_payment%'
    ) THEN
        ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
        ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('pending', 'confirmed', 'declined', 'cancelled', 'awaiting_payment'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS bookings_awaiting_idx ON bookings (hold_expires_at) WHERE status = 'awaiting_payment';

COMMIT;
