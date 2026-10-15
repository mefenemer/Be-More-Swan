-- db/z-product-pricing.sql — Business Information ▸ Products & Services gets STRUCTURED prices, so a
-- price is recorded ONCE and reused everywhere: assistants' prompts, the Website Assistant's products
-- section, and Stripe checkout. src/utils/product-price.ts, netlify/functions/org-products.ts.
-- Drizzle mirror: db/schema.ts (orgProducts).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-product-pricing.sql                              (staging)
--   npm run db:migrate:apply -- --only z-product-pricing.sql --url-var DATABASE_URL_PROD  (prod)
--
-- price_type     'fixed' (£24) | 'from' (from £450) | 'on_request' | 'text' (their own words) | NULL (no price)
-- price_amount   pence, for fixed / from. Only a FIXED price can be bought online.
-- price_unit     optional words after the price: "per hour", "per month", "per kg"
-- duration_minutes  for services — what bookings will use
-- image_asset_id    a picture from the workspace's media library (content_assets)
--
-- `price` (text) stays: it is now the DISPLAYED wording, written by the server from the fields
-- above (or the owner's own words for 'text'), so every prompt that already reads it is unchanged.
--
-- Backfill: an existing written price is kept as 'text'; the simple shapes "£24", "£24.50",
-- "from £450" are read into an amount so they can be used straight away.

BEGIN;

ALTER TABLE org_products ADD COLUMN IF NOT EXISTS price_type        TEXT;
ALTER TABLE org_products ADD COLUMN IF NOT EXISTS price_amount      INTEGER;
ALTER TABLE org_products ADD COLUMN IF NOT EXISTS price_unit        TEXT;
ALTER TABLE org_products ADD COLUMN IF NOT EXISTS duration_minutes  INTEGER;
ALTER TABLE org_products ADD COLUMN IF NOT EXISTS image_asset_id    INTEGER REFERENCES content_assets(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_products_price_type_check') THEN
    ALTER TABLE org_products ADD CONSTRAINT org_products_price_type_check
      CHECK (price_type IS NULL OR price_type IN ('fixed', 'from', 'on_request', 'text'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_products_price_amount_check') THEN
    ALTER TABLE org_products ADD CONSTRAINT org_products_price_amount_check
      CHECK (price_amount IS NULL OR (price_amount >= 0 AND price_amount <= 100000000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_products_duration_check') THEN
    ALTER TABLE org_products ADD CONSTRAINT org_products_duration_check
      CHECK (duration_minutes IS NULL OR (duration_minutes > 0 AND duration_minutes <= 1440));
  END IF;
END $$;

-- Backfill, only rows not yet classified (a re-run changes nothing).
UPDATE org_products SET price_type = 'fixed',
       price_amount = round(substring(price from '^\s*£\s*([0-9]+(?:\.[0-9]{1,2})?)\s*$')::numeric * 100)
 WHERE price_type IS NULL AND price ~ '^\s*£\s*[0-9]+(\.[0-9]{1,2})?\s*$';
UPDATE org_products SET price_type = 'from',
       price_amount = round(substring(price from '^\s*[Ff]rom\s+£\s*([0-9]+(?:\.[0-9]{1,2})?)\s*$')::numeric * 100)
 WHERE price_type IS NULL AND price ~ '^\s*[Ff]rom\s+£\s*[0-9]+(\.[0-9]{1,2})?\s*$';
UPDATE org_products SET price_type = 'text'
 WHERE price_type IS NULL AND price IS NOT NULL AND btrim(price) <> '';

COMMIT;
