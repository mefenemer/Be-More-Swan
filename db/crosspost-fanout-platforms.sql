-- db/crosspost-fanout-platforms.sql
-- One-idea cross-post fan-out. Autopilot used to enqueue one content_generation_job PER platform per
-- slot, so each platform got an independently-written caption (individual per-platform posts). We now
-- enqueue ONE job per slot that carries the connected-platform list; process-content-jobs generates a
-- single caption + media and creates one scheduled_posts row per platform, all sharing the job's
-- crosspost_group_id so the Review Queue shows one card the human can preview/edit per platform.
--
-- One nullable jsonb column on content_generation_jobs:
--   platforms — array of platform names (e.g. ["instagram","facebook","linkedin"]) to fan the one
--               generated idea across. NULL/empty ⇒ legacy single-platform job (uses `platform`).
--
-- Purely additive and idempotent — safe to run repeatedly. Depends on db/crosspost-group-id.sql
-- (crosspost_group_id) already being applied.
-- Apply manually as the table owner (no drizzle-kit push — see project convention).

ALTER TABLE content_generation_jobs
  ADD COLUMN IF NOT EXISTS platforms jsonb;
