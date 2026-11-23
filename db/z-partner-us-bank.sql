-- db/z-partner-us-bank.sql — Partners can be paid into a US bank account (owner request 2026-11-23:
-- "Some people may have a US bank account" — Angela, our first partner, is a US LLC).
-- Code: src/utils/partner-payouts.ts (method 'us_bank'), partner-payout-batches.ts (Wise · US bank file).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-us-bank.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-us-bank.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first. Without this, confirming US bank details fails the CHECK.
--
-- Only the method name is stored on the row; the details themselves are in the vault, as for every method.
-- NOT additive: the CHECK is replaced in place (wider), in one transaction (a failure leaves the old one standing).
-- Every existing row already passes the wider rule. Run the check below after applying: if the constraint ever had
-- another name, the DROP does nothing and confirming US bank details would still fail.

BEGIN;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_payout_method_check;
ALTER TABLE partners ADD CONSTRAINT partners_payout_method_check
    CHECK (payout_method IN ('wise', 'paypal', 'bank', 'us_bank'));

COMMIT;

-- Check: SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'partners_payout_method_check';
--   → CHECK ((payout_method = ANY (ARRAY['wise'::text, 'paypal'::text, 'bank'::text, 'us_bank'::text])))
