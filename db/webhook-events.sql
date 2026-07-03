-- Webhook intake table for trigger-style connectors (Slack, Zendesk, …).
-- Inbound events are verified + deduped at intake (webhook-intake.ts) and stored here
-- for a downstream processor. Idempotent — safe to run more than once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies here live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled ai_assistants table.
-- Canonical column definitions live in db/schema.ts.

CREATE TABLE IF NOT EXISTS webhook_events (
    id              serial PRIMARY KEY,
    provider        text NOT NULL,
    organisation_id integer REFERENCES organisations(id) ON DELETE CASCADE,
    connection_id   integer REFERENCES system_connections(id) ON DELETE SET NULL,
    event_type      text,
    dedup_key       text NOT NULL UNIQUE,
    payload         jsonb NOT NULL,
    status          text NOT NULL DEFAULT 'received',
    error           text,
    received_at     timestamp NOT NULL DEFAULT now(),
    processed_at    timestamp
);

CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events (status, received_at);
CREATE INDEX IF NOT EXISTS webhook_events_org_idx    ON webhook_events (organisation_id);
