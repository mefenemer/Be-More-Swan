-- db/blog-autopilot.sql
-- Blog Autopilot: give the Blog Writer the same scheduled-drafting engine the Social Media
-- Manager has had since US-SMM-2.4.1, so long-form drafts land in the Blogs tab on a cadence
-- instead of every post starting from a manual click.
--
-- content_generation_jobs was built social-shaped: result_post_id means scheduled_posts.id and
-- nothing distinguished one kind of job from another, because there was only ever one kind.
-- Autopilot for blogs adds a second, so the table needs a discriminator and its own result FK:
--
--   content_type         — 'social' (existing behaviour, the default so every historical row and
--                          every current enqueuer stays correct without a backfill) | 'blog'.
--   result_blog_post_id  — blog_posts.id once the job produces a draft, mirroring result_post_id.
--                          Deliberately NOT a foreign key, matching result_post_id, which is a bare
--                          integer: a job row is an audit record and must survive its post being
--                          deleted. blog_posts.job_id already points the other way and predates this.
--
-- The rest of the config needs no migration: the publishing cadence reuses the same
-- ai_assistants.onboarding_context (jsonb) keys as the social schedule — posting_frequency,
-- posting_days, posting_times, posting_timezone — and the horizon reuses
-- ai_assistants.draft_horizon_days.
--
-- Purely additive and idempotent — safe to run repeatedly.
-- Apply manually as the table owner (no drizzle-kit push — see project convention).

ALTER TABLE content_generation_jobs
  ADD COLUMN IF NOT EXISTS content_type text NOT NULL DEFAULT 'social';

ALTER TABLE content_generation_jobs
  ADD COLUMN IF NOT EXISTS result_blog_post_id integer;

-- Guard the discriminator the same way blog_posts guards its status.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_jobs_content_type_check'
  ) THEN
    ALTER TABLE content_generation_jobs
      ADD CONSTRAINT content_jobs_content_type_check
      CHECK (content_type IN ('social', 'blog'));
  END IF;
END $$;

-- blog-horizon-fill's coverage query filters queued/processing jobs by assistant AND content_type;
-- without this it degrades to a scan of every job the assistant has ever produced.
CREATE INDEX IF NOT EXISTS content_jobs_type_status_idx
  ON content_generation_jobs (content_type, status, assistant_id);
