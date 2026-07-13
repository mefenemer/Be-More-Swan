-- CRM Contacts view — contact-centric layer over the leads/enquiry data.
-- Drizzle mirror: db/schema.ts (leads new columns + contactTasks). Powers Admin → CRM → Contacts.
--
-- A "contact" is a lead of an enquiry type (contact_form | inbound_email), one row per email
-- (see contact.ts / inbound-email.ts threading). These columns add the contact-record fields the
-- 3-pane view shows: phone, a Lead/Client/Other classification, and free-form tags. contact_tasks
-- is the per-contact to-do list shown in the activity timeline.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone        TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_type TEXT NOT NULL DEFAULT 'lead';   -- 'lead' | 'client' | 'other'
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags         JSONB NOT NULL DEFAULT '[]';     -- array of strings

CREATE TABLE IF NOT EXISTS contact_tasks (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  done          BOOLEAN NOT NULL DEFAULT false,
  due_date      TEXT,                                   -- free-form ('Fri', '2026-07-20'); optional
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  completed_at  TIMESTAMP
);

-- Hot path: the contact detail pane loads a contact's open tasks first.
CREATE INDEX IF NOT EXISTS contact_tasks_lead_idx ON contact_tasks (lead_id, done);
