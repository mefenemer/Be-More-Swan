-- Multi-Agent Orchestration (Epic 4) — cross-assistant workflow links.
--
-- Each row is one directed hand-off rule within an organisation: "when SOURCE assistant
-- fires SOURCE_EVENT, hand off to TARGET assistant to do TARGET_ACTION". These are the
-- user-defined trigger→action links surfaced in the global Orchestrations hub and the
-- per-assistant "Active Workflows" dependency map. (Definition + visualisation only in this
-- phase; the runtime firing engine is a follow-up — nothing consumes these rows yet.)
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS orchestration_links (
  id                   SERIAL PRIMARY KEY,
  organisation_id      INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,

  -- The trigger side.
  source_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  source_event         TEXT NOT NULL,     -- 'drafts_a_post' | 'publishes_a_post' | 'completes_a_task'

  -- The hand-off target.
  target_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  target_action        TEXT NOT NULL,     -- freeform, e.g. "design the visual"

  is_active            BOOLEAN NOT NULL DEFAULT true,
  created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMP NOT NULL DEFAULT now()
);

-- Tenant-scoped listing (the hub lists every link for the org).
CREATE INDEX IF NOT EXISTS orchestration_links_org_idx
  ON orchestration_links (organisation_id);

-- Dependency-map lookups: "links where this assistant is the source / the target".
CREATE INDEX IF NOT EXISTS orchestration_links_source_idx
  ON orchestration_links (source_assistant_id);
CREATE INDEX IF NOT EXISTS orchestration_links_target_idx
  ON orchestration_links (target_assistant_id);

-- An assistant cannot hand off to itself (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orchestration_links_no_self_check'
  ) THEN
    ALTER TABLE orchestration_links
      ADD CONSTRAINT orchestration_links_no_self_check
      CHECK (source_assistant_id <> target_assistant_id);
  END IF;
END $$;

-- One link per (source, event, target, action) — blocks accidental duplicates (idempotent add).
CREATE UNIQUE INDEX IF NOT EXISTS orchestration_links_unique
  ON orchestration_links (source_assistant_id, source_event, target_assistant_id, target_action);
