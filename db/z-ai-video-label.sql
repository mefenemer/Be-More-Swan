-- db/z-ai-video-label.sql — the "Made with AI" caption line for realistic AI video (owner, 2026-11-11).
-- Code: src/utils/ai-disclosure.ts (aiVideoLabelFor), the publishers (publish-social-posts, publish-facebook,
-- publish-instagram), netlify/functions/ai-video-label.ts, user-settings.html. Drizzle mirror: db/schema.ts.
--
-- ⚠️ APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys: every query that reads a
-- whole organisations row selects the new column. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-ai-video-label                              (staging)
--   npm run db:migrate:apply -- --only z-ai-video-label --url-var DATABASE_URL_PROD  (prod)
--
-- ai_video_label_enabled — add "Made with AI" to the caption of a post whose video contains realistic AI
--                          footage, when it publishes. On by default; the workspace can turn it off.

BEGIN;

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS ai_video_label_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;
