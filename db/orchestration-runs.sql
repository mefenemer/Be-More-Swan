-- Multi-Agent Orchestration runtime (Phase 5) — audit log of fired hand-offs.
--
-- One row per time an orchestration_link fired: SOURCE assistant did SOURCE_EVENT on
-- SOURCE_POST_ID, and we handed off to the link's TARGET assistant (enqueuing a
-- content_generation_job — TARGET_JOB_ID — that produces a draft in the target's queue).
-- The UNIQUE(link_id, source_post_id) key makes firing idempotent: a retried draft/publish
-- for the same post cannot double-enqueue. Also powers the "last fired" hint on the hub +
-- the assistant page's Active Workflows card.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS orchestration_runs (
  id                   SERIAL PRIMARY KEY,
  organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  -- The link that fired. Kept as SET NULL so run history survives a link being deleted.
  link_id              INTEGER REFERENCES orchestration_links(id) ON DELETE SET NULL,
  source_assistant_id  INTEGER,
  target_assistant_id  INTEGER,
  source_event         TEXT NOT NULL,
  source_post_id       INTEGER,       -- the post whose draft/publish triggered the hand-off
  target_job_id        TEXT,          -- content_generation_jobs.job_id enqueued for the target (nullable)
  status               TEXT NOT NULL DEFAULT 'handed_off',   -- 'handed_off' | 'skipped'
  created_at           TIMESTAMP NOT NULL DEFAULT now()
);

-- Tenant-scoped listing.
CREATE INDEX IF NOT EXISTS orchestration_runs_org_idx
  ON orchestration_runs (organisation_id);

-- "Latest firing for this link" (powers lastFiredAt).
CREATE INDEX IF NOT EXISTS orchestration_runs_link_idx
  ON orchestration_runs (link_id, created_at DESC);

-- Idempotency: one run per (link, triggering post). Blocks double-fire on retries.
-- NOTE: source_post_id is expected non-null for the wired events (draft/publish).
CREATE UNIQUE INDEX IF NOT EXISTS orchestration_runs_unique
  ON orchestration_runs (link_id, source_post_id);
