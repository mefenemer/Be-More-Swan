-- Rename the Minute Taker role to "Note Taker" (owner decision, docs/meeting-note-taker-finish-plan.md
-- decision 9: "Minute Taker" reads formal or old-fashioned outside Britain; "Note Taker" is a job title like
-- the other assistants and close to the feature request's "Meeting Note Taker"). Done before go-live so the
-- launch copy uses the final name.
--
-- Same rules as db/assistant-role-titles-rename.sql: keyed on role_key, and ONLY master_assistants.name.
-- Deliberately NOT touched:
--   * ai_assistants.name                  — the user's own name for their assistant ("Orbit Scribe").
--   * ai_assistants.ai_assistant_job_role — a hire-time snapshot; the app shows master_assistants.name over it.
--   * ai_assistants.disclosure_text       — the customer's own words.
-- Safe to run more than once. Run on BOTH databases (staging and production).

BEGIN;

UPDATE master_assistants
SET name = 'Note Taker', updated_at = now()
WHERE role_key = 'meeting_note_taker'
  AND name IS DISTINCT FROM 'Note Taker';

COMMIT;

-- Verify — expect one row reading 'Note Taker':
--   SELECT role_key, name FROM master_assistants WHERE role_key = 'meeting_note_taker';
