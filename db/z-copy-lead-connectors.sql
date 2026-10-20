-- db/z-copy-lead-connectors.sql — Lead Generation Assistant "Connects with" chips (2026-10-20, owner's call).
--
-- Gmail and Outlook are LIVE: approved outreach sends from either (MAILBOX_PROVIDERS in
-- src/utils/connection-map.ts, oauth-integrations.ts). HubSpot and Salesforce are coming soon.
-- Replaces both earlier shapes: the hand-edited ["CRM (Coming Soon)","Gmail","Outlook (Coming Soon)"]
-- that prod and staging carry, and ["HubSpot","Salesforce","Gmail","Outlook"] that
-- z-copy-live-role-claims.sql writes on a fresh database (where LinkedIn is still in the seed list).
-- Mirrored in db/seed-assistant-content.ts.
-- Idempotent: `?` matches whole elements, so the target list ("HubSpot (coming soon)"…) never matches
-- the guard and a re-run is a no-op.
-- Apply (staging first): node scripts/db-migrate.mjs apply --only z-copy-lead-connectors --execute --yes

UPDATE master_assistants
   SET integrations = '["HubSpot (coming soon)","Salesforce (coming soon)","Gmail","Outlook"]'::jsonb,
       updated_at = now()
 WHERE role_key = 'lead_qualifier'
   AND (integrations ? 'CRM (Coming Soon)' OR integrations ? 'Outlook (Coming Soon)'
        OR integrations ? 'HubSpot' OR integrations ? 'Salesforce' OR integrations ? 'LinkedIn');
