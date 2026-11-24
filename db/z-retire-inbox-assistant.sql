-- db/z-retire-inbox-assistant.sql — Fix pipeline #60 (owner, 2026-11-15): the Email Assistant (email_assistant)
-- supersedes the Inbox Assistant, so its "Coming soon" card leaves the Hire catalogue.
-- Not additive (an UPDATE), so the owner runs it by hand on BOTH databases. Safe to run more than once.
-- Checked 2026-11-24 on prod: master_assistants id 1, role_key 'inbox_manager', coming_soon true, 0 hired.
-- The seeds (db/seed-catalog.ts, seed/data/master_assistants.json) now say isActive false too, but they insert
-- only missing rows (onConflictDoNothing), so they never change an existing row: this is what retires it.
-- To undo: the same statement with is_active = true.

UPDATE master_assistants
   SET is_active = false, updated_at = now()
 WHERE role_key = 'inbox_manager'
   AND is_active = true
   AND NOT EXISTS (SELECT 1 FROM ai_assistants a WHERE a.master_assistant_id = master_assistants.id AND a.archived_at IS NULL);

-- Check: should return is_active = false.
SELECT id, role_key, name, is_active, coming_soon FROM master_assistants WHERE role_key = 'inbox_manager';
