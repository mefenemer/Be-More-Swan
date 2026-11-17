-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-screen-recordings.sql — Help Centre: screen recordings already work (17 November 2026)
--
-- Phase 0 of docs/video-producer-screen-walkthrough-plan.md: a screen recording with the camera bubble already in
-- it (Loom and similar) is one ordinary video file, so "Use my own footage" can review it, cut pauses and "um"s,
-- caption it and add a closing card today. Separate camera + screen recordings in a bubble come later (Phases 1–3),
-- so the section says so.
--
-- APPEND to "Making a Video: From Storyboard to Finished Post", guarded by its new heading: a no-op when already
-- applied, safe to re-run. Body dollar-quoted (apostrophes NOT doubled), title single-quoted. No semicolons in
-- the body. No schema change. Apply to BOTH databases with the release that carries the Phase 0 prompt change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Screen recordings

You can make a video from a screen recording, for example a walk through your website, booking system or app.

- **Record with your camera in the corner** using a screen recorder that does this (Loom, for example), so you appear in a small bubble while you talk. It saves one video file.
- **Upload it with Use my own footage.** Each recording can be up to 5 minutes and 500 MB, and you can use up to 10.
- Your Video Producer reviews it like any footage. When you keep your own sound, it cuts long pauses, "um"s and false starts, adds captions from your words and puts your closing card at the end.
- Choose the **wide (16:9)** shape for a screen recording, so the screen isn't cropped.

It can't yet put a separate camera recording in a bubble over a separate screen recording, or make videos longer than 60 seconds.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Screen recordings%';

COMMIT;

-- Check (both databases):
-- SELECT title, position('## Screen recordings' in content_md) > 0 AS has_section FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
