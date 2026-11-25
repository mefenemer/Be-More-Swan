-- db/z-shop-options.sql — online shop Phase 1, product options (feature request #35, docs/online-shop-review-plan.md §6).
-- Code: src/utils/shop-options.ts (the only reader and writer), src/utils/site-shop.ts (checkout,
-- stock taken when paid), src/utils/site-render.ts (product page), netlify/functions/shop.ts (Shop tab +
-- chat card product_options).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Additive and idempotent.
--   npm run db:migrate:apply -- --only z-shop-options.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shop-options.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Not in db/schema.ts on purpose (like z-shop-stock.sql): shop-options.ts reads it with raw SQL and a
-- missing table reads as "no options", so the code is safe on a database this has not reached.
--
-- One group of choices per product (e.g. "Size": Small / Large). Each option may have its own price
-- (price_amount, minor units of the product's currency; NULL = the product's own price) and its own stock
-- (NULL = not tracked, 0 = sold out). A product with active options is bought by option only.

BEGIN;

CREATE TABLE IF NOT EXISTS product_options (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    product_id       INTEGER NOT NULL REFERENCES org_products(id) ON DELETE CASCADE,
    group_name       TEXT NOT NULL DEFAULT 'Option' CHECK (char_length(group_name) BETWEEN 1 AND 40),
    label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
    price_amount     INTEGER CHECK (price_amount IS NULL OR price_amount BETWEEN 0 AND 100000000),
    stock            INTEGER CHECK (stock IS NULL OR stock BETWEEN 0 AND 100000),
    sort_order       INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_options_product_idx ON product_options (product_id, status, sort_order);
CREATE INDEX IF NOT EXISTS product_options_org_idx ON product_options (organisation_id);

COMMIT;
