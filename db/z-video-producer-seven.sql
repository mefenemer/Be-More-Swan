-- db/z-video-producer-seven.sql — seven Video Producer improvements (2026-11-10).
-- Code: src/utils/video-producer.ts, netlify/functions/video-projects.ts, src/components/assistant-videos.js.
-- Drizzle mirror: db/schema.ts (videoProjects).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys
-- (every project read selects the new columns). Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-producer-seven                              (staging)
--   npm run db:migrate:apply -- --only z-video-producer-seven --url-var DATABASE_URL_PROD  (prod)
--
-- moment_notes  — notes left on a moment of a Ready video ([{ id, atS, sceneId, text, by, at }]); "Make a
--                 new version from my notes" turns them into scene edits on the next version.
-- edit_count    — how many times the owner changed the storyboard before it was made (scene edits, plan
--                 again, script rewrites). The Results tab's "Made without changes" reads it.

BEGIN;

ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS moment_notes JSONB   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS edit_count   INTEGER NOT NULL DEFAULT 0;

COMMIT;
