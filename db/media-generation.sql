-- AI Media Generation jobs (Epic 1, US1/US2) + content_assets generation metadata.
--
-- media_generation_jobs: one row per image/video generation request. Images complete quickly
-- (the request function polls Fal synchronously); video is asynchronous — the request enqueues
-- a job and a background worker polls Fal then downloads the mp4 into R2 (US2 async workflow).
--
-- content_assets gains prompt/aspect_ratio/generation_job_id so AI-generated assets (provider
-- 'fal') power the "My AI Uploads" library with prompt memory (US3).
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS media_generation_jobs (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assistant_id      INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,  -- set for autonomous (US5)

  media_type        TEXT NOT NULL,                       -- 'image' | 'video'
  prompt            TEXT NOT NULL,
  aspect_ratio      TEXT NOT NULL,                        -- '1:1' | '16:9' | '9:16' | '4:5'
  duration_seconds  INTEGER,                              -- video only
  model             TEXT NOT NULL,                        -- resolved Fal model id
  credit_cost       INTEGER NOT NULL,                     -- credits held/charged for this job
  is_autonomous     BOOLEAN NOT NULL DEFAULT false,

  status            TEXT NOT NULL DEFAULT 'queued',       -- queued|processing|completed|failed|flagged
  fal_request_id    TEXT,
  fal_status_url    TEXT,
  fal_response_url  TEXT,
  candidates        JSONB DEFAULT '[]'::jsonb,            -- ephemeral Fal result URLs (image grid) pending selection
  result_asset_ids  JSONB DEFAULT '[]'::jsonb,            -- content_assets.id[] persisted to R2
  error_message     TEXT,

  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT media_generation_jobs_media_type_check CHECK (media_type IN ('image', 'video')),
  CONSTRAINT media_generation_jobs_status_check     CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'flagged')),
  CONSTRAINT media_generation_jobs_aspect_check      CHECK (aspect_ratio IN ('1:1', '16:9', '9:16', '4:5'))
);

CREATE INDEX IF NOT EXISTS media_generation_jobs_org_idx    ON media_generation_jobs (organisation_id);
CREATE INDEX IF NOT EXISTS media_generation_jobs_status_idx ON media_generation_jobs (status);

-- content_assets: AI-generation metadata (idempotent column adds).
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS prompt            TEXT;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS aspect_ratio      TEXT;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS generation_job_id INTEGER;
