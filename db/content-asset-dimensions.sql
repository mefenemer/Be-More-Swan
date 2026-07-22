-- db/content-asset-dimensions.sql
--
-- Adds pixel dimensions to content_assets.
--
-- Why: src/components/platform-post-preview.js compares asset.width / asset.height against the
-- platform's recommended aspect ratio. Those properties never existed on the table, so the
-- comparison branch was unreachable and the function always fell through to its "no dimensions"
-- fallback:
--
--     "Recommended aspect ratio for this slot: 1.91:1. Verify your asset before publishing."
--
-- That warning therefore fired on EVERY post with media regardless of whether the asset was
-- correct — it could never say the asset was wrong, and never say it was fine. Users learn to
-- ignore it, which is worse than not showing it.
--
-- With dimensions stored, the preview warns only on a genuine mismatch (>5% off the target ratio),
-- and an "auto-crop to platform ratio" action becomes possible because there is finally something
-- concrete to act on.
--
-- Idempotent. Safe to re-run.
--
-- Apply manually (this repo does not auto-run db/*.sql — see docs/db-migrations.md):
--   psql "$NETLIFY_DATABASE_URL" -f db/content-asset-dimensions.sql

ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS width  integer;
ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS height integer;

COMMENT ON COLUMN content_assets.width  IS
  'Pixel width. NULL for links, audio, and legacy rows uploaded before this column existed.';
COMMENT ON COLUMN content_assets.height IS
  'Pixel height. NULL for links, audio, and legacy rows uploaded before this column existed.';

-- No backfill: dimensions cannot be recovered from the database alone (they would require
-- re-fetching every stored object). Legacy rows keep NULL and continue to show the generic
-- reminder, which is the correct behaviour for "we genuinely do not know". New assets get real
-- dimensions from the upload/generation path and are checked properly.
