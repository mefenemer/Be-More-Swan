-- Post image text overlays — user-authored text layers composited onto a post's image.
-- Drizzle mirror: db/schema.ts::scheduledPosts (image_overlays, overlay_base_asset_id).
--
-- image_overlays: the EDITABLE design (array of overlay objects), kept so the user can reopen the
--   editor and re-arrange/re-style. Each element:
--     { id, text, x, y, fontFamily, fontSizePct, color,
--       boxStroke (hex|null), boxFill (hex|null), boxOpacity (0..1) }
--   x/y are 0..1 relative to image width/height (centre of the text box) so they survive any
--   resolution scaling between the on-screen editor and the native-resolution bake.
--
-- overlay_base_asset_id: the ORIGINAL (pre-bake) image asset. The overlays are flattened into a NEW
--   image at approval time and the post is pointed at that flattened asset; this column preserves the
--   clean base so a later edit composites onto the original, never onto an already-baked image.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS image_overlays        JSONB,
  ADD COLUMN IF NOT EXISTS overlay_base_asset_id INTEGER REFERENCES content_assets(id) ON DELETE SET NULL;
