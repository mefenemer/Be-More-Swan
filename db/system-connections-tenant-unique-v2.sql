-- Security & Fair Usage — US1 tenant-collision block RE-ARMED, with LinkedIn exempt.
--
-- Re-creates the race-proof backstop behind src/utils/connection-collision.ts: one LIVE row per
-- (service_name, external_user_id) across all workspaces. Differences from the original
-- (db/connection-tenant-uniqueness.sql, dropped by system-connections-drop-provider-tenant-unique.sql):
--   · a NEW index name, so the drop file (which re-runs if it drifts) can never remove it
--   · LinkedIn is EXCLUDED: its external id is the person's own member profile, and one owner
--     posting for several businesses from it is legitimate (COLLISION_EXEMPT_SERVICES)
--
-- Filename note: sorts AFTER system-connections-drop-provider-tenant-unique.sql ('t' > 'd'), so on
-- a fresh database the original is created, dropped, then this one created.
--
-- ⚠️ ORDER: deploy the code first, then apply this, then set ENFORCE_TENANT_COLLISION=true.
-- Index without the app check means a collision reaches the DB as a bare 23505 that no callback
-- catches (the user gets a 500, and meta-oauth has already written the token to the vault).
--
-- ⚠️ The CREATE FAILS if duplicates accumulated while the block was off. Check first; every row
-- this returns must be resolved (deactivate the unwanted one, after checking scheduled_posts and
-- post_insights reference it — both are ON DELETE SET NULL):
--   SELECT service_name, external_user_id, array_agg(organisation_id) AS orgs, array_agg(id) AS ids
--   FROM system_connections
--   WHERE is_active = true AND status = 'active' AND external_user_id IS NOT NULL
--     AND service_name <> 'linkedin'
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- Idempotent — safe to re-run.

CREATE UNIQUE INDEX IF NOT EXISTS system_connections_tenant_unique_v2
  ON system_connections (service_name, external_user_id)
  WHERE is_active = true AND status = 'active' AND external_user_id IS NOT NULL
    AND service_name <> 'linkedin';
