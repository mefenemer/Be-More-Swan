-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-chapters-skip.sql — Help Centre: skip buttons and chapters on a finished video (11 November 2026)
--
-- e7fb12aa / 2d135432: back and forward 5 and 10 seconds under the player, and chapters (runs of scenes
-- that share a story beat, src/lib/video-chapters.ts) listed beside it — click to play, ✎ to rename,
-- added to the YouTube description for wide videos. Described in the "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases
-- with the release that carries it. No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Skip buttons and chapters

Under the player of a finished video are four buttons that move it back or forward 5 or 10 seconds, handy for checking one moment again before you leave a note on it.

Beside the player is the video's list of chapters. A chapter is a part of the video that does one job, such as the opening, the problem, how you help, the proof or what to do next, and each is named from its own words. Click a chapter to play from there. The chapter that's playing is highlighted.

To rename a chapter, press the pencil beside it, type the new name and press **Save**. Leave the name empty to go back to the one it had. Nothing is made again and it's free. You can also ask your Video Producer in chat to rename one. Names you give are kept when you make a new version, for the scenes it keeps.

**Chapters on YouTube.** When a wide (16:9) video with at least three chapters of ten seconds or more is posted to YouTube, the chapters are added to the end of its description, so viewers can jump between them. If your caption already has its own chapter times starting at 0:00, yours are used instead. **Copy for YouTube** copies the same lines, for a video you upload yourself. Vertical and square videos under three minutes become Shorts on YouTube, and Shorts don't have chapters, so theirs show on the Videos tab only. To get them, make a wide version with the **Make it wide 16:9 too** button.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Skip buttons and chapters%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## Skip buttons and chapters%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
