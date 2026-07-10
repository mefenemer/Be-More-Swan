-- Autopilot "publish" mode — unattended-publish marker on scheduled_posts.
-- Drizzle mirror: db/schema.ts::scheduledPosts.autoPublishedAt.
--
-- Set (to now()) at the moment a draft is promoted straight to status='scheduled' without a human
-- ever approving it — see src/utils/publish-policy.ts + src/utils/auto-publish-runtime.ts. It stays
-- NULL for every human-approved post and for every draft still sitting in the review queue.
--
-- Two jobs:
--   1. Counter for the rolling-7-day unattended-publish ceiling (the runaway guard). The ceiling is
--      derived from the assistant's posting schedule, never user-configurable — a cap a user can
--      raise is a cap that gets raised the first time it fires.
--   2. Audit marker: "this post went live without anyone looking at it."
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS auto_published_at TIMESTAMP;

-- The cap query is "count posts for this assistant with auto_published_at inside the last 7 days",
-- run once per candidate draft on every cron tick, so keep it cheap. Partial index: the column is
-- NULL for the overwhelming majority of rows.
CREATE INDEX IF NOT EXISTS scheduled_posts_auto_published_at_idx
  ON scheduled_posts (assistant_id, auto_published_at)
  WHERE auto_published_at IS NOT NULL;

COMMENT ON COLUMN scheduled_posts.auto_published_at IS
  'When Autopilot scheduled this post without human review. NULL = a human approved it, or it is still awaiting review.';
