-- db/z-platform-incidents.sql — automatic incident reports (Business Mentor plan §6.2).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately). Idempotent: safe to re-run (ADD … IF NOT EXISTS; constraints added only when
-- missing; nothing is dropped). The code tolerates every column here being missing: until this runs,
-- src/utils/platform-incident.ts logs "not switched on yet" and records nothing.
--
-- What it changes on issue_reports:
--   - user_id becomes nullable. A system incident has no reporter, and NULL is what keeps it out of
--     every user's own list (issue-reports.ts reads WHERE user_id = <them>) and out of every
--     status-change notification (notifyIssueUser returns early on NULL). A CHECK keeps user reports
--     carrying a user.
--   - source: 'user' (what every existing row is) | 'system' (deterministic: a job failed after its
--     last retry, a chat turn errored, a Mentor action threw) | 'suspected' (lower priority; never
--     included in "Pass all to Developer").
--   - fingerprint + fingerprint_day: one row per (kind + error class + role) per UK day. A repeat
--     bumps occurrences and last_seen_at instead of adding a row.
--   - incident_context: the error, role and ids only. No customer content, prompts or DB state.

BEGIN;

ALTER TABLE issue_reports ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS source           text    NOT NULL DEFAULT 'user';
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS fingerprint      text;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS fingerprint_day  date;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS occurrences      integer NOT NULL DEFAULT 1;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS last_seen_at     timestamp;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS incident_context jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_source_check') THEN
    ALTER TABLE issue_reports ADD CONSTRAINT issue_reports_source_check
      CHECK (source IN ('user', 'system', 'suspected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_user_report_has_user') THEN
    ALTER TABLE issue_reports ADD CONSTRAINT issue_reports_user_report_has_user
      CHECK (source <> 'user' OR user_id IS NOT NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS issue_reports_fingerprint_day_uq
  ON issue_reports (fingerprint, fingerprint_day) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS issue_reports_source_idx
  ON issue_reports (source, created_at);

COMMIT;

-- Check:
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name = 'issue_reports' AND column_name IN ('user_id', 'source', 'fingerprint', 'occurrences');
--   SELECT conname FROM pg_constraint WHERE conname LIKE 'issue_reports_%check' OR conname = 'issue_reports_user_report_has_user';
