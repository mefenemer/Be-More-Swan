-- US-CAL-5.1: Add quality_review jsonb column to scheduled_posts
-- Apply as DB owner (not app role) — idempotent

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS quality_review jsonb;
