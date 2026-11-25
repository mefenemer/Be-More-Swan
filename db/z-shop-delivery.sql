-- db/z-shop-delivery.sql — online shop Phase 1, UK delivery rates (feature request #35, docs/online-shop-review-plan.md §6).
-- Code: src/utils/shop-delivery.ts (the only reader and writer of these columns), src/utils/site-shop.ts
-- (basket checkout offers them on Stripe; the paid order records the choice), netlify/functions/shop.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Additive and idempotent.
--   npm run db:migrate:apply -- --only z-shop-delivery.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shop-delivery.sql --url-var DATABASE_URL_PROD  (prod)
--
-- NOT in db/schema.ts on purpose: shop-settings.ts and site-shop.ts select and insert whole rows of these
-- tables, so a Drizzle column would break them on a database this hasn't reached. shop-delivery.ts reads and
-- writes them with raw SQL; a missing column = no delivery rates (checkout as before).
--
-- shop_settings.delivery   { "zones": { "uk": { "rates": [{ name, price (pence), freeOver (pence|null), days }],
--                                              "collect": { on, note } } } }   — up to 5 choices in all.
-- site_orders.delivery_name / delivery_amount   the choice the buyer made on Stripe, and its cost in pence.

BEGIN;

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS delivery JSONB;

ALTER TABLE site_orders
    ADD COLUMN IF NOT EXISTS delivery_name   TEXT,
    ADD COLUMN IF NOT EXISTS delivery_amount INTEGER CHECK (delivery_amount IS NULL OR delivery_amount >= 0);

COMMIT;
