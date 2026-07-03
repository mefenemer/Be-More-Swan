-- Dynamic Communications Engine — Strict Dismissal Rules (Phase 2, US3).
-- Adds dismissed_at: when a user manually dismisses (swipes/closes) a notification.
-- Distinct from resolved_at (completion criteria met) and is_read (seen). Dismissed rows are
-- hidden from the feed. The application refuses to dismiss non-dismissible (critical_action)
-- items; is_dismissible (from db/notifications-categorization.sql) is the authority.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- Idempotent — safe to re-run.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dismissed_at timestamp;
