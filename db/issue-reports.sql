-- Issue Reports (Testing-phase bug reporting) — user-submitted issues + admin triage.
--
-- While the product is in the testing phase, the workspace exposes a "Report an Issue"
-- side-menu item. Each submission captures: a free-text description, the location the
-- user was on when they hit the button (source_location/source_url — tells the developer
-- WHERE the issue was), and an optional screenshot (stored inline as a base64 data URL so
-- the feature works without S3/R2 being provisioned). Issues are stored against the user
-- so they can track progress; the admin owner is emailed on every new report.
--
-- Lifecycle (status): reported → fix_in_progress → fixed_ready_to_test → closed
--                     ↘ more_info_required (admin asks the user for detail) ↗
--                     ↘ roadmap (feature request promoted to the Feature Roadmap; see db/feature-roadmap.sql)
-- The threaded back-and-forth (admin status messages + user replies) lives in
-- issue_report_messages.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS issue_reports (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  description      TEXT NOT NULL,                       -- what the user reported
  source_location  TEXT,                                -- in-app view/route the user came from (e.g. 'calendar')
  source_url       TEXT,                                -- full URL at time of report
  user_agent       TEXT,                                -- browser UA, aids reproduction

  -- Optional screenshot. Stored inline as a data URL (data:image/png;base64,...) so the
  -- feature has no hard dependency on object storage during the testing phase.
  image_data       TEXT,
  image_mime       TEXT,

  -- reported | fix_in_progress | fixed_ready_to_test | more_info_required | closed | roadmap
  status           TEXT NOT NULL DEFAULT 'reported',

  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMP                            -- set when the user confirms the fix (status=closed)
);

-- "My reports" for a user; and tenant-scoped admin/cleanup lookups.
CREATE INDEX IF NOT EXISTS issue_reports_user_idx   ON issue_reports (user_id, created_at);
CREATE INDEX IF NOT EXISTS issue_reports_org_idx    ON issue_reports (organisation_id);
CREATE INDEX IF NOT EXISTS issue_reports_status_idx ON issue_reports (status, created_at);

-- Constrain status to the known set (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_status_check'
  ) THEN
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_status_check
      CHECK (status IN ('reported', 'fix_in_progress', 'fixed_ready_to_test', 'more_info_required', 'closed', 'roadmap'));
  END IF;
END $$;

-- Threaded conversation: admin status updates / supporting messages, and user replies
-- (e.g. answering a "More info required" request, or confirming a fix).
CREATE TABLE IF NOT EXISTS issue_report_messages (
  id          SERIAL PRIMARY KEY,
  issue_id    INTEGER NOT NULL REFERENCES issue_reports(id) ON DELETE CASCADE,
  -- 'admin' | 'user' — who wrote this message
  author_type TEXT NOT NULL,
  author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  -- The status the issue was moved to alongside this message (null = plain message/reply).
  status      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS issue_report_messages_issue_idx
  ON issue_report_messages (issue_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_report_messages_author_check'
  ) THEN
    ALTER TABLE issue_report_messages
      ADD CONSTRAINT issue_report_messages_author_check
      CHECK (author_type IN ('admin', 'user'));
  END IF;
END $$;

-- ── "Pass to Developer" AI auto-fix handoff ──────────────────────────────────
-- An admin can hand a reported issue to an AI developer agent (Claude Code) that
-- runs on a dev machine. The cloud only orchestrates: it queues the issue, a local
-- watcher claims it, fixes it on a branch, opens a PR and writes the result back.
--
--   dev_handoff_status: null      → never handed off
--                       queued    → admin pressed "Pass to Developer"; awaiting a runner
--                       in_progress → a runner has claimed it and is working
--                       completed → fix produced (see dev_branch / dev_pr_url / dev_result)
--                       failed    → the runner could not produce a fix (see dev_result)
--
-- The user-visible lifecycle (status) is unchanged: queueing moves it to
-- 'fix_in_progress' and a successful completion moves it to 'fixed_ready_to_test'.
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_handoff_status TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_handoff_at     TIMESTAMP;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_branch         TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_pr_url         TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_result         TEXT;

-- ── Which runner is working this issue ───────────────────────────────────────
-- Several runners (scripts/dev-issue-fixer.mjs) can drain the queue at once — the
-- claim is a compare-and-swap so they never grab the same issue. These two columns
-- let the admin portal show WHO is fixing WHAT:
--   dev_runner_id        — identity of the runner that currently holds this issue
--                          (a fix claim OR a merge claim); e.g. "mac-studio:48213".
--                          Stamped on claim, cleared when the runner reports a result.
--   dev_runner_heartbeat — when that runner claimed the issue ("working since"). The
--                          fix runs Claude synchronously so there's no mid-fix ping;
--                          a claim far older than a normal fix flags a dead/stalled
--                          runner in the UI so the issue can be re-queued.
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_runner_id        TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_runner_heartbeat TIMESTAMP;

-- When a fix needs a database migration, the runner returns the (idempotent) SQL here
-- instead of moving the issue straight to "Fixed & Ready to Test". A super-admin reviews
-- and runs it against the staging Neon DB from inside the ticket; only a successful run
-- advances the issue. dev_sql_status: null | pending | applied | failed.
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_sql        TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_sql_status TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_sql_result TEXT;       -- DB feedback from the run
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_sql_ran_at TIMESTAMP;

-- ── Merge the fix PR to staging ──────────────────────────────────────────────
-- After the AI produces a fix the issue no longer jumps straight to "Fixed & Ready
-- to Test". It parks at 'fix_in_progress' with dev_merge_status='ready' and a super-admin
-- presses "Merge to staging" in the ticket. That queues a merge the local watcher claims
-- and performs with `gh pr merge`; only once merged (and any migration applied) does the
-- issue advance to 'fixed_ready_to_test' and the reporter get notified.
--   dev_merge_status: null    → no PR / not applicable
--                     ready   → PR open, awaiting a super-admin to merge
--                     queued  → merge requested; awaiting the watcher
--                     merging → the watcher has claimed it and is merging
--                     merged  → merged to staging
--                     failed  → the merge attempt failed (see dev_merge_result); retriable
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_merge_status TEXT;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_merged_at    TIMESTAMP;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS dev_merge_result TEXT;     -- gh output / error

-- Lets a runner cheaply claim the oldest queued issue.
CREATE INDEX IF NOT EXISTS issue_reports_handoff_idx
  ON issue_reports (dev_handoff_status, dev_handoff_at);

-- Lets the watcher cheaply claim the oldest queued merge.
CREATE INDEX IF NOT EXISTS issue_reports_merge_idx
  ON issue_reports (dev_merge_status, dev_handoff_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_dev_handoff_status_check'
  ) THEN
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_dev_handoff_status_check
      CHECK (dev_handoff_status IS NULL
             OR dev_handoff_status IN ('queued', 'in_progress', 'completed', 'failed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_dev_sql_status_check'
  ) THEN
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_dev_sql_status_check
      CHECK (dev_sql_status IS NULL
             OR dev_sql_status IN ('pending', 'applied', 'failed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issue_reports_dev_merge_status_check'
  ) THEN
    ALTER TABLE issue_reports
      ADD CONSTRAINT issue_reports_dev_merge_status_check
      CHECK (dev_merge_status IS NULL
             OR dev_merge_status IN ('ready', 'queued', 'merging', 'merged', 'failed'));
  END IF;
END $$;

-- ── AI auto-fix runner health / session-limit recovery ───────────────────────
-- The "Pass to Developer" runner (scripts/dev-issue-fixer.mjs) fixes issues by shelling out
-- to the Claude Code CLI on a developer machine. That CLI has its own usage/session limit —
-- when it's exhausted the runner can't produce ANY fix, so re-queueing an issue just fails
-- again immediately. This table lets a runner report that block, park itself, and be resumed
-- from the admin portal once a Claude account with credit is logged in on the runner machine.
--
--   state: 'ok'              → runner healthy / working normally
--          'session_limited' → CLI hit its limit; runner has paused and stopped claiming
--
-- On a block the runner re-queues the issue it was on (dev_handoff_status → 'queued') and
-- records it as blocked_issue_id. A super-admin logs into a funded Claude account on the
-- runner machine and presses "Resume" (sets resume_requested = true); the runner verifies the
-- new login with a cheap probe call and, only on success, flips back to 'ok' and resumes —
-- the re-queued issue is then re-claimed automatically. No Claude credential is ever stored
-- here; this row only coordinates the human-in-the-loop re-login.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).
CREATE TABLE IF NOT EXISTS dev_runner_status (
  runner_id         TEXT PRIMARY KEY,                 -- matches scripts/dev-issue-fixer.mjs RUNNER_ID (default host:pid)
  state             TEXT NOT NULL DEFAULT 'ok',       -- 'ok' | 'session_limited'
  message           TEXT,                             -- raw CLI error text
  reset_hint        TEXT,                             -- parsed reset time for display, e.g. '12:30pm (Europe/London)'
  blocked_issue_id  INTEGER REFERENCES issue_reports(id) ON DELETE SET NULL,
  resume_requested  BOOLEAN NOT NULL DEFAULT false,   -- admin pressed "Resume" after re-logging in
  last_probe_result TEXT,                             -- outcome of the last verification probe after a Resume
  blocked_at        TIMESTAMP,
  last_seen_at      TIMESTAMP NOT NULL DEFAULT now(), -- updated on every runner poll (liveness)
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dev_runner_status_state_check'
  ) THEN
    ALTER TABLE dev_runner_status
      ADD CONSTRAINT dev_runner_status_state_check
      CHECK (state IN ('ok', 'session_limited'));
  END IF;
END $$;

-- Claude account currently logged into the CLI on the runner machine (e.g. "dev@x.com").
-- Self-reported by the runner on block / resume-check / resume-ack; display only — shown in
-- the paused banner so the admin can see whether the re-login took effect before Resume.
ALTER TABLE dev_runner_status ADD COLUMN IF NOT EXISTS active_account TEXT;

-- Admin pressed "Restart runner" in the paused banner. Consumed by the runner's next
-- resume-check poll (~10s while paused): the row is deleted and the runner restarts itself
-- (exit under launchd KeepAlive, or re-spawn when run manually in a terminal).
ALTER TABLE dev_runner_status ADD COLUMN IF NOT EXISTS restart_requested BOOLEAN NOT NULL DEFAULT false;

-- Admin pressed "Switch CLI to <account>" in the Runner panel: the requested account email.
-- Consumed (cleared) when the runner's next poll delivers it; the runner then swaps its locally
-- stored Claude CLI credential snapshot to that account, verifies with a probe, and reports the
-- outcome via ?action=switch-ack. Credentials themselves NEVER leave the runner machine — this
-- column only carries the account label.
ALTER TABLE dev_runner_status ADD COLUMN IF NOT EXISTS switch_account_requested TEXT;

-- JSON array self-reported by the runner on every poll: the Claude accounts it can switch to,
-- e.g. [{"email":"a@x.com","stored":true}]. "stored" means a local credential snapshot exists
-- (the account has been logged into at least once on the runner machine). Display only.
ALTER TABLE dev_runner_status ADD COLUMN IF NOT EXISTS known_accounts TEXT;
