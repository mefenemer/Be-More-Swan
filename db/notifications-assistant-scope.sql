-- Per-assistant notification preferences — assistant attribution + override storage.
--
--   notifications.assistant_id          int  — which assistant produced the row (NULL = account-level)
--   user_profiles.assistant_notif_prefs jsonb — per-assistant overrides of the preference matrix:
--       { [assistantId]: { [categoryKey]: { inApp?: bool, email?: bool } } }
--       Missing key at any level = use the workspace-wide preference.
--       Resolution logic lives in src/utils/notification-prefs.ts (isInAppEnabledFor/isEmailEnabledFor).
--
-- assistant_id is stamped by a BEFORE INSERT trigger from metadata->>'assistantId', so the
-- ~60 code insert sites don't each need editing (same pattern as notifications-categorization.sql).
-- Insert sites for assistant-work types include assistantId in metadata.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can propose
-- DISABLE ROW LEVEL SECURITY / DROP POLICY. These plain ALTERs cannot touch RLS; new columns
-- inherit the table's grants + row policies automatically. Idempotent — safe to re-run.

-- 1. Columns ------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS assistant_id integer;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS assistant_notif_prefs jsonb;

-- FK: keep the notification if the assistant is deleted, just drop the attribution
-- (the row falls back to workspace-wide preference gating).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_assistant_id_fkey') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_assistant_id_fkey
      FOREIGN KEY (assistant_id) REFERENCES ai_assistants(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. BEFORE INSERT trigger: stamp assistant_id from metadata when not explicitly set.
--    Tolerates both camelCase and snake_case metadata keys and non-numeric junk.
CREATE OR REPLACE FUNCTION notifications_stamp_assistant()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  raw text;
BEGIN
  IF NEW.assistant_id IS NULL AND NEW.metadata IS NOT NULL THEN
    raw := COALESCE(NEW.metadata->>'assistantId', NEW.metadata->>'assistant_id');
    IF raw ~ '^\d+$' THEN
      -- Only stamp ids that actually exist, so the FK can't reject the insert.
      SELECT id INTO NEW.assistant_id FROM ai_assistants WHERE id = raw::integer;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notifications_stamp_assistant ON notifications;
CREATE TRIGGER trg_notifications_stamp_assistant
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_stamp_assistant();

-- 3. Backfill existing rows that already carry an assistant id in metadata.
UPDATE notifications n
SET assistant_id = (COALESCE(n.metadata->>'assistantId', n.metadata->>'assistant_id'))::integer
WHERE n.assistant_id IS NULL
  AND COALESCE(n.metadata->>'assistantId', n.metadata->>'assistant_id') ~ '^\d+$'
  AND EXISTS (
    SELECT 1 FROM ai_assistants a
    WHERE a.id = (COALESCE(n.metadata->>'assistantId', n.metadata->>'assistant_id'))::integer
  );
