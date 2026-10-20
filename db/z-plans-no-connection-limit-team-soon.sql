-- db/z-plans-no-connection-limit-team-soon.sql — plan master data (owner decisions, 2026-10-20).
--
-- 1. No app-connection limit on any plan: how many tools a workspace connects depends on which
--    assistants it hires. The stored limits (4 / 10) were never checked by the Connections area,
--    and the descriptions ("up to 2" / "up to 5") disagreed with them. Limits cleared, the free-text
--    description removed, and both pricing-table rows switched off (is_enabled only hides a row
--    from get-plans' catalog — nothing else reads it).
-- 2. Team seats are not finished. They belong to the Busywork Buster only, shown as "Coming soon":
--    workspace_collaboration = 'coming_soon' renders a pill on the pricing table and in the plan
--    picker it is left out — and src/utils/team-seats.ts treats only TRUE as on, so it can never
--    switch invites on. seat_limit cleared on both plans (the Workflow Saver carried 3, unused).
--
-- Every statement RETURNs what it changed, so the Neon SQL editor shows a result either way.
-- Safe to re-run. Apply on staging, then prod.

BEGIN;

UPDATE master_plans
   SET app_connection_limit = NULL,
       features = features - 'app_connections'
 WHERE app_connection_limit IS NOT NULL OR features ? 'app_connections'
RETURNING tier_key, app_connection_limit, features ? 'app_connections' AS still_has_description;

UPDATE master_plans
   SET seat_limit = NULL,
       features = jsonb_set(features, '{workspace_collaboration}',
                            CASE WHEN tier_key = 'buster' THEN '"coming_soon"'::jsonb ELSE 'false'::jsonb END)
 WHERE tier_key IN ('saver', 'buster')
RETURNING tier_key, seat_limit, features -> 'workspace_collaboration' AS workspace_collaboration;

UPDATE plan_features
   SET is_enabled = FALSE, updated_at = now()
 WHERE key IN ('app_connection_limit', 'app_connections')
RETURNING key, is_enabled;

COMMIT;
