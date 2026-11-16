-- db/z-shop-settings.sql — online shop Phase 0 (feature request #35, docs/online-shop-review-plan.md §6).
-- Code: src/utils/shop-settings.ts, src/utils/site-shop.ts, netlify/functions/stripe-connect-webhook.ts.
-- Drizzle mirror: db/schema.ts (shopSettings, siteOrders).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-shop-settings.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shop-settings.sql --url-var DATABASE_URL_PROD  (prod)
-- Readers: shop-settings.ts (loadShopSettings, wrapped — a missing table reads as "not set up", which
-- hides Buy buttons rather than throwing on a live site) and recordPaidCheckout (new columns).
-- ⚠️ APPLY BEFORE DEPLOYING: recordPaidCheckout (site-shop.ts) INSERTS payment_intent_id — without
-- the column every paid order's webhook 500s (Stripe retries for up to 3 days, so nothing is lost if
-- the SQL follows quickly, but the owner and buyer emails wait until it does).
--
-- ── shop_settings ──────────────────────────────────────────────────────────
-- One row per workspace: what UK consumer law needs a buyer to see before and after paying
-- (Consumer Contracts Regulations 2013: trader name, geographic address, contact details, delivery
-- arrangements, the 14-day right to cancel and who pays return postage). The Delivery & returns page
-- and the buyer's confirmation email are drawn from it. A site shows Buy buttons only once the
-- required fields are filled in (shopReady in shop-settings.ts).
--
-- ── site_orders: refunds ───────────────────────────────────────────────────
-- payment_intent_id ties a Stripe refund (charge.refunded on the Connect webhook) back to its order.
-- refunded_amount is in minor units; status becomes 'refunded' only when the whole amount is.

BEGIN;

CREATE TABLE IF NOT EXISTS shop_settings (
    id                  SERIAL PRIMARY KEY,
    organisation_id     INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    trader_name         TEXT,
    trader_address      TEXT,
    contact_email       TEXT,
    contact_phone       TEXT,
    vat_number          TEXT,
    delivery_text       TEXT,
    returns_days        INTEGER NOT NULL DEFAULT 14 CHECK (returns_days BETWEEN 14 AND 365),
    return_postage      TEXT NOT NULL DEFAULT 'buyer' CHECK (return_postage IN ('buyer', 'seller')),
    exceptions          JSONB NOT NULL DEFAULT '[]'::jsonb,
    extra_terms         TEXT,
    updated_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT now(),
    updated_at          TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shop_settings_org_uq ON shop_settings (organisation_id);

ALTER TABLE site_orders ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;
ALTER TABLE site_orders ADD COLUMN IF NOT EXISTS refunded_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_orders ADD COLUMN IF NOT EXISTS buyer_emailed_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS site_orders_pi_idx ON site_orders (payment_intent_id);

ALTER TABLE site_orders DROP CONSTRAINT IF EXISTS site_orders_status_check;
ALTER TABLE site_orders ADD CONSTRAINT site_orders_status_check CHECK (status IN ('paid', 'done', 'refunded'));

COMMIT;
