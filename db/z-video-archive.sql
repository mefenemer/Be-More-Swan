-- db/z-video-archive.sql — archive videos on the Video Producer's Videos tab (2026-11-10).
-- Code: netlify/functions/video-projects.ts (bulk archive / restore / delete), src/components/assistant-videos.js
-- (the Archived pill and the select boxes), src/utils/video-producer.ts (the chat's list).
-- Drizzle mirror: db/schema.ts (videoProjects.archivedAt).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys
-- (every project read selects the new column). Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-archive                              (staging)
--   npm run db:migrate:apply -- --only z-video-archive --url-var DATABASE_URL_PROD  (prod)
--
-- archived_at — when the owner archived the video. NULL = on the Videos tab as usual. An archived video
--               keeps its status and its finished file in My Content; Restore puts it back.

BEGIN;

ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

COMMIT;
