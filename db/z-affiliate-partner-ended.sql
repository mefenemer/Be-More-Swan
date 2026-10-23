-- db/z-affiliate-partner-ended.sql — Affiliate Partner Programme: an 'ended' partner status.
-- Plan: docs/affiliate-partner-programme-plan.md. Drizzle mirror: db/schema.ts (partners.status).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-affiliate-partner-ended.sql                              (staging)
--   npm run db:migrate:apply -- --only z-affiliate-partner-ended.sql --url-var DATABASE_URL_PROD  (prod)
-- ⚠️ Needs db/z-affiliate-partners.sql first.
--
-- Partner Terms 7.1 (they leave) and 7.2 (we end it) had nothing to record them but 'suspended',
-- which reads as "paused, may come back" (legal review 2026-10-23). 'ended': earns nothing on new
-- payments, keeps — and is still paid — what it earned before (7.3), can be approved again later.
--
-- The status CHECK is replaced in place. Safe to re-run: nothing depends on a CHECK constraint
-- (unlike the unique-key trap in memory migration-drop-then-add-constraint-trap), and it's one
-- transaction, so a failure leaves the old constraint standing.

BEGIN;

ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_status_check;
ALTER TABLE partners ADD CONSTRAINT partners_status_check
    CHECK (status IN ('applied', 'approved', 'rejected', 'suspended', 'ended'));

COMMIT;

-- Check: SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'partners_status_check';
--   → CHECK ((status = ANY (ARRAY['applied'::text, 'approved'::text, 'rejected'::text, 'suspended'::text, 'ended'::text])))
