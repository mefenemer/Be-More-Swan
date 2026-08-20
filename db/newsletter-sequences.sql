-- db/newsletter-sequences.sql
-- The welcome sequence: what a new subscriber hears in the days after they confirm.
-- Requires db/audience.sql, db/newsletter.sql and db/newsletter-dispatch.sql.
--
-- ── The gap this closes ─────────────────────────────────────────────────────────────────────────
-- The moment of maximum interest is the moment someone presses "confirm my subscription", and until
-- now they heard nothing until the next issue happened — which on a monthly cadence is up to four
-- weeks after they raised their hand. Every comparable tool (Kit, Mailchimp, Beehiiv) treats the
-- welcome series as the centre of the product for exactly this reason.
--
-- ── ⚠️ WHY NOT REUSE outreach_sequences ─────────────────────────────────────────────────────────
-- It was the obvious candidate and it does not fit. `sequence_enrolments.lead_thread_id` is NOT NULL
-- and references lead_threads — it is the HALT KEY, re-read inside the claiming transaction so a
-- follow-up can never land after a prospect replied. An audience contact has no thread. Reusing
-- that table would mean either making the halt key nullable (weakening the guarantee the outreach
-- worker depends on) or minting fake threads for subscribers, and both are worse than a second,
-- simpler table for a genuinely different job.
--
-- ── ⚠️ WHY THE STEPS CARRY A FIXED BODY, unlike outreach's body_prompt ──────────────────────────
-- Outreach drafts per send so a follow-up can reference that conversation. A welcome sequence goes
-- to people who have never spoken to the business, is written once, and is reviewed once — drafting
-- it per send would mean unreviewed copy reaching strangers on a schedule with nobody watching.
-- The assistant writes the steps; a human approves them; then they are FIXED. That is the whole
-- difference between an assistant and an unattended mail generator.
--
-- Idempotent. Apply to staging first, then prod, as the DB owner.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audience_contacts') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-sequences.sql requires db/audience.sql and db/newsletter.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience  (then --only newsletter, then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS newsletter_sequences (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assistant_id      INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,
  name              TEXT NOT NULL DEFAULT 'Welcome sequence',
  -- What puts somebody in it. One value today; the column exists so a second trigger is a row and
  -- not a migration.
  trigger_event     TEXT NOT NULL DEFAULT 'subscribed',
  -- ⚠️ OFF until a human turns it on. A sequence that started sending the moment its steps were
  -- drafted would send unreviewed copy to real subscribers — the same rule as an issue needing
  -- approval before it goes.
  is_enabled        BOOLEAN NOT NULL DEFAULT false,
  enabled_at        TIMESTAMP,
  enabled_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS newsletter_sequence_steps (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sequence_id       INTEGER NOT NULL REFERENCES newsletter_sequences(id) ON DELETE CASCADE,
  step_number       INTEGER NOT NULL,
  -- Counted from the PREVIOUS step, not from enrolment — so inserting a step in the middle shifts
  -- what follows rather than silently bunching two emails onto the same day.
  delay_days        INTEGER NOT NULL DEFAULT 0,
  subject           TEXT NOT NULL,
  preheader         TEXT,
  body_markdown     TEXT NOT NULL DEFAULT '',
  -- Snapshot of the rendered email, exactly like newsletter_issues.rendered_payload and for the
  -- same reason: an edit made after somebody was enrolled must not change what they receive
  -- mid-sequence. Rebuilt when the step is saved.
  rendered_payload  JSONB,
  is_enabled        BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS newsletter_sequence_enrolments (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sequence_id       INTEGER NOT NULL REFERENCES newsletter_sequences(id) ON DELETE CASCADE,
  contact_id        INTEGER NOT NULL REFERENCES audience_contacts(id) ON DELETE CASCADE,
  -- Kept alongside the id so a halt can be recorded even if the contact row is later erased.
  email             TEXT NOT NULL,
  -- ⚠️ THE UNSUBSCRIBE CREDENTIAL, minted once per enrolment and stable for the whole series.
  -- A welcome step has no newsletter_sends row to hang a token on, and every footer needs a
  -- working link — an unsubscribe that answers "we couldn't find that subscription" reads as a
  -- company refusing to let you leave, which is worse than not offering the link at all.
  -- newsletter-unsubscribe.ts resolves newsletter_sends FIRST, then this.
  unsubscribe_token TEXT,
  state             TEXT NOT NULL DEFAULT 'active',
  halt_reason       TEXT,
  last_step_sent    INTEGER NOT NULL DEFAULT 0,
  -- The worker's claim key.
  next_send_at      TIMESTAMP,
  last_error        TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sequences_trigger_check') THEN
    ALTER TABLE newsletter_sequences ADD CONSTRAINT newsletter_sequences_trigger_check
      CHECK (trigger_event IN ('subscribed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sequence_steps_number_check') THEN
    ALTER TABLE newsletter_sequence_steps ADD CONSTRAINT newsletter_sequence_steps_number_check
      CHECK (step_number > 0 AND delay_days >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sequence_enrolments_state_check') THEN
    ALTER TABLE newsletter_sequence_enrolments ADD CONSTRAINT newsletter_sequence_enrolments_state_check
      CHECK (state IN ('active','completed','halted'));
  END IF;
  -- Closed vocabulary. "Why do welcome sequences stop early?" has to be a GROUP BY, not prose —
  -- same rule as the outreach halt reasons.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sequence_enrolments_halt_check') THEN
    ALTER TABLE newsletter_sequence_enrolments ADD CONSTRAINT newsletter_sequence_enrolments_halt_check
      CHECK (halt_reason IS NULL OR halt_reason IN (
        'unsubscribed','bounced','complained','suppressed','consent_check_failed',
        'no_route','send_failed','sequence_disabled','no_steps','manual'));
  END IF;
END $$;

-- ⚠️ ONE SEQUENCE PER ORG PER TRIGGER. Every resolver — the API, and enrolInWelcomeSequence — reads
-- it as `WHERE organisation_id = ? AND trigger_event = ? LIMIT 1` with no ordering, so a second row
-- is not a visible duplicate: it is a coin toss over which sequence the tenant's steps attach to and
-- which one new subscribers are enrolled in. The API refuses to create a second; this is what makes
-- that true under a double-click or a retried request.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_org_trigger_uidx
  ON newsletter_sequences (organisation_id, trigger_event);

-- One sequence per assistant per trigger, for the same reason.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_assistant_trigger_uidx
  ON newsletter_sequences (assistant_id, trigger_event) WHERE assistant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequence_steps_seq_step_uidx
  ON newsletter_sequence_steps (sequence_id, step_number);

-- ⚠️ ONE ENROLMENT PER CONTACT PER SEQUENCE, ever. Without this, somebody who unsubscribes and
-- later re-subscribes starts the welcome series again — which reads to them as a company that has
-- forgotten it already met them, and to us as a way to mail somebody the same three emails twice.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequence_enrolments_contact_uidx
  ON newsletter_sequence_enrolments (sequence_id, contact_id);

-- The unsubscribe endpoint's lookup. Partial: only rows that have a token are ever resolved.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequence_enrolments_token_uidx
  ON newsletter_sequence_enrolments (unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;

-- The worker's hot path: active enrolments that are due.
CREATE INDEX IF NOT EXISTS newsletter_sequence_enrolments_due_idx
  ON newsletter_sequence_enrolments (state, next_send_at);

-- Verify:
--   SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'newsletter_sequence%';
