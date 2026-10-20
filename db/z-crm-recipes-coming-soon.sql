-- db/z-crm-recipes-coming-soon.sql — HubSpot + Salesforce recipes → 'coming_soon' (2026-10-20, owner's call).
--
-- HubSpot and Salesforce are not offered yet. The recipes and their handlers are built, but while they are
-- 'available' the Integration Scenario Library (integrations.html, the assistant Connections tab) offers
-- "Connect HubSpot first" and lets a workspace enable them. integration-scenarios.ts refuses to activate a
-- recipe whose status is not 'available', so this closes every in-app route. Activations a workspace already
-- has keep firing (scenario-engine.ts does not read the recipe status) — nothing a customer set up breaks.
-- Mirrored in db/seed-catalog.ts; the HubSpot/Salesforce provider cards on integrations.html are coming soon too.
-- Idempotent: only rows still 'available' change.
-- Apply (staging first): node scripts/db-migrate.mjs apply --only z-crm-recipes-coming-soon --execute --yes

UPDATE integration_scenarios
   SET status = 'coming_soon'
 WHERE scenario_key IN ('hubspot_handoff_push', 'hubspot_feedback_loop', 'hubspot_suppression_sync',
                        'salesforce_handoff_push', 'hubspot_meeting_handoff')
   AND status = 'available';
