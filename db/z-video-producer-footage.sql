-- db/z-video-producer-footage.sql — the Video Producer reviews your own footage (2026-11-09).
-- Plan: docs/video-producer-footage-and-ai-plan.md §4 (Phases 1–4).
-- Code: src/lib/footage.ts, src/utils/footage-review.ts, netlify/functions/footage.ts,
--       netlify/functions/video-projects.ts, src/components/footage-reader.js.
-- Drizzle mirror: db/schema.ts (footageAnalyses, videoProjects.footageReview).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys
-- (the code selects video_projects.footage_review on every project read).
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-producer-footage                              (staging)
--   npm run db:migrate:apply -- --only z-video-producer-footage --url-var DATABASE_URL_PROD  (prod)
--
-- ── footage_analyses ────────────────────────────────────────────────────────
-- What the Video Producer understood of ONE of the workspace's own videos, made once per video:
--   prepared  — the browser read it: measured length and size, frames (a JSON file in R2), and the
--               sound as a small WAV (R2), or none when the video has no sound
--   done      — transcribed and turned into a shot list (`analysis`) with spoken words (`words`)
--   failed    — `error` says why, in words the owner can act on
-- Re-preparing a video (a new upload of frames) resets it to 'prepared'.
--
-- ── video_projects ──────────────────────────────────────────────────────────
-- Two new statuses before planning, for a video made from the owner's own footage:
--   reviewing → reviewed (the owner ticks the suggested edits) → planning → planned → …
-- `footage_review` holds what was seen and the suggestions, with the owner's ticks.

BEGIN;

CREATE TABLE IF NOT EXISTS footage_analyses (
    asset_id         INTEGER PRIMARY KEY REFERENCES content_assets(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    status           TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'done', 'failed')),
    duration_s       REAL NOT NULL,
    width            INTEGER,
    height           INTEGER,
    frames_key       TEXT NOT NULL,
    frame_count      INTEGER NOT NULL DEFAULT 0,
    audio_key        TEXT,
    analysis         JSONB,
    words            JSONB NOT NULL DEFAULT '[]'::jsonb,
    error            TEXT,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS footage_analyses_org_idx ON footage_analyses (organisation_id);

ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS footage_review JSONB;

ALTER TABLE video_projects DROP CONSTRAINT IF EXISTS video_projects_status_check;
ALTER TABLE video_projects ADD CONSTRAINT video_projects_status_check
    CHECK (status IN ('draft', 'reviewing', 'reviewed', 'planning', 'planned', 'building', 'built', 'failed', 'cancelled'));

-- No RLS, like video_projects: every read and write is scoped by organisation_id in code.

COMMIT;
