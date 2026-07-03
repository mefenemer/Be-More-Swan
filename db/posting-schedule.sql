-- db/posting-schedule.sql
-- Posting Schedule (US-SMM-2.4.x follow-up): let an assistant's generation jobs carry the exact
-- calendar slot they are meant to fill, so the draft-horizon scheduler can space generated posts
-- across the user's chosen frequency / days / times instead of every draft landing at "now + 24h".
--
-- The rest of the posting-schedule config (posting_frequency, posting_days, posting_times,
-- posting_timezone) lives in ai_assistants.onboarding_context (jsonb) and needs no migration.
-- Draft horizon already has its own column (ai_assistants.draft_horizon_days).
--
-- This adds a single nullable column to content_generation_jobs:
--   target_publish_date — when set, process-content-jobs.ts stamps the resulting scheduled_post
--                         with this publish_date (falls back to now + 24h when null, preserving
--                         the existing behaviour for on-demand / admin-test / conversion jobs).
--
-- Purely additive and idempotent — safe to run repeatedly.
-- Apply manually as the table owner (no drizzle-kit push — see project convention).

ALTER TABLE content_generation_jobs
  ADD COLUMN IF NOT EXISTS target_publish_date timestamp;
