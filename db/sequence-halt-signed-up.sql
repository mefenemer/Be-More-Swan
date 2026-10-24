-- db/sequence-halt-signed-up.sql
-- Adds 'signed_up' to the sequence_enrolments halt_reason vocabulary (src/config/outreach-sequences.ts).
--
-- A prospect who signs up through a Lead Generator's outreach offer link has said yes, so their
-- follow-ups stop (src/utils/outreach-offer.ts creditOfferSignup → haltEnrolment(…, 'signed_up')).
-- Same shape as db/sequence-halt-do-not-contact.sql, and for the same reason: the constraint in
-- db/outreach-sequences.sql is only created when absent, so re-running that file never widens it.
--
-- APPLY BEFORE (or with) THE CODE. Until it is applied, that halt UPDATE is refused by the CHECK and
-- caught: the sign-up and its credit to the lead still happen, but the chasers keep going. Staging
-- first, then prod:
--   npm run db:migrate:apply -- --only sequence-halt-signed-up.sql
--   npm run db:migrate:apply -- --only sequence-halt-signed-up.sql --url-var DATABASE_URL_PROD
--
-- Idempotent: nothing depends on this CHECK constraint, so dropping and re-adding it re-runs cleanly.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrolments_halt_reason_check') THEN
    ALTER TABLE sequence_enrolments DROP CONSTRAINT sequence_enrolments_halt_reason_check;
  END IF;
  ALTER TABLE sequence_enrolments ADD CONSTRAINT sequence_enrolments_halt_reason_check
    CHECK (halt_reason IS NULL OR halt_reason IN (
      'replied','suppressed','no_recipient','not_connected','send_failed',
      'max_steps','record_closed','do_not_contact','manual','signed_up'));
END $$;

-- Verify (expect the list above, including signed_up):
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'sequence_enrolments_halt_reason_check';
