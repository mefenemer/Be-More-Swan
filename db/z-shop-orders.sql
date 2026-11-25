-- db/z-shop-orders.sql — online shop Phase 1, order statuses (feature request #35, docs/online-shop-review-plan.md §6).
-- Code: src/utils/shop-orders.ts (the only reader and writer of these columns), netlify/functions/shop.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Additive and idempotent.
--   npm run db:migrate:apply -- --only z-shop-orders.sql                              (staging)
--   npm run db:migrate:apply -- --only z-shop-orders.sql --url-var DATABASE_URL_PROD  (prod)
--
-- NOT in db/schema.ts on purpose: site-shop.ts selects whole order rows, so a Drizzle column would break them on
-- a database this hasn't reached. shop-orders.ts reads and writes them with raw SQL; before this file, "Mark as
-- posted" answers that it isn't switched on yet and every other status works as before.
--
-- site_orders.status              adds 'posted' (paid = New → posted → done; refunded from Stripe)
-- site_orders.posted_at           when it was first marked as posted ("Mark as new" goes back to posted while set)
-- site_orders.tracking_number / tracking_url   what the buyer was sent
-- site_orders.buyer_posted_emailed_at          when the "on its way" email went from the owner's own inbox

BEGIN;

ALTER TABLE site_orders
    ADD COLUMN IF NOT EXISTS posted_at               TIMESTAMP,
    ADD COLUMN IF NOT EXISTS tracking_number         TEXT CHECK (tracking_number IS NULL OR length(tracking_number) <= 60),
    ADD COLUMN IF NOT EXISTS tracking_url            TEXT CHECK (tracking_url IS NULL OR length(tracking_url) <= 500),
    ADD COLUMN IF NOT EXISTS buyer_posted_emailed_at TIMESTAMP;

ALTER TABLE site_orders DROP CONSTRAINT IF EXISTS site_orders_status_check;
ALTER TABLE site_orders ADD CONSTRAINT site_orders_status_check CHECK (status IN ('paid', 'posted', 'done', 'refunded'));

COMMIT;
