-- SMART Goals — Feature 1 (AI-Driven SMART Goals & Performance Optimization).
-- Two tables: `goals` (one measurable goal per assistant, US1.1) and `goal_telemetry`
-- (time-series progress samples, AC4.2.1). Idempotent — safe to run more than once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled tables.
-- Canonical column definitions live in db/schema.ts (export const goals / goalTelemetry).
--
-- RLS: intentionally NOT enabled here. Reads/writes go through getDb() (the neondb_owner
-- connection, which bypasses RLS) and filter by organisation_id explicitly — the same
-- owner-path + manual-filter pattern as content_rules / post_insights. If a withTenant()
-- caller is ever added, enable RLS here in lockstep, mirroring db/rls/R1-crown-jewels.sql.

CREATE TABLE IF NOT EXISTS goals (
    id                  serial PRIMARY KEY,
    organisation_id     integer NOT NULL REFERENCES organisations(id)  ON DELETE CASCADE,
    assistant_id        integer NOT NULL REFERENCES ai_assistants(id)  ON DELETE CASCADE,
    metric_key          text NOT NULL,                 -- → src/config/goal-metrics.ts catalog
    target_value        numeric NOT NULL,
    start_value         numeric,                       -- baseline at creation, for run-rate math
    target_date         timestamp NOT NULL,
    status              text NOT NULL DEFAULT 'pending',  -- pending|on_track|at_risk|off_track|data_disconnected
    status_updated_at   timestamp,
    latest_value        numeric,                       -- denormalised most-recent telemetry value
    is_primary          boolean NOT NULL DEFAULT false,-- AC2.1.2 — drives detail-page progress bar
    is_active           boolean NOT NULL DEFAULT true, -- soft archive
    created_by_user_id  integer REFERENCES users(id)   ON DELETE SET NULL,
    created_at          timestamp NOT NULL DEFAULT now(),
    updated_at          timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goals_org_idx       ON goals (organisation_id);
CREATE INDEX IF NOT EXISTS goals_assistant_idx ON goals (assistant_id);

CREATE TABLE IF NOT EXISTS goal_telemetry (
    id                  serial PRIMARY KEY,
    goal_id             integer NOT NULL REFERENCES goals(id)          ON DELETE CASCADE,
    organisation_id     integer NOT NULL REFERENCES organisations(id)  ON DELETE CASCADE,
    metric_value        numeric NOT NULL,
    source              text NOT NULL DEFAULT 'poll',  -- poll | webhook | rollup | internal
    recorded_at         timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS goal_telemetry_goal_idx ON goal_telemetry (goal_id, recorded_at);
