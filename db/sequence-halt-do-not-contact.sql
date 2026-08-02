-- db/sequence-halt-do-not-contact.sql
-- Adds 'do_not_contact' to the sequence_enrolments halt_reason vocabulary.
--
-- WHY A SEPARATE FILE: the constraint in db/outreach-sequences.sql is created under
-- `IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)`, so re-running that file does NOT widen an
-- existing constraint. Any database provisioned before today keeps the old eight-value list.
--
-- APPLY THIS BEFORE DEPLOYING THE CODE THAT WRITES IT. process-sequence-sends.ts halts a cadence
-- with halt_reason = 'do_not_contact' when the lead record is flagged; against the old constraint
-- that UPDATE raises a check violation, which surfaces as a failed send rather than a clean halt —
-- i.e. the enrolment stays active and keeps trying. Staging first, then prod.
--
-- Idempotent: safe to run more than once, and safe to run before the code ships.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrolments_halt_reason_check') THEN
    ALTER TABLE sequence_enrolments DROP CONSTRAINT sequence_enrolments_halt_reason_check;
  END IF;
  ALTER TABLE sequence_enrolments ADD CONSTRAINT sequence_enrolments_halt_reason_check
    CHECK (halt_reason IS NULL OR halt_reason IN (
      'replied','suppressed','no_recipient','not_connected','send_failed',
      'max_steps','record_closed','do_not_contact','manual'));
END $$;

-- Verify (expect the list above, including do_not_contact):
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conname = 'sequence_enrolments_halt_reason_check';
