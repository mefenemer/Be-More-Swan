-- db/newsletter-role-live.sql
-- Go-live flip for the Newsletter Assistant (role_key 'newsletter_editor').
--
-- ⚠️ WHY THIS FILE EXISTS. db/seed-catalog.ts is INSERT-ONLY for master assistants
-- (`onConflictDoNothing({ target: masterAssistants.roleKey })`), so editing `comingSoon: false`
-- there changes nothing on a database where the row already exists — which is every environment we
-- have. The seed edit covers a fresh database; this UPDATE covers the live ones. Same shape as
-- db/assistant-role-titles-rename.sql, which exists for exactly the same reason.
--
-- Idempotent. Apply to staging first, then prod, as the DB owner.

UPDATE master_assistants
   SET coming_soon = false,
       is_active   = true,
       updated_at  = now()
 WHERE role_key = 'newsletter_editor';

-- The catalogue card, the marketing detail page and the hire button all read master_assistants, so
-- re-run the content seed after this to pick up the corrected copy:
--   npx tsx db/seed-assistant-content.ts
--
-- Verify:
--   SELECT role_key, name, coming_soon, is_active FROM master_assistants WHERE role_key = 'newsletter_editor';
