-- Security & Fair Usage — Multi-Account Abuse Prevention (US1 AC1.2).
-- Enforces that a given third-party tenant (service_name + provider tenant id, stored as
-- external_user_id) can be ACTIVELY connected to only one workspace at a time. This is the
-- race-proof backstop behind the app-level check in src/utils/connection-collision.ts.
--
-- Partial index: only *live* connections are constrained, so disconnecting in workspace A
-- (is_active=false / status<>'active') frees the tenant for workspace B (AC1.4 resolution path).
-- A single workspace reconnecting updates its own row in place, so it never self-collides.
--
-- APPLY MANUALLY (Neon SQL editor / psql as owner) — do NOT use `drizzle-kit push` (it can't see
-- RLS policies and would propose destructive changes). Idempotent — safe to re-run.
--
-- NOTE: if any duplicate active (service_name, external_user_id) pairs already exist across orgs,
-- this CREATE will fail. Resolve duplicates first, e.g. inspect with:
--   SELECT service_name, external_user_id, count(*) FROM system_connections
--   WHERE is_active = true AND status = 'active' AND external_user_id IS NOT NULL
--   GROUP BY 1,2 HAVING count(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS system_connections_provider_tenant_unique
  ON system_connections (service_name, external_user_id)
  WHERE is_active = true AND status = 'active' AND external_user_id IS NOT NULL;
