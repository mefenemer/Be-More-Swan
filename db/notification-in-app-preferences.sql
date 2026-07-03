-- Unified Notification Preferences Matrix — in-app channel storage.
--
-- Adds user_profiles.in_app_preferences (jsonb): per-category in-app (notification
-- bell) delivery preferences, mirroring the existing email_preferences column.
--   Shape: Record<string, boolean>  — key = preference category key
--           (see src/utils/notification-prefs.ts: PREF_CATEGORIES).
--   Missing key = category default. Locked categories (account_security,
--   payment_confirmation) are forced true in the application layer.
--
-- Supersedes the legacy notify_wins / notify_billing / notify_availability columns,
-- which are intentionally LEFT IN PLACE (not dropped) for backward compatibility and
-- so the preferences endpoint can seed defaults from notify_availability on first read.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY. This plain ALTER cannot touch RLS;
-- the new column inherits the table's grants + row policies automatically.
-- Idempotent — safe to re-run.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS in_app_preferences jsonb;
