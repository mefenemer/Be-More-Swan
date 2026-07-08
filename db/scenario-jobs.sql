-- Integration Scenario Library — outbound job queue.
-- Design: docs/integration-scenario-library-plan.md. Drizzle mirror: db/schema.ts::scenarioJobs.
-- A BMS trigger (e.g. a lead flipping to QUALIFIED) enqueues ONE row here; the scheduled
-- process-scenario-jobs.ts drains it with FOR UPDATE SKIP LOCKED and expands it into one
-- outbound execution per matching active_scenarios row. Mirrors discovery_jobs exactly.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS scenario_jobs (
  id                SERIAL PRIMARY KEY,
  job_id            TEXT NOT NULL UNIQUE,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assistant_id      INTEGER REFERENCES ai_assistants(id) ON DELETE CASCADE,
  trigger_event     TEXT NOT NULL,                        -- 'lead.status_changed'
  subject           JSONB NOT NULL,                       -- record + values recipes map from
  status            TEXT NOT NULL DEFAULT 'queued',       -- queued | processing | completed | failed
  attempt           INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  next_retry_at     TIMESTAMP,
  error_message     TEXT,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT scenario_jobs_status_check
    CHECK (status IN ('queued','processing','completed','failed'))
);
CREATE INDEX IF NOT EXISTS scenario_jobs_status_idx
  ON scenario_jobs (status, next_retry_at);
CREATE INDEX IF NOT EXISTS scenario_jobs_org_idx
  ON scenario_jobs (organisation_id, status);
