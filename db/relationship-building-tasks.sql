-- Relationship-Building Checklist (AC6, SMM) — per-assistant daily engagement actions.
--
-- Each row is one checkable action ("Reply to 5 recent comments", "Engage with 10 posts in
-- your niche", …) generated for a given day from the assistant blueprint. The user ticks
-- items off; completion is persisted so the list survives navigation/reload. A fresh list is
-- generated lazily the first time the assistant is viewed on a new day (see
-- netlify/functions/relationship-checklist.ts).
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS relationship_building_tasks (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assistant_id     INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  task_date        DATE NOT NULL,                       -- the day this checklist item belongs to (UTC)
  title            TEXT NOT NULL,                        -- short imperative action
  description      TEXT,                                 -- one-line guidance / why it matters
  category         TEXT,                                 -- 'engagement' | 'outreach' | 'community' | 'follow_up'
  sort_order       INTEGER NOT NULL DEFAULT 0,
  completed        BOOLEAN NOT NULL DEFAULT false,
  completed_at     TIMESTAMP,
  completed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT now()
);

-- Primary access path: "today's checklist for this assistant".
CREATE INDEX IF NOT EXISTS relationship_building_tasks_assistant_date_idx
  ON relationship_building_tasks (assistant_id, task_date);

-- Tenant-scoped lookups / cleanup.
CREATE INDEX IF NOT EXISTS relationship_building_tasks_org_idx
  ON relationship_building_tasks (organisation_id);

-- One row per (assistant, day, title) — makes regeneration idempotent and blocks dupes.
CREATE UNIQUE INDEX IF NOT EXISTS relationship_building_tasks_unique
  ON relationship_building_tasks (assistant_id, task_date, title);

-- Constrain category to the known set (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'relationship_building_tasks_category_check'
  ) THEN
    ALTER TABLE relationship_building_tasks
      ADD CONSTRAINT relationship_building_tasks_category_check
      CHECK (category IS NULL OR category IN ('engagement', 'outreach', 'community', 'follow_up'));
  END IF;
END $$;
