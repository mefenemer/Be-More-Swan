-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzz-video-own-voice.sql — Help Centre: your own voice, and filming yourself (10 November 2026)
--
-- Video Producer Phase 3 (docs/video-producer-manual-controls-plan.md): "I'll record it in my own voice",
-- line-by-line recording or one whole-script upload, and "Record a video" in "Use my own footage".
-- Described in the "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases
-- with the release that carries the own-voice recording. No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Your own voice

You can read the voiceover yourself instead of using an AI voice. Tick **I'll record it in my own voice** when you ask for a video, or press **Record it in my own voice instead** under the script. A video uses one or the other, never both.

1. Approve the script as usual.
2. Each line then has **Record** and **Upload**. Press **Record**, read the line shown, and press **Use this**. Play it back, and press **Record again** if you want another take.
3. When every line is recorded, press **Make the video**.

- Each scene lasts as long as your recording of its line.
- Captions follow what you actually said.
- If a recording says something quite different from its line, you're told, so you can keep it or record it again.
- Recorded it somewhere else? **Upload one recording of the whole script** instead. The scenes then change where its words reach each line.
- No voiceover is made, so none is charged.
- Your recordings are kept in **My Content**.

## Film yourself

To make a video of you talking to camera, open **Use my own footage** and press **Record a video**. Your browser asks for your camera and microphone. Record, play it back, and press **Use this**. It goes into **My Content** and is ticked for the video, like any video you add. Your Video Producer keeps your own sound, cuts the pauses and ums, and captions what you say.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Your own voice%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## Your own voice%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
