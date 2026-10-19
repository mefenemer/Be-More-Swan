-- db/z-affiliate-partner-codes.sql — Affiliate Partner Programme, step 7: partner codes.
-- Plan: docs/affiliate-partner-programme-plan.md §4.2. Drizzle mirror: db/schema.ts (partners.promo_code).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partner-codes.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partner-codes.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first (it creates `partners`).
--
-- Owner decision 2026-10-18: a partner's memorable code (e.g. SAMSWAN) is a BMS code, NOT a Stripe
-- promotion code. A promotion code is tied to one coupon, and the friend offer needs a different
-- coupon for monthly and annual — a monthly "100% off once" code used on an annual plan would give
-- a free year. So the code resolves to the partner the same way their link does
-- (src/utils/invite-codes.ts) and the customer gets the normal friend offer (referral-offer.ts),
-- with the right coupon for their billing cycle. An admin turns it on per partner; clearing it stops
-- it working at once. The step-1 columns stripe_coupon_id / stripe_promo_code_id stay unused.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS promo_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS partners_promo_code_uq ON partners (upper(promo_code)) WHERE promo_code IS NOT NULL;
