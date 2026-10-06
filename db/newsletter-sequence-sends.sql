-- db/newsletter-sequence-sends.sql
-- One row per email a CAMPAIGN (welcome / form-triggered sequence) sends to one person.
--
-- Why (2026-10-06): campaign emails had no per-send record at all — the enrolment only stored
-- "last step sent" — so a campaign could show neither opens, clicks, bounces nor delivery, the
-- numbers every email tool reports. One-off emails get these from newsletter_sends + the provider
-- webhook; this is the same ledger for series emails, matched by provider_message_id.
--
-- Safe to apply before OR after the code: the send path and the stats read both tolerate the table
-- being absent (a missing table means "no tracking yet", never a failed send). Idempotent.

CREATE TABLE IF NOT EXISTS newsletter_sequence_sends (
  id                  serial PRIMARY KEY,
  organisation_id     integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  sequence_id         integer NOT NULL REFERENCES newsletter_sequences(id) ON DELETE CASCADE,
  step_id             integer REFERENCES newsletter_sequence_steps(id) ON DELETE SET NULL,
  step_number         integer NOT NULL,
  enrolment_id        integer REFERENCES newsletter_sequence_enrolments(id) ON DELETE CASCADE,
  contact_id          integer REFERENCES audience_contacts(id) ON DELETE SET NULL,
  email               text NOT NULL,
  provider            text,
  provider_message_id text,
  status              text NOT NULL DEFAULT 'sent',
  opened_at           timestamp,
  clicked_at          timestamp,
  open_count          integer NOT NULL DEFAULT 0,
  click_count         integer NOT NULL DEFAULT 0,
  last_clicked_url    text,
  error               text,
  sent_at             timestamp NOT NULL DEFAULT now(),
  created_at          timestamp NOT NULL DEFAULT now(),
  updated_at          timestamp NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_sequence_sends_status_check CHECK (status IN ('sent','delivered','bounced','complained'))
);

-- One record per (enrolment, step): a retried step must not count twice.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequence_sends_enrolment_step_uidx
  ON newsletter_sequence_sends (enrolment_id, step_number);
CREATE INDEX IF NOT EXISTS newsletter_sequence_sends_provider_idx
  ON newsletter_sequence_sends (provider_message_id);
CREATE INDEX IF NOT EXISTS newsletter_sequence_sends_sequence_step_idx
  ON newsletter_sequence_sends (sequence_id, step_number);
