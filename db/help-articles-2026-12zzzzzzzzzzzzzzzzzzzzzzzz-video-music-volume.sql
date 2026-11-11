-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzz-video-music-volume.sql — Help Centre: music volume on a video (10 November 2026)
--
-- The Video Producer's options row gained "Music volume: Normal / Quiet / Loud"
-- (docs/video-producer-manual-controls-plan.md Phase 1). Described in the "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases
-- with the release that carries the music volume. No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Music volume

Beside **Music** on a storyboard, choose **Music volume**: **Normal**, **Quiet** or **Loud**. Every video is levelled to an even loudness that suits social media, and this sets how loud the music sits within it. Whatever you choose, the music still goes quiet whenever someone speaks.

On a finished video, press **Change it** first. Changing the volume is free: nothing new is made, only the finished video is rendered again. You can also ask your Video Producer in chat to make the music quieter or louder.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Music volume%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## Music volume%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
