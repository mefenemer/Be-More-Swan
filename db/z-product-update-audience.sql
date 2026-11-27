-- db/z-product-update-audience.sql
-- "Send to" on the weekly What's New email (owner, 2026-11-27): the plan groups the admin ticked
-- when approving — any of 'paying', 'trial', 'beta', 'no_plan'. NULL = everyone (every email sent
-- before this, and any approval with all four ticked). src/utils/product-update-recipients.ts.
--
-- Additive and idempotent. The code works without it for "everyone"; only a narrower choice needs
-- it, and the admin page says so. Apply on staging, then prod.

ALTER TABLE product_update_digests ADD COLUMN IF NOT EXISTS audience TEXT[];

DO $$ BEGIN
  ALTER TABLE product_update_digests ADD CONSTRAINT product_update_digests_audience_check
    CHECK (audience IS NULL OR (cardinality(audience) > 0 AND audience <@ ARRAY['paying','trial','beta','no_plan']::text[]));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
