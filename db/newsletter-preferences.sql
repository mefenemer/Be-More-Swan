-- db/newsletter-preferences.sql
-- The preference centre: something to press other than "unsubscribe".
-- Requires db/audience.sql, db/newsletter.sql and db/newsletter-dispatch.sql.
--
-- ── Why this exists ─────────────────────────────────────────────────────────────────────────────
-- Until now the only exit was total unsubscribe, so someone who thought "this is good, just too
-- often" had one button and it was the permanent one. A pause and a frequency cap keep people who
-- would otherwise leave for good, and — the part that matters more — they are a genuine answer to
-- the request rather than a delaying tactic: both are honoured by the send path itself, not by a
-- setting somebody has to remember to read.
--
-- ⚠️ A PAUSE BINDS EVERY ASSISTANT, not just the newsletter. It is enforced in
-- src/utils/audience-consent.ts, which is the one place that answers "may this organisation email
-- this address right now" — so a welcome sequence and Lead Generator outreach stop too. Somebody
-- who asks for quiet and then receives a "welcome!" email two days later has been told no.
--
-- ⚠️ FRESH-INSTALL ORDER. This file re-creates two CHECK constraints that db/audience.sql and
-- db/newsletter.sql also define, more narrowly. Those files add theirs only IF NOT EXISTS, so on an
-- existing database they can never narrow what this widens. On a FRESH database the runner's
-- alphabetical order puts this file BEFORE newsletter.sql — apply newsletter.sql first. The guard
-- below refuses to run without newsletter_sends, so getting it wrong is loud rather than silent.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE: db/schema.ts names these columns, and bare
-- `db.select()` reads on audience_contacts name every column in the table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_sends') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-preferences.sql requires db/audience.sql and db/newsletter.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only audience.sql   (then --only newsletter.sql, then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

-- NULL = not paused. A timestamp rather than a boolean + a job: "is this person paused?" is then a
-- comparison every reader can make for itself, and a pause ENDS ON ITS OWN. A flag would need a
-- sweep to clear it, and a sweep that stops running leaves people silently muted for ever — this
-- codebase has already had two nightly sweeps that never ran once.
ALTER TABLE audience_contacts ADD COLUMN IF NOT EXISTS paused_until TIMESTAMP;

-- 'all' = every issue. 'monthly' = at most one a month, measured from last_sent_at.
-- ⚠️ Deliberately NOT a topic picker. Segments here are hand-maintained, so "only send me the
-- product news" would be a promise whose accuracy depends on somebody keeping a list up to date.
ALTER TABLE audience_contacts ADD COLUMN IF NOT EXISTS email_frequency TEXT NOT NULL DEFAULT 'all';

-- When they last told us. Evidence lives in audience_consent_events; this is for the UI.
ALTER TABLE audience_contacts ADD COLUMN IF NOT EXISTS preferences_updated_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audience_contacts_frequency_check') THEN
    ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_frequency_check
      CHECK (email_frequency IN ('all','monthly'));
  END IF;
END $$;

-- ── Two vocabularies widened, not replaced ──────────────────────────────────────────────────────
-- Both are DROP + ADD rather than "add if missing": the constraints already exist with a narrower
-- list, so IF NOT EXISTS would silently do nothing and the first pause would fail at 23514.

-- A pause and a frequency change are consent decisions and belong in the evidence table alongside
-- the unsubscribes. 'resumed' is written when somebody lifts their own pause early.
ALTER TABLE audience_consent_events DROP CONSTRAINT IF EXISTS audience_consent_events_event_check;
ALTER TABLE audience_consent_events ADD CONSTRAINT audience_consent_events_event_check
  CHECK (event IN ('subscribe_requested','confirmed','unsubscribed','bounced','complained',
                   'imported','promoted','manual_added','erased','resubscribed',
                   'paused','resumed','frequency_changed'));

-- ⚠️ newsletter_sends.skip_reason stores the consent verdict VERBATIM, so a new verdict that is not
-- in this list turns every paused recipient into a failed write instead of a recorded skip.
ALTER TABLE newsletter_sends DROP CONSTRAINT IF EXISTS newsletter_sends_skip_reason_check;
ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_skip_reason_check
  CHECK (skip_reason IS NULL OR skip_reason IN
    ('opted_out','suppressed','unconfirmed','not_in_audience','bounced_previously',
     'complained_previously','consent_check_failed','invalid_address','do_not_contact','paused'));

-- "Who is paused right now?" for the Audience page, and small: only paused rows are in it.
CREATE INDEX IF NOT EXISTS audience_contacts_paused_idx
  ON audience_contacts (organisation_id, paused_until)
  WHERE paused_until IS NOT NULL;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'audience_contacts'
--      AND column_name IN ('paused_until','email_frequency','preferences_updated_at');
