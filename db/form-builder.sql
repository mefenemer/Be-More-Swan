-- db/form-builder.sql
-- The Form Builder (docs/form-builder-plan.md): versioned form definitions, /f/<slug> hosted pages,
-- a per-submission record, and forms that start their own email campaign.
--
-- ⚠️ APPLY BEFORE DEPLOYING the code that reads these columns. audience-public.ts selects
-- audience_forms.definition / slug / sequence_id on EVERY public form request; on a database without
-- them every sign-up form on every customer's website returns 500.
--
-- Idempotent and safe to re-run. Constraints are changed inside DO blocks that check the current
-- definition first — never DROP-then-ADD at top level, which dies on re-run and silently skips the
-- rest of the file (see the migration-drop-then-add-constraint-trap note).

-- ── audience_forms: the definition is now the source of truth ──────────────────────────────────
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS definition   JSONB;
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS slug         TEXT;
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS sequence_id  INTEGER REFERENCES newsletter_sequences(id) ON DELETE SET NULL;
ALTER TABLE audience_forms ADD COLUMN IF NOT EXISTS assistant_id INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL;

-- A public namespace (bemoreswan.com/f/<slug>), so unique across ALL organisations, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS audience_forms_slug_uidx ON audience_forms (lower(slug)) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS audience_forms_sequence_idx ON audience_forms (sequence_id);

-- ── What each submission said ──────────────────────────────────────────────────────────────────
-- Consent evidence ("what exactly did the form ask, and what did they agree to?") and the tags a
-- confirmation applies. Tags wait for confirmation for the same reason segments do: an unconfirmed
-- address inside a tag overstates who a send will reach.
CREATE TABLE IF NOT EXISTS audience_form_submissions (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  form_id          INTEGER REFERENCES audience_forms(id) ON DELETE SET NULL,
  contact_id       INTEGER REFERENCES audience_contacts(id) ON DELETE CASCADE,
  definition_hash  TEXT NOT NULL,
  consent_text     TEXT NOT NULL,
  answers          JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags             JSONB NOT NULL DEFAULT '[]'::jsonb,
  page_url         TEXT,
  surface          TEXT NOT NULL,
  tags_applied_at  TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audience_form_submissions_form_idx ON audience_form_submissions (form_id, created_at);
CREATE INDEX IF NOT EXISTS audience_form_submissions_contact_idx ON audience_form_submissions (contact_id, form_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_form_submissions_surface_check') THEN
    ALTER TABLE audience_form_submissions ADD CONSTRAINT audience_form_submissions_surface_check
      CHECK (surface IN ('embed','hosted'));
  END IF;
END $$;

-- ── Email campaigns a form can start ───────────────────────────────────────────────────────────
-- trigger_event gains 'form'. The constraint is replaced only while it still has the old meaning,
-- so a re-run finds the new one and does nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'newsletter_sequences_trigger_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%form%'
  ) THEN
    ALTER TABLE newsletter_sequences DROP CONSTRAINT newsletter_sequences_trigger_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sequences_trigger_check') THEN
    ALTER TABLE newsletter_sequences ADD CONSTRAINT newsletter_sequences_trigger_check
      CHECK (trigger_event IN ('subscribed', 'form'));
  END IF;
END $$;

-- Still exactly ONE welcome sequence per organisation and per assistant (every welcome resolver reads
-- `trigger_event = 'subscribed' LIMIT 1`), but any number of form-triggered ones. The new partial
-- indexes are created FIRST, so there is no moment without the guarantee; then the old ones go.
-- Neither old index has dependants, so dropping them is safe on any run.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_org_welcome_uidx
  ON newsletter_sequences (organisation_id) WHERE trigger_event = 'subscribed';
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_assistant_welcome_uidx
  ON newsletter_sequences (assistant_id) WHERE assistant_id IS NOT NULL AND trigger_event = 'subscribed';
DROP INDEX IF EXISTS newsletter_sequences_org_trigger_uidx;
DROP INDEX IF EXISTS newsletter_sequences_assistant_trigger_uidx;

-- Verify (run a statement near the BOTTOM — a half-applied file reads as "pending", not "partial"):
--   SELECT indexname FROM pg_indexes WHERE tablename = 'newsletter_sequences';
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'newsletter_sequences_trigger_check';
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'audience_forms' AND column_name IN ('definition','slug','sequence_id','assistant_id');
