-- db/sequence-halt-company-closed.sql — Buying triggers Phase 2 (docs/buying-triggers-plan.md §5, FR#36):
-- adds 'company_closed' to the follow-up halt reasons. The Watch list (src/utils/lead-watch.ts) stops a
-- lead's follow-ups when Companies House shows the company in liquidation, administration or dissolved.
--
-- ⚠️ NOT ADDITIVE: it drops and re-adds the halt_reason CHECK constraint (same pattern as
-- db/sequence-halt-signed-up.sql), with every earlier reason kept. APPLY MANUALLY as the DB owner on BOTH
-- environments. Until it runs, the Watch list still stops the follow-ups, recorded as 'manual' with the
-- detail "Companies House shows the company closing" (lead-watch-effects.ts falls back), so nothing keeps
-- sending in the meantime.
--
-- Run as ONE statement (the DO block) in the Neon SQL Editor.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrolments_halt_reason_check') THEN
    ALTER TABLE sequence_enrolments DROP CONSTRAINT sequence_enrolments_halt_reason_check;
  END IF;
  ALTER TABLE sequence_enrolments ADD CONSTRAINT sequence_enrolments_halt_reason_check
    CHECK (halt_reason IS NULL OR halt_reason IN (
      'replied','suppressed','no_recipient','not_connected','send_failed',
      'max_steps','record_closed','do_not_contact','manual','signed_up','company_closed'));
END $$;
