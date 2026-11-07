-- db/z-product-price-currency.sql — a product's price can be in pounds, dollars or euros, not only
-- pounds. src/utils/product-price.ts (PRICE_CURRENCIES), netlify/functions/org-products.ts.
-- Drizzle mirror: db/schema.ts (orgProducts.priceCurrency).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys (org-products.ts
-- selects the column). Idempotent.
--   npm run db:migrate:apply -- --only z-product-price-currency.sql                              (staging)
--   npm run db:migrate:apply -- --only z-product-price-currency.sql --url-var DATABASE_URL_PROD  (prod)
--
-- price_currency  ISO 4217 of price_amount (minor units: pence / cents). Every existing row is GBP,
--                 which is what it always meant. A fixed price in any of these can be bought online
--                 (Stripe charges in it); deposits are taken in GBP only for now.

BEGIN;

ALTER TABLE org_products ADD COLUMN IF NOT EXISTS price_currency TEXT NOT NULL DEFAULT 'GBP';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_products_price_currency_check') THEN
    ALTER TABLE org_products ADD CONSTRAINT org_products_price_currency_check
      CHECK (price_currency IN ('GBP', 'USD', 'EUR', 'AUD', 'CAD'));
  END IF;
END $$;

COMMIT;
