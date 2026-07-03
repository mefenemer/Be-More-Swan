-- Dynamic Communications Engine — Omni-Channel Routing & Offline Fallbacks (Phase 3, US4).
-- Adds:
--   delivered_at            ts — when the notification was generated (AC4.1). DB-default now()
--                                for future inserts; backfilled from created_at for existing rows.
--   fallback_email_sent_at  ts — set by the email-fallback worker once it has emailed the user,
--                                so an unseen urgent notification is emailed at most once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- Idempotent — safe to re-run.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivered_at           timestamp;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS fallback_email_sent_at timestamp;

-- Backfill delivered_at for existing rows, then default it for all future inserts.
UPDATE notifications SET delivered_at = created_at WHERE delivered_at IS NULL;
ALTER TABLE notifications ALTER COLUMN delivered_at SET DEFAULT now();

-- Worker sweep predicate hits this every 15 min — index the unsent, undelivered-long-ago rows.
CREATE INDEX IF NOT EXISTS notifications_fallback_idx
  ON notifications (delivered_at)
  WHERE fallback_email_sent_at IS NULL AND is_read = false AND resolved_at IS NULL;
