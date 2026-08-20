-- db/audience-custom-fields.sql
-- The tenant's own columns: "City", "Plan", "Where we met".
-- Requires db/audience.sql.
--
-- ── Why a definitions table when the values already have a home ─────────────────────────────────
-- audience_contacts.custom_fields has existed since the table was written and nothing wrote to it.
-- The values were never the missing part; the missing part is a LIST of what a field is called.
-- Without one, "City", "city" and "Cty" are three fields nobody notices, an importer has nothing to
-- offer a column-mapping dropdown, and a segment rule has no way to name what it filters on.
--
-- ⚠️ THE KEY IS THE STABLE THING, THE LABEL IS NOT. `key` is what lives in the JSONB on every
-- contact and in every saved segment rule, so it is written once and never renamed — a rename would
-- orphan the values on thousands of rows and silently empty any rule that named it. `label` is what
-- a human sees and may be changed freely.
--
-- ── Type is reserved, not shipped ───────────────────────────────────────────────────────────────
-- The CHECK allows 'text', 'number' and 'date'; the API accepts only 'text' today. Same reservation
-- that `audience_segments.kind = 'dynamic'` made three years early and that cost nothing to honour.
-- ⚠️ Numbers and dates are deferred for a REASON, not for time: comparing them means casting tenant
-- entered JSONB text — `(custom_fields->>'age')::numeric` throws 22P02 on the first contact who
-- typed "about 40", and Postgres does not guarantee that a guard in the same AND runs first. Doing
-- it safely needs a fenced subquery, and doing it unsafely breaks a SEND.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'audience_contacts') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/audience-custom-fields.sql requires db/audience.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS audience_custom_fields (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- ⚠️ Immutable once created: it is the JSONB key on every contact and the value in every saved
  -- segment rule. Lower-case, letters/numbers/underscore — the same shape as a merge tag path,
  -- because {{contact.custom.city}} has to be writable by hand.
  key               TEXT NOT NULL,
  label             TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'text',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_custom_fields_type_check') THEN
    ALTER TABLE audience_custom_fields ADD CONSTRAINT audience_custom_fields_type_check
      CHECK (type IN ('text','number','date'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_custom_fields_key_check') THEN
    ALTER TABLE audience_custom_fields ADD CONSTRAINT audience_custom_fields_key_check
      CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$');
  END IF;
END $$;

-- One definition per key per org. Two "city" fields would put two dropdown entries in front of an
-- importer and make "which one did I map?" unanswerable.
CREATE UNIQUE INDEX IF NOT EXISTS audience_custom_fields_org_key_uidx
  ON audience_custom_fields (organisation_id, key);

-- The list read on the Audience page, the import mapper, the rule builder and the editor's tag menu.
CREATE INDEX IF NOT EXISTS audience_custom_fields_org_idx
  ON audience_custom_fields (organisation_id, label);

-- Values live on the contact and are filtered with `custom_fields ->> 'key'`. A GIN index earns its
-- keep only once a tenant segments on them often; ordinary reads here are already narrowed by
-- organisation_id and status, so it is deliberately not created yet.

-- Verify:
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'audience_custom_fields';
