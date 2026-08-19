-- db/audience.sql
-- The shared AUDIENCE layer — the organisation's own contacts, owned by the tenant and readable by
-- every assistant it hires. Phase 0 of docs/newsletter-assistant-plan.md.
--
-- ⚠️ WHY THIS IS NOT `leads`. `leads` (+ db/crm-contacts.sql) is BE MORE SWAN'S OWN sales CRM —
-- the rows behind Admin → Users → Contacts. It has no mandatory organisation_id, its grain is
-- (email, opportunity_reason), and every row in it is visible to a Super Admin. Putting a tenant's
-- mailing list there would publish every customer's audience into our own admin console. Same
-- collision family as leads/lead_replies vs lead_threads/lead_messages.
--
-- ⚠️ WHY NOT `assistant_records` either. That table is per-ASSISTANT (ai_assistant_id NOT NULL) and
-- its CHECK constrains record_type to lead|enrichment|meeting|invoice|ticket. An audience that
-- lives inside one assistant dies when that assistant is archived, and cannot be read by the next
-- one the tenant hires — which is the entire reason this layer exists.
--
-- The grain is (organisation_id, email). One contact per address per tenant, no matter which
-- assistant captured them.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (`npm run db:migrate:apply`) — no
-- drizzle-kit push (raw-SQL RLS policies must not be clobbered). SQL goes to BOTH databases BEFORE
-- the code deploys: db.select() names every column, so a column that exists in schema.ts and not in
-- the database breaks every read of the table, not just the new feature.

-- ── Contacts ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audience_contacts (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- Normalised lowercase + trimmed by the writer (src/utils/audience-contacts.ts::normaliseEmail).
  email             TEXT NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  company           TEXT,
  phone             TEXT,
  -- 'pending' is the double-opt-in waiting room and is NEVER mailable. Anything that can send must
  -- ask src/utils/audience-consent.ts rather than reading this column directly.
  status            TEXT NOT NULL DEFAULT 'pending',
  source            TEXT NOT NULL DEFAULT 'manual',
  -- Where exactly: { formId, importJobId, assistantRecordId, page } — evidence, not display.
  source_detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The lawful basis claimed for mailing this person. Nullable only for rows that predate a claim.
  consent_basis     TEXT,
  confirmed_at      TIMESTAMP,
  unsubscribed_at   TIMESTAMP,
  last_sent_at      TIMESTAMP,
  custom_fields     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  -- The grain. Also what makes the public subscribe endpoint safely idempotent: a visitor who
  -- submits the form three times produces one contact and three consent events.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_contacts_org_email_unique') THEN
    ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_org_email_unique
      UNIQUE (organisation_id, email);
  END IF;

  -- 'suppressed' is OUR verdict (domain suppression list / do-not-contact), distinct from
  -- 'unsubscribed', which is THEIRS. Collapsing the two would lose the ability to say why.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_contacts_status_check') THEN
    ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_status_check
      CHECK (status IN ('pending','subscribed','unsubscribed','bounced','complained','suppressed'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_contacts_source_check') THEN
    ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_source_check
      CHECK (source IN ('web_form','csv_import','manual','lead_promotion','api'));
  END IF;

  -- 'imported_declared' = the tenant asserted they hold consent (audience_import_jobs.declared_consent).
  -- It is deliberately a DIFFERENT value from 'single_opt_in': one is our record, the other is theirs.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_contacts_consent_basis_check') THEN
    ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_consent_basis_check
      CHECK (consent_basis IS NULL OR consent_basis IN
        ('double_opt_in','single_opt_in','imported_declared','soft_opt_in','manual_entry'));
  END IF;
END $$;

-- Hot paths: the Audience list filtered by status, and the per-address consent lookup on every send.
CREATE INDEX IF NOT EXISTS audience_contacts_org_status_idx ON audience_contacts (organisation_id, status);
CREATE INDEX IF NOT EXISTS audience_contacts_org_email_idx  ON audience_contacts (organisation_id, email);

-- ── Segments ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audience_segments (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  -- 'dynamic' (rule-evaluated) is reserved: the column exists so adding it later is not a migration
  -- of every existing row. Ship 'manual' only.
  kind              TEXT NOT NULL DEFAULT 'manual',
  rules             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_segments_kind_check') THEN
    ALTER TABLE audience_segments ADD CONSTRAINT audience_segments_kind_check
      CHECK (kind IN ('manual','dynamic'));
  END IF;
END $$;

-- Case-insensitive uniqueness: "Newsletter" and "newsletter" as two segments is a support ticket,
-- not a feature. A partial-expression index rather than a constraint — Postgres has no
-- UNIQUE (org, lower(name)) constraint form.
CREATE UNIQUE INDEX IF NOT EXISTS audience_segments_org_name_unique
  ON audience_segments (organisation_id, lower(name));

CREATE TABLE IF NOT EXISTS audience_contact_segments (
  contact_id  INTEGER NOT NULL REFERENCES audience_contacts(id) ON DELETE CASCADE,
  segment_id  INTEGER NOT NULL REFERENCES audience_segments(id) ON DELETE CASCADE,
  added_at    TIMESTAMP NOT NULL DEFAULT now(),
  added_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (contact_id, segment_id)
);

-- "Who is in this segment" is the send-time query; the PK only serves the other direction.
CREATE INDEX IF NOT EXISTS audience_contact_segments_segment_idx ON audience_contact_segments (segment_id);

-- ── Consent events (append-only) ────────────────────────────────────────────────────────────────
-- WHY SEPARATE FROM THE CONTACT ROW: a contact row is mutable and a consent record is evidence.
-- "When did they opt in, from which page, and what did the form say" cannot be answered by a row
-- that has been updated four times since. Nothing in the codebase may UPDATE or DELETE these.
CREATE TABLE IF NOT EXISTS audience_consent_events (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting a contact must never delete the proof of what they consented
  -- to. The address stays on the event for exactly that reason.
  contact_id        INTEGER REFERENCES audience_contacts(id) ON DELETE SET NULL,
  email             TEXT NOT NULL,
  event             TEXT NOT NULL,
  channel           TEXT,
  -- The page the form was embedded on. This is the single most useful field when a recipient says
  -- "I never signed up for this".
  source_url        TEXT,
  -- PSEUDONYMISED (/24) via src/utils/ip-pseudonymise.ts. Never store a raw address here.
  ip_hash           TEXT,
  user_agent        TEXT,
  form_id           INTEGER,
  issue_id          INTEGER,
  evidence          TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_consent_events_event_check') THEN
    ALTER TABLE audience_consent_events ADD CONSTRAINT audience_consent_events_event_check
      CHECK (event IN ('subscribe_requested','confirmed','unsubscribed','bounced','complained',
                       'imported','promoted','manual_added','erased','resubscribed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audience_consent_events_org_email_idx
  ON audience_consent_events (organisation_id, email, created_at DESC);
CREATE INDEX IF NOT EXISTS audience_consent_events_contact_idx
  ON audience_consent_events (contact_id, created_at DESC);

-- ── CSV import jobs ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audience_import_jobs (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  filename          TEXT,
  row_count         INTEGER NOT NULL DEFAULT 0,
  imported          INTEGER NOT NULL DEFAULT 0,
  skipped           INTEGER NOT NULL DEFAULT 0,
  failed            INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'queued',
  error_summary     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The tenant's assertion that they hold consent for these addresses. NOT decoration: it is the
  -- only lawful basis an imported list has, and it must exist as a record with a name and a
  -- timestamp against it.
  declared_consent  BOOLEAN NOT NULL DEFAULT false,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  completed_at      TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_import_jobs_status_check') THEN
    ALTER TABLE audience_import_jobs ADD CONSTRAINT audience_import_jobs_status_check
      CHECK (status IN ('queued','running','completed','failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audience_import_jobs_org_idx ON audience_import_jobs (organisation_id, created_at DESC);

-- ── Capture forms (the embeddable widget) ───────────────────────────────────────────────────────
-- WHY A SEPARATE KEY FROM widget_configs.public_key: that one is a READ key for CDN-cacheable
-- published blog content. This one authorises anonymous WRITES from a third-party page. Different
-- blast radius when leaked, different rotation cadence, different rate limits. One table, one
-- meaning.
CREATE TABLE IF NOT EXISTS audience_forms (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  public_key        TEXT NOT NULL UNIQUE,                    -- 'aud_<nanoid>' — rotatable
  name              TEXT NOT NULL DEFAULT 'Default',
  -- ⚠️ NULL = any origin (matches widget_configs, and is the only workable default for a snippet
  -- pasted onto a site we cannot see). An EMPTY ARRAY means NOTHING is allowed — the two are
  -- different states, and treating '{}' as "any" would turn a tenant clearing the list into a
  -- wide-open write endpoint. src/utils/audience-forms.ts::originAllowed enforces the difference.
  allowed_origins   TEXT[],
  segment_id        INTEGER REFERENCES audience_segments(id) ON DELETE SET NULL,
  double_opt_in     BOOLEAN NOT NULL DEFAULT true,
  fields            JSONB NOT NULL DEFAULT '["email","first_name"]'::jsonb,
  theme             JSONB NOT NULL DEFAULT '{}'::jsonb,
  success_message   TEXT,
  redirect_url      TEXT,
  -- The exact sentence shown next to the submit button. Stored because "what did the form say"
  -- is a question a regulator asks, and the answer must not be "whatever the current template is".
  consent_text      TEXT,
  status            TEXT NOT NULL DEFAULT 'active',
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_forms_status_check') THEN
    ALTER TABLE audience_forms ADD CONSTRAINT audience_forms_status_check
      CHECK (status IN ('active','disabled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS audience_forms_org_idx ON audience_forms (organisation_id);

-- ── Double opt-in confirmations ─────────────────────────────────────────────────────────────────
-- token_hash, never the token: it is the whole credential, it lives in an inbox, and it would
-- otherwise sit in plain text in a table and in every query log that touched it.
CREATE TABLE IF NOT EXISTS audience_confirmations (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contact_id        INTEGER NOT NULL REFERENCES audience_contacts(id) ON DELETE CASCADE,
  form_id           INTEGER REFERENCES audience_forms(id) ON DELETE SET NULL,
  token_hash        TEXT NOT NULL UNIQUE,                    -- sha256(token), hex
  expires_at        TIMESTAMP NOT NULL,
  confirmed_at      TIMESTAMP,
  -- Throttle state. An unthrottled "resend my confirmation" keyed on an arbitrary address is an
  -- email-bombing tool pointed at strangers, sent from our own domain.
  sent_count        INTEGER NOT NULL DEFAULT 1,
  last_sent_at      TIMESTAMP NOT NULL DEFAULT now(),
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audience_confirmations_contact_idx ON audience_confirmations (contact_id, created_at DESC);

-- Verify:
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name LIKE 'audience_%' ORDER BY table_name;
--   SELECT conname FROM pg_constraint WHERE conrelid = 'audience_contacts'::regclass;
