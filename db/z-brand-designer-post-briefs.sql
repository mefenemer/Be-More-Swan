-- db/z-brand-designer-post-briefs.sql — a social post with no picture raises a brief for the Brand
-- Designer. docs/brand-designer-plan.md §6 step 5. Code: src/utils/brief-post-media.ts.
-- Drizzle mirror: db/schema.ts (visualBriefs).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-brand-designer-post-briefs                              (staging)
--   npm run db:migrate:apply -- --only z-brand-designer-post-briefs --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER: visual_briefs is read with a bare db.select() — code before DDL breaks the Briefs tab.
--
-- scheduled_post_id: the draft this brief is finding a picture for. SET NULL: deleting the post must
-- not delete a picture someone may already have approved into the library.
-- origin 'assistant': raised by the Social Media Assistant when every media source came back empty.
-- DROP-then-ADD on a constraint this codebase owns, in one transaction, widened to a SUPERSET.

BEGIN;

ALTER TABLE visual_briefs
  ADD COLUMN IF NOT EXISTS scheduled_post_id INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS visual_briefs_scheduled_post_idx
  ON visual_briefs (scheduled_post_id) WHERE scheduled_post_id IS NOT NULL;

ALTER TABLE visual_briefs DROP CONSTRAINT IF EXISTS visual_briefs_origin_check;
ALTER TABLE visual_briefs ADD CONSTRAINT visual_briefs_origin_check
  CHECK (origin IN ('user', 'chat', 'campaign', 'assistant'));

COMMIT;
