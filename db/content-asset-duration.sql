-- db/content-asset-duration.sql
--
-- Adds playable duration to content_assets, completing the metric set the composer needs to route
-- an asset to a platform format WITHOUT a browser.
--
-- Why: format is currently a manual choice, and it should be derived — a 9:16 clip under three
-- minutes is a YouTube Short, a 16:9 one is a standard Video, and the same asset is an Instagram
-- Reel either way. Kind and aspect ratio already answer most of that (width/height landed in
-- db/content-asset-dimensions.sql). Duration is the missing third, and it is the one that decides:
--
--   • YouTube  Short vs Video          (Shorts cap at 3 minutes)
--   • X        publishable vs not      (2m20s on the free tier)
--   • Instagram Reel length limits
--
-- Without it the ONLY place that knows how long a video is, is a <video> element in the composer
-- (_pceMediaMetrics in workspace.html). That leaves the autonomous drafters — which run on the
-- server, with no DOM — unable to route at all, and it is why the routing engine could not be
-- built server-side.
--
-- Seconds, not milliseconds: every platform limit is quoted in seconds or minutes, and a real
-- (float) keeps fractional durations honest rather than rounding a 179.6s clip into a Short it
-- would be rejected from.
--
-- Idempotent. Safe to re-run.
--
-- Apply manually (this repo does not auto-run db/*.sql — see docs/db-migrations.md):
--   psql "$NETLIFY_DATABASE_URL" -f db/content-asset-duration.sql

ALTER TABLE content_assets ADD COLUMN IF NOT EXISTS duration_s real;

COMMENT ON COLUMN content_assets.duration_s IS
  'Playable length in seconds. NULL for images, links, and legacy rows uploaded before this column '
  'existed. Populated on upload and backfilled opportunistically by the composer when it measures '
  'an asset whose duration is still unknown.';

-- No bulk backfill: duration cannot be recovered from the database alone — it would mean fetching
-- and decoding every stored object. Legacy rows keep NULL, which every reader must treat as
-- "unknown" rather than "zero"; a router that reads NULL as 0 would classify a 40-minute film as a
-- YouTube Short. The composer backfills a row the first time it plays it (see
-- content-assets.ts PATCH { metrics }), so the gap closes as posts are opened rather than in one
-- expensive sweep.
