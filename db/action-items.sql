-- Meeting Note Taker Phase 3 — normalized action_items (per-task PM sync ledger).
-- Design: docs/meeting-note-taker-phase3-plan.md. Drizzle mirror: db/schema.ts::actionItems.
-- One row per approved meeting action item, child of the meeting assistant_records row.
-- Materialized at approval time from assistant_records.data.tasks; synced into Jira/Asana by
-- the create_tasks ACTION_HANDLERS so partial syncs + retries are idempotent ("5 of 8 synced").
-- The assistant_records.data JSON blob stays the render/edit source of truth; this table is
-- the sync ledger only.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS action_items (
  id                  SERIAL PRIMARY KEY,
  organisation_id     INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id     INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  meeting_record_id   INTEGER NOT NULL REFERENCES assistant_records(id) ON DELETE CASCADE,
  description         TEXT NOT NULL,
  assignee            TEXT,                                 -- free-text owner name, may be 'Unassigned'
  due_date            TEXT,                                 -- echoed as the LLM produced it ('by Friday'); parsed best-effort at sync
  sync_status         TEXT NOT NULL DEFAULT 'pending',      -- pending | synced | failed | skipped
  provider            TEXT,                                 -- 'jira' | 'asana' | NULL until first sync attempt
  external_ticket_id  TEXT,
  external_url        TEXT,
  error_message       TEXT,
  synced_at           TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT action_items_sync_status_check
    CHECK (sync_status IN ('pending','synced','failed','skipped'))
);

-- Hot path: the sync handler loads a meeting's items; the card/inbox counts by status.
CREATE INDEX IF NOT EXISTS action_items_meeting_idx
  ON action_items (meeting_record_id);
CREATE INDEX IF NOT EXISTS action_items_org_status_idx
  ON action_items (organisation_id, sync_status);

-- Idempotent materialization: re-approving or editing a meeting upserts on this key rather
-- than duplicating tasks (ON CONFLICT (meeting_record_id, description) DO UPDATE …).
CREATE UNIQUE INDEX IF NOT EXISTS action_items_meeting_desc_uidx
  ON action_items (meeting_record_id, description);
