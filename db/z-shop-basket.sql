-- db/z-shop-basket.sql — online shop Phase 1, basket (feature request #35, docs/online-shop-review-plan.md §6).
-- Code: src/utils/shop-basket.ts (the only reader and writer of both tables), src/utils/site-shop.ts
-- (basket checkout, paid order → its lines and stock), netlify/functions/site-serve.ts (/basket, /_buy).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Additive and idempotent.
--   npm run db:migrate:apply -- --only z-shop-basket.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shop-basket.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Read and written with raw SQL: a missing table means "no basket" (sites keep the one-product Buy button),
-- so the code is safe before this runs. db/schema.ts mirrors site_order_lines ONLY for the data export.
--
-- site_baskets: one per buyer, carried in the address (?b=<id>): the sites host passes no cookies. The id is
--   random (24 url-safe characters) and is the only key: there is no list of baskets anywhere public. Items
--   are ids and quantities only; names and prices are always read again from Business Information.
--   checkout_lines is { <Stripe session id>: [lines] }: what each Checkout charged, saved when the buyer pressed
--   it and read back by the webhook to write that order's lines (a later change to the basket never alters an
--   earlier session's). Kept 7 days, then deleted by the daily sweep.
-- site_order_lines: what a paid order contained, one row per product or option (a one-product Buy order has
--   no lines: its site_orders row says it all).

BEGIN;

CREATE TABLE IF NOT EXISTS site_baskets (
    id                   TEXT PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{24}$'),
    site_id              INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    items                JSONB NOT NULL DEFAULT '[]'::jsonb,
    checkout_lines       JSONB,
    checkout_session_id  TEXT,
    created_at           TIMESTAMP NOT NULL DEFAULT now(),
    updated_at           TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_baskets_updated_idx ON site_baskets (updated_at);
CREATE INDEX IF NOT EXISTS site_baskets_org_idx ON site_baskets (organisation_id);

CREATE TABLE IF NOT EXISTS site_order_lines (
    id               SERIAL PRIMARY KEY,
    order_id         INTEGER NOT NULL REFERENCES site_orders(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    product_id       INTEGER,
    option_id        INTEGER,
    item_name        TEXT NOT NULL CHECK (char_length(item_name) BETWEEN 1 AND 160),
    unit_amount      INTEGER NOT NULL CHECK (unit_amount >= 0),
    quantity         INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_order_lines_order_idx ON site_order_lines (order_id);
CREATE INDEX IF NOT EXISTS site_order_lines_org_idx ON site_order_lines (organisation_id);

COMMIT;
