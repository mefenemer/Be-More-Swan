-- The edit list: what the user did to their footage, before any platform was involved.
-- Drizzle mirror: db/schema.ts::scheduledPosts.videoEdit. Model: src/lib/video-edit.ts.
--
-- Shape (times are seconds against the SOURCE clip, half-open [inS, outS), absent bounds meaning
-- the clip's own edge — the same convention image_overlays and audio_overlays already use):
--   { clips: [{ id, assetId, inS?, outS?, gain? }], targetRatio?, frames?: { <platform>: {offsetX, offsetY} } }
--
-- assetId points at a content_assets row with asset_type 'video'. Not a foreign key, for the same
-- reason image_overlays isn't: this is a design document, and a deleted asset should leave a
-- repairable post rather than cascade-delete the user's whole cut.
--
-- ── Why this is a column and not scheduled_post_assets ──────────────────────────────────────────
-- That table already orders assets by position and looks like the natural home. It cannot be:
-- attachRenderedVideo() (src/lib/post-render.ts) DELETES every junction row for the post and
-- inserts the rendered file at position 0. Correct while a post has one source clip and one
-- rendered output; destructive the moment the junction table IS the edit, because the first
-- successful render would destroy the edit that produced it. The junction table keeps meaning
-- "what publishes"; this column means "what the user assembled".
--
-- ── What honours it today ───────────────────────────────────────────────────────────────────────
-- Phase 1 renders clips[0] and its in/out points only. The rest of the shape (the full array,
-- targetRatio, frames) is stored faithfully and ignored until phases 2-4. See docs/video-editing-plan.md.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push), to BOTH
-- staging and prod BEFORE the code that selects it ships — db.select() names every column, so a
-- missing video_edit breaks the post read path everywhere.

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS video_edit JSONB;
