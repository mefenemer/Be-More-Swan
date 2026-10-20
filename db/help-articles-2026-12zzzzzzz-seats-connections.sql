-- db/help-articles-2026-12zzzzzzz-seats-connections.sql — Help Centre, owner decisions 2026-10-20.
--
-- Sorts after db/help-articles-2026-12zzzzzz-data-export.sql. Matches
-- db/z-plans-no-connection-limit-team-soon.sql:
--   • "Connecting Apps & Integrations" said each plan includes a number of app connections. There
--     is no limit — it depends on which assistants you hire.
--   • "Business Information and Products & Services" told people to invite colleagues. No plan can
--     yet: inviting team members is coming soon to the Busywork Buster.
--   • "Your Setup Guide" listed "invite a teammate" for everyone; the guide now only offers that step
--     where the plan allows it (src/utils/onboarding-recommendations.ts).
-- REPLACE on exact strings: a no-op once applied, safe to re-run. Each statement RETURNs, so the
-- Neon SQL editor shows whether it changed a row.

BEGIN;

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         'Each plan includes a number of app connections. If you reach yours, disconnect one you don''t use before adding another.',
         'There is no limit on how many apps you connect. Link whatever your assistants need to do their jobs — how many tools you use depends on which assistants you hire, not on your plan. You can disconnect or swap an account at any time.'),
       updated_at = now()
 WHERE title = 'Connecting Apps & Integrations'
   AND content_md LIKE '%Each plan includes a number of app connections.%'
RETURNING title, 'connections updated' AS result;

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         'Invite colleagues by email and choose a role: **Viewer** (can look, can''t change anything), **Member** (uses the assistants and manages content) or **Admin** (everything, including the team and settings).',
         'Inviting colleagues, managers or clients to review and approve your assistants'' work is **coming soon to the Busywork Buster**. Anyone already in your workspace keeps their access. If your team needs to work together through the same assistants today, ask us about a Bespoke Assistant.'),
       updated_at = now()
 WHERE title = 'Business Information and Products & Services'
   AND content_md LIKE '%Invite colleagues by email and choose a role%'
RETURNING title, 'team members updated' AS result;

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         '| Any assistant | Set your first goal, invite a teammate, and set your hourly rate |',
         '| Any assistant | Set your first goal and your hourly rate |'),
       updated_at = now()
 WHERE title = 'Your Setup Guide'
   AND content_md LIKE '%Set your first goal, invite a teammate, and set your hourly rate%'
RETURNING title, 'setup guide updated' AS result;

COMMIT;
