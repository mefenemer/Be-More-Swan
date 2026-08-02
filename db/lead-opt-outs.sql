-- db/lead-opt-outs.sql
-- Per-ADDRESS opt-out for tenant→prospect outreach. "Stop emailing me", recorded and enforced.
--
-- WHY NOT suppression_list: that table is DOMAIN-grained with UNIQUE (organisation_id, domain), and
-- is populated by the CRM sync to mean "this COMPANY is already a customer". Writing an individual's
-- opt-out there would suppress everyone at their employer — one person at a 500-seat company saying
-- "unsubscribe" would silently destroy that whole account as a prospect. An opt-out is personal, so
-- it needs address grain and its own table.
--
-- ⚠️ NOT the same as the win-back opt-out table (Be More Swan's OWN marketing to its OWN users).
-- These are the tenant's prospects. Same trap as leads/lead_replies vs lead_threads/lead_messages.
--
-- Deliberately has NO removal path in code. An opt-out is a standing instruction from a person; if
-- one ever needs reversing, that is a considered manual action, not a feature.
--
-- Idempotent. Apply to staging first, then prod. Safe to run before the code ships: nothing reads
-- the table until the deploy, and checkSuppression() treats a missing table as "no opt-outs".

CREATE TABLE IF NOT EXISTS lead_opt_outs (
  id                serial PRIMARY KEY,
  organisation_id   integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- Normalised lowercase. Address grain, NOT domain — see the header.
  email             text NOT NULL,
  reason            text NOT NULL DEFAULT 'reply_opt_out',
  source            text NOT NULL DEFAULT 'reply',
  -- Which conversation it came from. SET NULL rather than CASCADE: deleting a thread must never
  -- delete the evidence that someone asked us to stop.
  lead_thread_id    integer REFERENCES lead_threads(id) ON DELETE SET NULL,
  -- The matched rule and the sentence it matched, so a wrong suppression can be explained to the
  -- tenant rather than looking like an unexplained gap in their pipeline.
  matched_rule      text,
  evidence          text,
  created_at        timestamp NOT NULL DEFAULT now()
);

DO $$
BEGIN
  -- One opt-out per address per tenant. The insert is ON CONFLICT DO NOTHING, so a prospect who
  -- says "unsubscribe" three times produces one row and three ledger events.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_opt_outs_org_email_unique') THEN
    ALTER TABLE lead_opt_outs ADD CONSTRAINT lead_opt_outs_org_email_unique UNIQUE (organisation_id, email);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_opt_outs_source_check') THEN
    ALTER TABLE lead_opt_outs ADD CONSTRAINT lead_opt_outs_source_check
      CHECK (source IN ('reply','manual','bounce'));
  END IF;
END $$;

-- The read path is an exact-address lookup on every send, so this index is load-bearing.
CREATE INDEX IF NOT EXISTS lead_opt_outs_org_email_idx ON lead_opt_outs (organisation_id, email);

-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'lead_opt_outs' ORDER BY ordinal_position;
--   SELECT conname FROM pg_constraint WHERE conrelid = 'lead_opt_outs'::regclass;
