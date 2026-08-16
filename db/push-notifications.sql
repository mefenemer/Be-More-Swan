-- db/push-notifications.sql
-- Web Push (PWA) as a third notification channel alongside in-app and email.
--
-- The point of this channel: a Service Worker + Web Push gives native-feeling lock-screen alerts on
-- Android AND iOS with no App Store presence. iOS 16.4+ supports it, but ONLY for a PWA the user has
-- added to the Home Screen — Safari tabs get nothing. src/public/push-client.js detects that case
-- and says so rather than silently failing, which is the trap this feature dies in otherwise.
--
-- Idempotent. Apply to staging first, then prod. Safe to run BEFORE the code ships: nothing reads
-- either object until the deploy, and the send path treats a missing table as "no subscribers".

-- ── 1. One row per browser/device a user has granted permission on ──────────────────────────────
-- Deliberately NOT one row per user: the same person legitimately subscribes from a phone, a laptop
-- and a tablet, and each has its own endpoint and its own keys. Delivering to only the most recent
-- would make the feature feel broken on every device but the last one used.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id             serial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The push service URL the browser gave us (fcm.googleapis.com, web.push.apple.com, …).
  -- UNIQUE and the natural key: re-subscribing on the same device returns the same endpoint, so an
  -- upsert on this column is what keeps re-registration from growing a row per page load.
  endpoint       text NOT NULL,
  -- RFC 8291 encryption material. Without both, a payload cannot be encrypted for this subscriber.
  p256dh         text NOT NULL,
  auth           text NOT NULL,
  -- Diagnostic only — which browser/OS this came from, so a "push isn't working" report can be
  -- read without guessing. Never used for routing.
  user_agent     text,
  -- Set when the push service tells us the subscription is dead (404/410). Kept rather than deleted
  -- so "why did this user stop getting alerts" is answerable; the send path skips non-null rows.
  expired_at     timestamp,
  last_success_at timestamp,
  -- Consecutive delivery failures. Reset on success. A row that keeps failing without ever
  -- returning 404/410 (a flaky service, not a dead subscription) is retired at a threshold so it
  -- stops costing a request on every notification forever.
  failure_count  integer NOT NULL DEFAULT 0,
  created_at     timestamp NOT NULL DEFAULT now(),
  updated_at     timestamp NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_endpoint_unique') THEN
    ALTER TABLE push_subscriptions ADD CONSTRAINT push_subscriptions_endpoint_unique UNIQUE (endpoint);
  END IF;
END $$;

-- The read path is "every live subscription for this user", on every notification fan-out.
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions (user_id) WHERE expired_at IS NULL;

-- ── 2. Per-category push preferences ────────────────────────────────────────────────────────────
-- Same shape and same category keys as email_preferences / in_app_preferences
-- (Record<string, boolean>, missing key = the category default in
-- src/utils/notification-prefs.ts). A separate column rather than a nested key inside an existing
-- one, so the three channels stay symmetrical and one channel's write can never clobber another's.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS push_preferences jsonb;

-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'push_subscriptions' ORDER BY ordinal_position;
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'user_profiles' AND column_name = 'push_preferences';
