-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzz-video-archive.sql — Help Centre: archiving and deleting videos (10 November 2026)
--
-- The Videos tab gained select boxes, an Archived pill and an Archive / Delete bar (db/z-video-archive.sql,
-- netlify/functions/video-projects.ts). Described in the Video Producer's "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases,
-- with the release that carries db/z-video-archive.sql.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Archiving and deleting videos

Tick the box beside any video on the **Videos** tab, or press **Select all**, then use the bar above the list.

- **Archive** moves the videos to the **Archived** pill. Open it and press **Restore** to put them back where they were.
- **Delete** removes them for good, with their storyboards and notes. It asks you first and can't be undone.
- Either way, a finished video file stays in **My Content** until you delete it there.
- A video that's being made can't be archived or deleted. Cancel it, or wait until it's done.

You can also ask your Video Producer in chat to archive, restore or delete videos. It shows you a card to approve first.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Archiving and deleting videos%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## Archiving and deleting videos%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
