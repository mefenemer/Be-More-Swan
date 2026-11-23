-- db/z-partner-eu-bank.sql — Partners can be paid into a euro bank account by IBAN (owner, 2026-11-23: "Yes, add
-- EUR"). Code: src/utils/partner-payouts.ts (method 'eu_bank'), partner-payout-batches.ts (Wise · EUR bank file).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-partner-eu-bank.sql                              (staging)
--   npm run db:migrate:apply -- --only z-partner-eu-bank.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-partner-us-bank.sql first (it widens the same CHECK; this widens it again).
--
-- NOT additive: the payout_method CHECK is replaced in place (wider), in one transaction. Every existing row already
-- passes it. Run the check below after applying: if the constraint had another name, the DROP would do nothing.

BEGIN;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_payout_method_check;
ALTER TABLE partners ADD CONSTRAINT partners_payout_method_check
    CHECK (payout_method IN ('wise', 'paypal', 'bank', 'us_bank', 'eu_bank'));

COMMIT;

-- Check: SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'partners_payout_method_check';
--   → CHECK ((payout_method = ANY (ARRAY['wise'::text, 'paypal'::text, 'bank'::text, 'us_bank'::text, 'eu_bank'::text])))
