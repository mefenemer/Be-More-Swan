-- The chosen post FORMAT for a scheduled post — 'ig_reel', 'ig_carousel', 'li_document', 'x_poll'…
-- Catalogue: src/config/post-formats.ts. Drizzle mirror: db/schema.ts::scheduledPosts.formatKey.
--
-- Why a new column and not scheduled_posts.post_format: that one is a loose media descriptor
-- ('text'|'image'|'video'|'reel') that publishers already branch on — publish-instagram.ts tests it
-- for 'reel'|'video' to decide REELS vs IMAGE — so pushing 29 catalogue keys into it would change
-- publish behaviour everywhere it is read. The two coexist: post_format keeps describing the media,
-- format_key records what the user actually chose to publish.
--
-- NULL = a post created before the catalogue existed. Those remain schedulable and publish exactly
-- as they always have (see formatSchedulable() — a null key is never blocked).
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push).

ALTER TABLE scheduled_posts
  ADD COLUMN IF NOT EXISTS format_key TEXT;

-- Only ever filtered alongside organisation_id/status, which the existing queue indexes already
-- cover, so no index here: it would be written on every draft and read by nothing on its own.
