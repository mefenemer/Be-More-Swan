-- db/z-mentor-morning.sql — the Business Mentor's morning summary.
-- Plan: docs/morning-summary-plan.md. Code: src/utils/mentor-morning.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments (paste into the Neon SQL Editor, staging and
-- prod separately). Idempotent: safe to re-run (CREATE … IF NOT EXISTS only; nothing is dropped). The
-- code tolerates the table being missing: the dispatcher reports ready:false and sends nothing.
--
-- ALSO re-run db/notifications-categorization.sql on both (it gained 'mentor_morning_summary' →
-- 'state_change'; the call site passes the category too, so an un-rerun database still files it right).
--
-- One table:
--   mentor_mornings — one row per workspace per local day: the latch that stops a second summary, what
--                     it said, and who was emailed (pending-actions-digest.ts skips those people that
--                     day, so nobody gets two morning emails). A day with nothing to say is still
--                     recorded (status 'empty') so the hourly dispatcher doesn't rebuild it. Kept 30 days.

BEGIN;

CREATE TABLE IF NOT EXISTS mentor_mornings (
  id               serial PRIMARY KEY,
  organisation_id  integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id  integer REFERENCES ai_assistants(id) ON DELETE SET NULL,
  -- The workspace's local date the summary is FOR (it describes the day before).
  day              date NOT NULL,
  status           text NOT NULL DEFAULT 'sent',
  -- MorningSummary (src/utils/mentor-morning.ts): { sections: [...], timeZone, … }
  summary          jsonb,
  emailed_user_ids integer[] NOT NULL DEFAULT '{}'::integer[],
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mentor_mornings_status_check CHECK (status IN ('sent', 'empty', 'failed')),
  CONSTRAINT mentor_mornings_org_day_uq UNIQUE (organisation_id, day)
);

CREATE INDEX IF NOT EXISTS mentor_mornings_created_idx ON mentor_mornings (created_at);

COMMIT;

-- Check (expect 1 row):
--   SELECT count(*) FROM information_schema.tables WHERE table_name = 'mentor_mornings';
