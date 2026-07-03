-- Autonomous AI media suggestions (Epic 2 US5) + the "why" note for the AI review queue (Epic 3 US6).
--
-- ai_assistants gains a per-assistant opt-in (autonomous_media_enabled) and a monthly autonomous
-- credit cap (autonomous_media_monthly_cap). A daily cron (autonomous-media-suggestions.ts) drafts
-- posts with AI-generated media into status='pending_approval' (isAutonomous=true) — never published
-- automatically. scheduled_posts.generation_reason holds the human-readable explanation shown on the
-- review card ("Drafted to fill a 3-day gap…").
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).

ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS autonomous_media_enabled      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE ai_assistants ADD COLUMN IF NOT EXISTS autonomous_media_monthly_cap  INTEGER NOT NULL DEFAULT 20;

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS generation_reason TEXT;
