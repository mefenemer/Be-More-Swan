-- db/z-review-link-video.sql — guest review links for a finished Video Producer video (11 November 2026)
--
-- src/utils/video-review-links.ts: a subscriber shares a finished video; a guest with no account watches it,
-- leaves comments pinned to moments ("at 0:12") and approves it or asks for changes. Nothing a guest does
-- changes the video, spends a task or runs AI.
--
--   · review_links.item_kind may now be 'video_project' (its id is video_projects.id).
--   · review_link_responses.at_s: the second of the video a comment is about. NULL for posts and designs.
--
-- Apply on staging, then prod, BEFORE the code that writes them. Safe to re-run.

BEGIN;

ALTER TABLE review_links DROP CONSTRAINT IF EXISTS review_links_item_kind_check;
ALTER TABLE review_links ADD CONSTRAINT review_links_item_kind_check
  CHECK (item_kind IN ('social_post','design_brief','video_project'));

ALTER TABLE review_link_responses ADD COLUMN IF NOT EXISTS at_s REAL;

COMMIT;

-- Check (expect the new kind in the constraint and the column present):
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'review_links_item_kind_check';
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'review_link_responses' AND column_name = 'at_s';
