-- db/z-affiliate-partner-terms.sql — Affiliate Partner Programme, step 9: Partner Terms acceptance.
-- Plan: docs/affiliate-partner-programme-plan.md §4.8. Drizzle mirror: db/schema.ts (partners).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partner-terms.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partner-terms.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first (it creates `partners`).
--
-- Which version of the Partner Terms (partner-terms.html, src/config/partner-terms.ts) a partner
-- accepted, and when — on the application form, or on their Partner page (partners an admin added
-- directly, or after a new version). Owner decision 2026-10-19: the customer Terms of Service only
-- point to the Partner Terms (no ToS version bump), so this is the partner's own acceptance record.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP;
