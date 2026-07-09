-- Migration: issue #189 follow-up. PR #204 renamed the catalog template
-- (master_assistants.name) from "The Lead Qualifier" to "The Lead Generator", but
-- ai_assistants.name is copied onto each org's row at hire time (hire-assistant.ts /
-- onboarding.ts) and never re-synced from the template, so already-hired workspace
-- instances kept showing the old name. Idempotent data fix, applied manually.
-- Skips any org that already has a same-named row to respect the
-- ai_assistants_org_name_unique constraint.

UPDATE ai_assistants a
SET name = 'The Lead Generator', updated_at = now()
WHERE a.name = 'The Lead Qualifier'
  AND NOT EXISTS (
    SELECT 1 FROM ai_assistants b
    WHERE b.organisation_id = a.organisation_id
      AND b.name = 'The Lead Generator'
      AND b.id <> a.id
  );
