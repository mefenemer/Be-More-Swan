-- The Note Taker's webhook action sends one fixed meeting event now (scenario-engine buildMeetingWebhookPayload,
-- 2026-11-18): title, summary, decisions, risks, action items and attendees — nothing to map. Bring the catalogue row
-- in line with db/seed-catalog.ts: a clearer title and no field map. The page already hides the map in code
-- (integration-scenarios.ts), so this is copy and tidiness, not a behaviour switch. Safe to re-run. Run on BOTH databases.

BEGIN;

UPDATE integration_scenarios
SET title = 'Send Approved Meetings to a Webhook',
    description = 'When you approve a meeting, POST it to any URL as one meeting.approved event — title, summary, decisions, risks, action items and attendees (Zapier / Make / your own endpoint).',
    field_schema = '[]'::jsonb
WHERE scenario_key = 'universal_webhook_meeting'
  AND (title IS DISTINCT FROM 'Send Approved Meetings to a Webhook' OR field_schema IS DISTINCT FROM '[]'::jsonb);

COMMIT;

-- Verify (both databases) — one row, the new title, field_schema []:
--   SELECT scenario_key, title, field_schema FROM integration_scenarios WHERE scenario_key = 'universal_webhook_meeting';
