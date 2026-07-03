-- Feature Roadmap — admin-only delivery backlog.
--
-- Some "issues" reported during testing are actually feature requests, not bugs. An admin
-- can move such an issue to status 'roadmap' (see the expanded issue_reports CHECK below),
-- which closes the issue from the reporter's point of view and creates an item here. Items
-- can also be added directly by an admin (source='manual').
--
-- Prioritisation is two-dimensional:
--   priority    — Critical/High/Medium/Low signal set when promoting / creating.
--   sort_order  — manual drag-rank within the board (lower = higher up the backlog).
--
-- Lifecycle (status): planned → in_progress → shipped (or declined). Admin-managed only.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS feature_roadmap (
  id           SERIAL PRIMARY KEY,

  title        TEXT NOT NULL,
  description  TEXT,

  -- critical | high | medium | low
  priority     TEXT NOT NULL DEFAULT 'medium',
  -- planned | in_progress | shipped | declined
  status       TEXT NOT NULL DEFAULT 'planned',

  -- Manual drag-rank within the board. Lower sorts higher; freshly promoted requests are
  -- inserted below the current minimum so they surface at the top.
  sort_order   INTEGER NOT NULL DEFAULT 0,

  -- Where the item came from. 'issue' items link back via issue_id.
  source       TEXT NOT NULL DEFAULT 'manual',
  issue_id     INTEGER REFERENCES issue_reports(id) ON DELETE SET NULL,

  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- Board ordering, and a cheap lookup of "is this issue already on the roadmap?".
CREATE INDEX IF NOT EXISTS feature_roadmap_order_idx ON feature_roadmap (status, sort_order);
CREATE INDEX IF NOT EXISTS feature_roadmap_issue_idx ON feature_roadmap (issue_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feature_roadmap_priority_check'
  ) THEN
    ALTER TABLE feature_roadmap
      ADD CONSTRAINT feature_roadmap_priority_check
      CHECK (priority IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feature_roadmap_status_check'
  ) THEN
    ALTER TABLE feature_roadmap
      ADD CONSTRAINT feature_roadmap_status_check
      CHECK (status IN ('planned', 'in_progress', 'shipped', 'declined'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'feature_roadmap_source_check'
  ) THEN
    ALTER TABLE feature_roadmap
      ADD CONSTRAINT feature_roadmap_source_check
      CHECK (source IN ('manual', 'issue'));
  END IF;
END $$;

-- ── Expand the issue_reports status set to include 'roadmap' ──────────────────
-- Adds a distinct terminal state for "promoted to the feature roadmap" (separate from the
-- generic 'closed'). Drop + re-add keeps this idempotent while updating the allowed set.
ALTER TABLE issue_reports DROP CONSTRAINT IF EXISTS issue_reports_status_check;
ALTER TABLE issue_reports
  ADD CONSTRAINT issue_reports_status_check
  CHECK (status IN ('reported', 'fix_in_progress', 'fixed_ready_to_test', 'more_info_required', 'closed', 'roadmap'));
