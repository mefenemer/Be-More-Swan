-- db/z-shop-stock.sql — online shop Phase 1, stock (feature request #35, docs/online-shop-review-plan.md §6).
-- Code: src/utils/shop-stock.ts (the only reader and writer), src/utils/site-shop.ts (checkout guard,
-- stock taken when an order is paid), netlify/functions/shop.ts (Shop tab + chat card product_stock).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Additive and idempotent.
--   npm run db:migrate:apply -- --only z-shop-stock.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shop-stock.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Deliberately NOT in db/schema.ts: Drizzle would add the columns to every `select()` of org_products,
-- so code deployed before this SQL would break Business Information. shop-stock.ts reads them with raw
-- SQL and treats a missing column as "stock not tracked" (Buy buttons work exactly as before).
--
-- stock         NULL = not tracked (today's behaviour: always buyable). 0 = Sold out.
-- low_stock_at  NULL = no warning. At or below it, the Shop tab, the owner's order email and the
--               Shopkeeper's chat say stock is low.

BEGIN;

ALTER TABLE org_products
    ADD COLUMN IF NOT EXISTS stock        INTEGER,
    ADD COLUMN IF NOT EXISTS low_stock_at INTEGER;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_products_stock_check') THEN
        ALTER TABLE org_products ADD CONSTRAINT org_products_stock_check
            CHECK ((stock IS NULL OR stock BETWEEN 0 AND 100000) AND (low_stock_at IS NULL OR low_stock_at BETWEEN 0 AND 100000));
    END IF;
END $$;

COMMIT;
