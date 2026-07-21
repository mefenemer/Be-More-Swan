-- db/crosspost-group-id.sql
-- Cross-post grouping fix: give a fanned-out cross-post a durable, shared identity so the Review
-- Queue can collapse "one card per platform" into a single card WITHOUT ever merging unrelated posts.
--
-- Background: the Review Queue previously grouped per-platform siblings by (assistant, publish slot,
-- status). That slot is a scheduling attribute, not an identity — two independent posts that happen
-- to share a publish slot (e.g. two Autopilot jobs targeting the same time, or a batch of on-demand
-- jobs that all default to "now + 24h") collapsed into one card. This adds a real fan-out id.
--
-- Two nullable text (uuid) columns:
--   scheduled_posts.crosspost_group_id        — every sibling of one logical post shares this uuid,
--                                                stamped at fan-out (create-manual-post /
--                                                chat-orchestrator / process-content-jobs).
--   content_generation_jobs.crosspost_group_id — Autopilot enqueues one job per platform for a shared
--                                                slot; all jobs for that slot carry the same uuid so
--                                                process-content-jobs stamps the resulting posts as
--                                                siblings.
--
-- NULL means "standalone / legacy" — such rows never group with anything (the Review Queue keys them
-- by their own id), so this migration is safe with no backfill: existing cross-posts simply show as
-- one card per platform until they age out of the queue.
--
-- Purely additive and idempotent — safe to run repeatedly.
-- Apply manually as the table owner (no drizzle-kit push — see project convention).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS crosspost_group_id text;

ALTER TABLE content_generation_jobs
  ADD COLUMN IF NOT EXISTS crosspost_group_id text;

-- Grouping lookups are per (group, status) within a lifecycle column; a partial index keeps the
-- non-null rows (the only ones that ever group) cheap to scan.
CREATE INDEX IF NOT EXISTS scheduled_posts_crosspost_group_idx
  ON scheduled_posts (crosspost_group_id)
  WHERE crosspost_group_id IS NOT NULL;
