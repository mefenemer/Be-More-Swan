-- db/z-shop-waitlist.sql
-- "Tell me when it's back" (online shop Phase 2, slice 6; feature request #35, docs/online-shop-review-plan.md §12,
-- owner Q4 2026-11-26: ask first). Code: src/utils/shop-waitlist.ts (the only reader and writer), src/utils/site-shop.ts
-- (the product page's form posts to /_buy with _a=notify), netlify/functions/shop.ts (stock saves ask, "Email them"),
-- src/utils/team-messages.ts (the Team Chat question's answer).
--
-- APPLY MANUALLY, staging first, then prod on the owner's word. Additive and idempotent.
--   node -r dotenv/config scripts/db-migrate.mjs apply --only z-shop-waitlist.sql --execute --yes                               (staging)
--   node -r dotenv/config scripts/db-migrate.mjs apply --only z-shop-waitlist.sql --url-var DATABASE_URL_PROD --execute --yes  (prod)
--
-- Before it runs: sold-out product pages show no box and nothing is asked; everything else works as before.
--
-- One row per person waiting for one product. A service email they asked for (not marketing): it never adds them to
-- the Audience. notified_at = the one email went (or was skipped: skip_reason). Waiting rows are kept a year,
-- notified rows 90 days (the daily sweep, purge-archived-assistants.ts).

CREATE TABLE IF NOT EXISTS shop_waitlist (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    site_id          INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    product_id       INTEGER NOT NULL REFERENCES org_products(id) ON DELETE CASCADE,
    email            TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    notified_at      TIMESTAMP,
    skip_reason      TEXT
);
-- One waiting row per person per product (asking twice is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS shop_waitlist_waiting_uidx ON shop_waitlist (product_id, lower(email)) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS shop_waitlist_org_product_idx ON shop_waitlist (organisation_id, product_id) WHERE notified_at IS NULL;
