-- Security & Fair Usage — Multi-Account Abuse Prevention (US2: Workspace Access Request).
-- Records each rejected OAuth connection (US1 tenant collision) so the requester can ask to join
-- the workspace that already holds the connection — without us ever exposing that workspace's
-- owner. The request-workspace-access function reads the latest 'pending' row for the requesting
-- org + service to know which workspace's admin to notify.
--
-- Owner-db accessed only (OAuth callbacks + request-workspace-access run on the RLS-bypassing
-- owner connection), so no RLS policy is required here.
--
-- APPLY MANUALLY (Neon SQL editor / psql as owner) — do NOT use `drizzle-kit push`. Idempotent.

CREATE TABLE IF NOT EXISTS connection_collision_attempts (
  id                serial PRIMARY KEY,
  requesting_org_id integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  existing_org_id   integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  service_name      text    NOT NULL,
  external_user_id  text    NOT NULL,
  status            text    NOT NULL DEFAULT 'pending',  -- pending | requested | resolved
  created_at        timestamp NOT NULL DEFAULT now(),
  updated_at        timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cca_requesting_service_idx
  ON connection_collision_attempts (requesting_org_id, service_name, status);
