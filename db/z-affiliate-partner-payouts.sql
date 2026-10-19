-- db/z-affiliate-partner-payouts.sql — Affiliate Partner Programme, step 5: payout details.
-- Plan: docs/affiliate-partner-programme-plan.md §4.6. Drizzle mirror: db/schema.ts (partners).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partner-payouts.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partner-payouts.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first (it creates `partners`).
--
-- Where a partner's money goes is what an account thief would change, so a change never applies
-- straight away: it waits as a PENDING change until the partner clicks a link emailed to their
-- account address (src/utils/partner-payouts.ts), and a "your payout details changed" email follows.
--
-- The details themselves live in the secrets VAULT (src/utils/vault.ts — KEK/DEK, rotatable), under
-- aura/partner-<id>/payout and aura/partner-<id>/payout-pending. This table keeps only a MASKED
-- summary to show ("PayPal · j***@example.com"). partners.payout_details_enc from step 1 is NOT used:
-- encryption.ts is deprecated for new data in favour of the vault. Left in place, always NULL.

ALTER TABLE partners ADD COLUMN IF NOT EXISTS payout_display TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payout_pending_method TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payout_pending_display TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payout_pending_token_hash TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS payout_pending_expires_at TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS partners_payout_pending_token_uq
    ON partners (payout_pending_token_hash) WHERE payout_pending_token_hash IS NOT NULL;
