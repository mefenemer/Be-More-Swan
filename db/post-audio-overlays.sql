-- Timed audio on a post — voice notes and sound.
-- Drizzle mirror: db/schema.ts::scheduledPosts.audioOverlays. Model: src/lib/audio-overlays.ts.
--
-- Shape (mirrors image_overlays, deliberately — a clip with no bounds IS "the whole post", exactly
-- as a text box with no startS/endS is always visible):
--   [{ id, assetId, label?, startS?, endS?, volume, fadeInS, fadeOutS }]
--
-- assetId points at a content_assets row with asset_type 'audio', stored in R2. Not a foreign key
-- for the same reason image_overlays isn't: this is a design document, and a deleted asset should
-- leave a repairable post rather than cascade-delete the user's whole audio arrangement.
--
-- Consequence worth knowing: ANY audio forces a server-side Remotion render, including on a photo
-- post. No platform accepts a still image with sound, so the only way to publish one is to render
-- the image and the audio together into an mp4 — which turns a photo post into a video post at
-- approval time. See needsVideoRender() in src/lib/audio-overlays.ts.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS audio_overlays JSONB;
