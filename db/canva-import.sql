-- Canva import jobs (Canva connector, US3).
--
-- One row per Canva design being imported into the Content Library. Import is asynchronous
-- because Canva's export API is itself a job: POST /rest/v1/exports returns an export id that
-- must be polled until the download URLs appear. A background worker (canva-import-background)
-- drives export → poll → download → R2 → content_assets, and the browse modal polls
-- canva-import-status for progress against these rows.
--
-- A multi-page design (e.g. a presentation) exports one image per page, so a single job row can
-- produce several content_assets rows — hence result_asset_ids is an array, not a single id.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS canva_import_jobs (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,

  design_id         TEXT NOT NULL,                        -- Canva design id being exported
  design_title      TEXT,                                 -- title at selection time (names the assets)
  design_type       TEXT,                                 -- Canva design_type, decides mp4 vs png export
  export_job_id     TEXT,                                 -- Canva export job id, set once created

  status            TEXT NOT NULL DEFAULT 'queued',       -- queued|processing|completed|failed
  result_asset_ids  JSONB DEFAULT '[]'::jsonb,            -- content_assets.id[] persisted to R2
  error_message     TEXT,

  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT canva_import_jobs_status_check CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS canva_import_jobs_org_idx    ON canva_import_jobs (organisation_id);
CREATE INDEX IF NOT EXISTS canva_import_jobs_status_idx ON canva_import_jobs (status);
