-- db/lead-outreach-unsubscribe.sql
-- Gives a prospect a LINK to unsubscribe from tenant→prospect cold outreach, instead of only the
-- ability to type "unsubscribe" in a reply and hope the detector catches it.
--
-- Background: send_outreach (netlify/functions/lead-generation.ts) and the follow-up cadence
-- (process-sequence-sends.ts) sent the drafted body verbatim — no footer, no List-Unsubscribe
-- header, no sender postal address. The only opt-out route was src/config/opt-out.ts matching the
-- words in a reply. Everything DOWNSTREAM of an opt-out (lead_opt_outs, checkSuppression, halting
-- the cadence) already worked; this adds the front door.
--
-- ⚠️ NOT the win-back opt-out (win_back_opt_outs) — that is Be More Swan's OWN marketing to its
-- OWN users and has had a working unsubscribe link all along. These are the tenant's prospects.
--
-- Idempotent. Apply to staging first, then prod. Safe to run BEFORE the code ships: the new column
-- is nullable and the widened CHECK only permits a value nothing writes yet.

-- ── 1. Allow source='link' on lead_opt_outs ─────────────────────────────────────────────────────
-- ⚠️ This CANNOT be an `IF NOT EXISTS` add. lead_opt_outs_source_check ALREADY EXISTS with the
-- narrower vocabulary ('reply','manual','bounce'), so a guarded ADD is a silent no-op and the
-- constraint stays narrow — the exact trap that made halt_reason look deployed when it was not.
-- The insert would then raise a check violation, the opt-out would go unrecorded, and the prospect
-- would keep being emailed. DROP then ADD.
-- Guarded on the TABLE existing too: db/lead-opt-outs.sql is a separate migration, and on an
-- environment that never received it the bare ALTER below would abort the whole script — taking
-- the unrelated organisations/push changes down with it.
DO $$
BEGIN
  IF to_regclass('public.lead_opt_outs') IS NULL THEN
    RAISE NOTICE 'lead_opt_outs does not exist — apply db/lead-opt-outs.sql first, then re-run this.';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_opt_outs_source_check') THEN
    ALTER TABLE lead_opt_outs DROP CONSTRAINT lead_opt_outs_source_check;
  END IF;
  ALTER TABLE lead_opt_outs ADD CONSTRAINT lead_opt_outs_source_check
    CHECK (source IN ('reply','manual','bounce','link'));
END $$;

-- ── 2. The sender's postal address ──────────────────────────────────────────────────────────────
-- CAN-SPAM and CASL both require a valid physical postal address in every commercial email; the
-- footer renders this line when it is set.
--
-- ⚠️ Deliberately a NEW per-ORG column rather than reusing billing_information. That table is
-- per-USER and holds the card-holder's billing address — frequently a home address. Publishing it
-- to every cold prospect the org contacts would be a privacy incident, not a compliance win.
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS outreach_postal_address text;

-- Verify:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'lead_opt_outs_source_check';
--   -- expect: CHECK ((source = ANY (ARRAY['reply','manual','bounce','link'])))
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'organisations' AND column_name = 'outreach_postal_address';
