-- db/z-video-producer-studio.sql — the Video Producer as a studio (2026-11-09).
-- Plan: docs/video-producer-studio-plan.md (Phase 1). Code: src/utils/video-producer.ts (buildProject),
-- netlify/functions/render-video-project-background.ts, netlify/functions/video-projects.ts.
-- Drizzle mirror: db/schema.ts (videoProjects).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys
-- (every project read selects the new columns). Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-producer-studio                              (staging)
--   npm run db:migrate:apply -- --only z-video-producer-studio --url-var DATABASE_URL_PROD  (prod)
--
-- A finished video is no longer a post. The build saves the TIMELINE on the project and a render of the
-- project (not of a post) saves the MP4 to My Content:
--   … building → rendering → ready            (output_asset_id = the finished video)
--                          ↘ render_failed    ("Try the render again" on the Videos tab)
-- Projects already 'built' keep their posts and are left exactly as they are.
-- `version` and `parent_project_id` are for "Change it" (Phase 3): a change is a new project, version + 1.

BEGIN;

ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS timeline          JSONB;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS output_asset_id   INTEGER REFERENCES content_assets(id) ON DELETE SET NULL;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS version           INTEGER NOT NULL DEFAULT 1;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS parent_project_id INTEGER REFERENCES video_projects(id) ON DELETE SET NULL;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS render_id         TEXT;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS render_bucket     TEXT;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS render_region     TEXT;

ALTER TABLE video_projects DROP CONSTRAINT IF EXISTS video_projects_status_check;
ALTER TABLE video_projects ADD CONSTRAINT video_projects_status_check
    CHECK (status IN ('draft', 'reviewing', 'reviewed', 'planning', 'planned', 'building', 'rendering', 'ready',
                      'render_failed', 'built', 'failed', 'cancelled', 'archived'));

COMMIT;
