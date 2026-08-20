-- db/newsletter-send-time.sql
-- What time is it for the person receiving this?
-- Requires db/audience.sql, db/newsletter.sql and db/newsletter-dispatch.sql.
--
-- ── Two different problems, and only one of them was a bug ──────────────────────────────────────
-- 1. A tenant who scheduled an issue for "9:00" got 09:00 UTC, because the server parsed a bare
--    wall-clock string with no zone attached to it. For a British sender in summer that is ten in
--    the morning; for one in Sydney it is the evening of the day before. Nothing said so. The zone
--    the tenant meant is now STAMPED on the issue (`send_timezone`) rather than assumed, so what
--    they saw when they scheduled is what happens — even if they later change their settings.
-- 2. Everyone received it at the same instant, whatever time that was where they live. That is not
--    a bug, it is a missing feature, and it is the one people pay other tools for.
--
-- ⚠️ WHY A CONTACT'S TIMEZONE IS NULLABLE AND STAYS NULLABLE. We know it only for people who
-- signed up through a form after this shipped — the browser tells us, and nothing else can. It
-- cannot be inferred from an email address, and inferring it from a sign-up IP would be a guess
-- presented as a fact in the one place where being wrong means arriving at 3am. So "we do not know"
-- is a first-class answer: those contacts are sent at the SENDER's chosen time, and the UI says how
-- many of them there are before anybody presses send.
--
-- ⚠️ A per-recipient send spreads one issue across up to 24 hours. It needs no new worker: rows
-- carry their own due_at, the batch query ignores the ones that are not due, and the issue simply
-- stays in 'sending' — which is what brings it back to the sweep, exactly as an A/B test does.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_sends') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-send-time.sql requires db/newsletter.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only newsletter.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

-- The IANA zone the tenant was looking at when they scheduled. Stamped, not resolved at send time:
-- an assistant's posting_timezone can change between scheduling and sending, and the issue must go
-- out at the moment the human agreed to.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS send_timezone TEXT;

-- 'at_once' (one instant for everybody) | 'recipient_local' (the same wall-clock time where each
-- person is). Default keeps every existing issue behaving exactly as it does today.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'at_once';

-- 'HH:MM' — the local time to aim for in recipient_local mode.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS send_local_time TEXT;

-- When THIS recipient's copy becomes due. NULL means "with everyone else", which is every row of
-- every issue sent before this existed.
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS due_at TIMESTAMP;

-- ⚠️ The subscriber's own IANA zone, as reported by their browser at sign-up. NULL is the normal
-- state for anyone who arrived before this, or through an import, or through the API.
ALTER TABLE audience_contacts ADD COLUMN IF NOT EXISTS timezone TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_issues_send_mode_check') THEN
    ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_send_mode_check
      CHECK (send_mode IN ('at_once','recipient_local'));
  END IF;
END $$;

-- The batch query becomes "queued AND due", so it is indexed as one thing.
CREATE INDEX IF NOT EXISTS newsletter_sends_issue_due_idx
  ON newsletter_sends (issue_id, status, due_at);

-- "How many of my subscribers do we hold a timezone for" — asked before every local-time send.
CREATE INDEX IF NOT EXISTS audience_contacts_timezone_idx
  ON audience_contacts (organisation_id) WHERE timezone IS NOT NULL;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'newsletter_issues' AND column_name LIKE 'send_%';
