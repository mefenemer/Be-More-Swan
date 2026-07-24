-- Phase 4 — server-side video overlay render (Remotion Lambda).
-- Drizzle mirror: db/schema.ts::postRenderJobs, and scheduled_posts.render_status.
--
-- A video post with timed text overlays can't be baked in the browser (no client video encoder), so
-- on approval a render job is queued and processed by Remotion Lambda: renderMediaOnLambda →
-- getRenderProgress (polled) → the S3 output is copied to R2 as a content asset → attached to the
-- post. scheduled_posts.render_status gates publishing so the post never goes out before the overlaid
-- video is ready.
--
-- render_status values:
--   NULL        nothing to render (a photo, or a video with no overlays)
--   'pending'   approved; a render is queued
--   'rendering' Remotion is rendering
--   'done'      the overlaid video is attached; publishing may proceed
--   'failed'    the render errored (surfaced to the reviewer; publishing stays gated)
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS render_status TEXT;

CREATE TABLE IF NOT EXISTS post_render_jobs (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  post_id         INTEGER NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'queued',   -- queued | rendering | completed | failed
  render_input    JSONB,                            -- { width, height, fps, durationInFrames } snapshot
  render_id       TEXT,                             -- Remotion Lambda render id
  bucket_name     TEXT,                             -- Remotion's S3 bucket for this render
  region          TEXT,                             -- AWS region the render ran in
  output_asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL,  -- rendered video, persisted to R2
  error_message   TEXT,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_render_jobs_org_idx    ON post_render_jobs (organisation_id);
CREATE INDEX IF NOT EXISTS post_render_jobs_post_idx   ON post_render_jobs (post_id);
CREATE INDEX IF NOT EXISTS post_render_jobs_status_idx ON post_render_jobs (status);
