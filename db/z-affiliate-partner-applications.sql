-- db/z-affiliate-partner-applications.sql — Affiliate Partner Programme, step 4: applying without an account.
-- Plan: docs/affiliate-partner-programme-plan.md §4.6. Drizzle mirror: db/schema.ts (partners).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partner-applications.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partner-applications.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first (it creates `partners`).
--
-- Owner decision 2026-10-18: someone without a Be More Swan account applies on /partners WITHOUT
-- creating one (sign-ups may be locked, and a rejected applicant should never get an account). An
-- admin approves in Admin → Revenue → Partners; approval emails a private link to create their
-- partner account, which works even while sign-ups are locked. An applicant whose email already
-- belongs to an account is linked to it (user_id) straight away.
--
-- The link's token is stored HASHED (sha256), like a password reset: a database read never yields a
-- working sign-up link.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS applicant_name TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS applicant_email TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMP;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS invited_at TIMESTAMP;

-- One application per email address.
CREATE UNIQUE INDEX IF NOT EXISTS partners_applicant_email_uq ON partners (lower(applicant_email)) WHERE applicant_email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS partners_invite_token_uq ON partners (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
