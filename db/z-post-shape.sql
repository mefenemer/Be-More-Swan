-- db/z-post-shape.sql — a shape picked for ONE social post (Top lists, FR#34, docs/top-lists-plan.md).
-- Code: netlify/functions/generate-post.ts (writes it), netlify/functions/process-content-jobs.ts (reads it),
--       src/utils/content-shapes.ts (socialShapeByKey — the keys it may hold).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent.
--   npm run db:migrate:apply -- --only z-post-shape.sql                              (staging)
--   npm run db:migrate:apply -- --only z-post-shape.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Safe in EITHER order with the code: the drainer reads it through to_jsonb (a missing column reads
-- as null = the normal rotation), and generate-post writes it in a separate, best-effort UPDATE, so
-- until this runs a picked shape is simply ignored and the post is drafted as usual.
-- Deliberately NOT in db/schema.ts: Drizzle names every table column in its INSERTs, so a schema
-- column ahead of this SQL would break every job insert.
--
-- post_shape: a SOCIAL_POST_SHAPES key ('list', 'story', 'opinion'…), or NULL for the rotation.

ALTER TABLE content_generation_jobs ADD COLUMN IF NOT EXISTS post_shape TEXT;
