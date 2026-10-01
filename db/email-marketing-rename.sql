-- db/email-marketing-rename.sql
-- The Newsletter Assistant becomes the EMAIL MARKETING ASSISTANT, and an "issue" becomes an
-- "email" (decided 2026-10-01). The role now writes multi-email campaigns as well as one-off sends,
-- so "newsletter" undersold it and "issue" was jargon most customers had to translate.
--
-- ⚠️ DISPLAY TEXT ONLY. role_key stays 'newsletter_editor' and every table stays newsletter_* —
-- role_key is the join key across ai_assistants.configuration->>'type', cron role lists and
-- onboarding schemas (master Data form treats it as create-only), and nobody sees a table name.
--
-- Keyed on role_key, never on the current name (same reason as assistant-role-titles-rename.sql:
-- master_assistants.name is admin-editable and may have drifted). Idempotent: every statement is a
-- no-op the second time.

BEGIN;

-- 1. The catalogue / role title, and the copy that says "issue".
UPDATE master_assistants
   SET name         = 'Email Marketing Assistant',
       description  = REPLACE(description, 'every issue', 'every email'),
       key_features = REPLACE(key_features::text, 'You Approve Every Issue', 'You Approve Every Email')::jsonb,
       updated_at   = now()
 WHERE role_key = 'newsletter_editor'
   AND (name IS DISTINCT FROM 'Email Marketing Assistant'
        OR description LIKE '%every issue%'
        OR key_features::text LIKE '%You Approve Every Issue%');

-- 2. Customers' own assistants — ONLY the ones still carrying the untouched default name.
--    Anybody who named theirs ("Nora", "Wren") keeps that name; it is theirs, not ours.
UPDATE ai_assistants AS a
   SET name = 'Email Marketing Assistant', updated_at = now()
  FROM master_assistants AS m
 WHERE a.master_assistant_id = m.id
   AND m.role_key = 'newsletter_editor'
   AND a.name = 'Newsletter Assistant';

UPDATE ai_assistants
   SET name = 'Email Marketing Assistant', updated_at = now()
 WHERE configuration->>'type' = 'newsletter_editor'
   AND name = 'Newsletter Assistant';

-- The hire-time job-role snapshot. The app coalesces master_assistants.name over it, but a stale
-- snapshot still surfaces anywhere that reads the column directly.
UPDATE ai_assistants AS a
   SET ai_assistant_job_role = 'Email Marketing Assistant', updated_at = now()
  FROM master_assistants AS m
 WHERE a.master_assistant_id = m.id
   AND m.role_key = 'newsletter_editor'
   AND a.ai_assistant_job_role = 'Newsletter Assistant';

-- 3. Admin-edited notification copy. A notification_templates row exists only once an admin has
--    edited a template (the code catalog is the default), so this usually touches nothing.
-- ⚠️ EXACT PHRASES, never a bare REPLACE of 'issue': the copy carries merge tags like
-- {{issue.subject}}, and rewriting those to {{email.subject}} would render them blank.
UPDATE notification_templates
   SET title      = REPLACE(title, 'New newsletter draft', 'New email draft'),
       message    = REPLACE(REPLACE(message, 'your next issue', 'your next email'), 'Your issue went out', 'Your email went out'),
       updated_at = now()
 WHERE template_key IN ('newsletter_issue_ready', 'newsletter_issue_sent')
   AND (title LIKE '%New newsletter draft%' OR message LIKE '%your next issue%' OR message LIKE '%Your issue went out%');

COMMIT;

-- Verify:
--   SELECT role_key, name, description, key_features FROM master_assistants WHERE role_key = 'newsletter_editor';
--   SELECT a.id, a.name, a.ai_assistant_job_role FROM ai_assistants a
--     JOIN master_assistants m ON m.id = a.master_assistant_id WHERE m.role_key = 'newsletter_editor';
