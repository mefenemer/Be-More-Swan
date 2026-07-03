-- Feature Requests & Roadmap — unified, user-facing feature voting + admin roadmap.
--
-- Supersedes the admin-only feature_roadmap table (db/feature-roadmap.sql): this one adds
-- public submission, a moderation queue, voting, an LLM-enhanced admin workflow and a
-- Year/Quarter Gantt — and ABSORBS the old roadmap (a one-time idempotent migration at the
-- bottom copies any existing feature_roadmap rows in). The old table is left physically in
-- place until the migration is verified on staging; a follow-up migration drops it.
--
-- Lifecycle (status):
--   pending_review (default for USER submissions) — visible only to the submitter + admins
--   under_review                                  — an admin is triaging it
--   open                                          — approved + public; on the board, not yet scheduled
--   planned                                       — scheduled onto a quarter (appears on the roadmap)
--   in_progress                                   — being built (appears on the roadmap)
--   released                                      — shipped (released_at set; powers avg-wait metric)
--   declined                                      — rejected by an admin
--   duplicate                                     — merged into another request (merged_into_id set)
--
-- Admin/issue-originated items skip moderation and are inserted at 'open' or 'planned'.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS feature_requests (
  id                    SERIAL PRIMARY KEY,

  -- Who raised it. NULL for purely admin/issue-originated items.
  submitted_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Submitter's org at time of raising — context only (the board is global/cross-tenant).
  organisation_id       INTEGER REFERENCES organisations(id) ON DELETE SET NULL,

  -- Live (admin-editable) title/description shown on the public board.
  title                 TEXT NOT NULL,
  description           TEXT,
  -- The submitter's raw original text, preserved so "Enhance with AI" always works from the
  -- user's words even after an admin has polished `description`.
  submitter_description  TEXT,

  -- app_core | existing_assistant | new_assistant
  category              TEXT NOT NULL DEFAULT 'app_core',
  -- When category='existing_assistant': the CATALOGUE ROLE slug (not a tenant-specific
  -- assistant instance — the board is global, so everyone sees the same options).
  assistant_ref         TEXT,

  -- See lifecycle note above.
  status                TEXT NOT NULL DEFAULT 'pending_review',

  -- critical | high | medium | low — admin signal carried over from the old roadmap.
  priority              TEXT NOT NULL DEFAULT 'medium',

  -- Gantt placement, e.g. '2026-Q3'. Set when an admin drags the card onto a quarter.
  target_quarter        TEXT,

  -- Manual drag-rank within the admin board; lower sorts higher.
  sort_order            INTEGER NOT NULL DEFAULT 0,

  -- Denormalised vote tally (feature_request_votes is the source of truth; this is maintained
  -- on vote/unvote for cheap "most popular" board sorting).
  vote_count            INTEGER NOT NULL DEFAULT 0,

  -- Provenance. 'user' = public submission (moderated); 'manual' = admin-created;
  -- 'issue' = promoted from a testing bug report (links via issue_id).
  source                TEXT NOT NULL DEFAULT 'user',
  issue_id              INTEGER REFERENCES issue_reports(id) ON DELETE SET NULL,

  -- Duplicate handling: the request this one was merged into (status='duplicate').
  merged_into_id        INTEGER REFERENCES feature_requests(id) ON DELETE SET NULL,

  reviewed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMP,
  -- Set when status first becomes 'released'; (released_at - created_at) feeds the avg-wait metric.
  released_at           TIMESTAMP,

  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);

-- Public board + sort, admin board order, "my requests", roadmap, and issue-link lookups.
CREATE INDEX IF NOT EXISTS feature_requests_status_idx   ON feature_requests (status, vote_count);
CREATE INDEX IF NOT EXISTS feature_requests_board_idx    ON feature_requests (status, sort_order);
CREATE INDEX IF NOT EXISTS feature_requests_submitter_idx ON feature_requests (submitted_by, created_at);
CREATE INDEX IF NOT EXISTS feature_requests_quarter_idx  ON feature_requests (target_quarter);
CREATE INDEX IF NOT EXISTS feature_requests_issue_idx    ON feature_requests (issue_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_requests_category_check') THEN
    ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_category_check
      CHECK (category IN ('app_core', 'existing_assistant', 'new_assistant'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_requests_status_check') THEN
    ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_status_check
      CHECK (status IN ('pending_review', 'under_review', 'open', 'planned',
                        'in_progress', 'released', 'declined', 'duplicate'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_requests_priority_check') THEN
    ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_priority_check
      CHECK (priority IN ('critical', 'high', 'medium', 'low'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_requests_source_check') THEN
    ALTER TABLE feature_requests ADD CONSTRAINT feature_requests_source_check
      CHECK (source IN ('user', 'manual', 'issue'));
  END IF;
END $$;

-- ── Votes ────────────────────────────────────────────────────────────────────
-- One row per (feature, user). The UNIQUE constraint enforces AC02 "a user can only upvote
-- a specific feature once"; toggling removes the row.
CREATE TABLE IF NOT EXISTS feature_request_votes (
  id          SERIAL PRIMARY KEY,
  feature_id  INTEGER NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT feature_request_votes_unique UNIQUE (feature_id, user_id)
);

CREATE INDEX IF NOT EXISTS feature_request_votes_user_idx    ON feature_request_votes (user_id);
CREATE INDEX IF NOT EXISTS feature_request_votes_feature_idx ON feature_request_votes (feature_id);

-- ── One-time migration: fold the old admin-only feature_roadmap in ────────────
-- Copies any roadmap rows that haven't already been migrated. Guarded on issue_id (for
-- issue-sourced rows) and on a title/created_at match (for manual rows) so re-running is a
-- no-op. Status maps shipped→released; manual→source 'manual', issue→source 'issue'. These are
-- admin-curated, so they bypass moderation (no 'pending_review').
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feature_roadmap') THEN
    INSERT INTO feature_requests
      (title, description, priority, status, sort_order, source, issue_id,
       submitted_by, reviewed_by, reviewed_at, created_at, updated_at, released_at)
    SELECT
      fr.title,
      fr.description,
      fr.priority,
      CASE fr.status WHEN 'shipped' THEN 'released' ELSE fr.status END,
      fr.sort_order,
      fr.source,
      fr.issue_id,
      -- Admin-curated: no public submitter. The old created_by becomes the reviewer, matching
      -- how createRoadmapItemFromIssue stamps new issue-promotions (so status-change notices
      -- don't fire at an admin as if they had requested it).
      NULL,
      fr.created_by,
      fr.updated_at,
      fr.created_at,
      fr.updated_at,
      CASE WHEN fr.status = 'shipped' THEN fr.updated_at ELSE NULL END
    FROM feature_roadmap fr
    WHERE NOT EXISTS (
      -- already migrated by issue link …
      SELECT 1 FROM feature_requests x WHERE x.issue_id IS NOT NULL AND x.issue_id = fr.issue_id
    )
    AND NOT EXISTS (
      -- … or by an identical manual row (title + creation time)
      SELECT 1 FROM feature_requests x
      WHERE x.issue_id IS NULL AND x.title = fr.title AND x.created_at = fr.created_at
    );
  END IF;
END $$;
