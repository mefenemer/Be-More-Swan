-- db/help-articles-2026-11-18-long-own-footage-videos.sql — Help Centre: long videos from your own footage (Phase 4b)
--
-- docs/video-producer-screen-walkthrough-plan.md §12. A video in its own footage's sound can now be 2, 5 or 10 minutes,
-- in up to 20 scenes (chapters), from recordings of up to 10 minutes. Three lines said otherwise; this changes them and
-- appends a section. Each edit is guarded (a no-op once applied) and safe to re-run. No schema change.
-- Apply to BOTH databases AFTER the release that carries Phase 4b reaches them.
-- Bodies dollar-quoted (apostrophes NOT doubled), titles single-quoted. No semicolons inside the bodies.

BEGIN;

UPDATE help_articles
   SET content_md = replace(replace(content_md,
           $$- It makes videos up to 60 seconds. It doesn't make long YouTube videos.$$,
           $$- It makes videos up to 60 seconds, or 2, 5 or 10 minutes from your own footage in its own sound, told in chapters.$$),
           $$Each video has 3 to 8 scenes.$$,
           $$Each video has 3 to 8 scenes (up to 20 in a long video from your own footage).$$),
       updated_at = now()
 WHERE title = 'Meet Your Video Producer'
   AND content_md LIKE $$%It makes videos up to 60 seconds. It doesn't make long YouTube videos.%$$;

UPDATE help_articles
   SET content_md = replace(replace(content_md,
           $$Each recording can be up to 5 minutes and 500 MB$$,
           $$Each recording can be up to 10 minutes and 500 MB$$),
           $$It can't yet make videos longer than 60 seconds.$$,
           $$From your own footage in its own sound, a video can be 2, 5 or 10 minutes long (see Long videos from your own footage, below).$$),
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md LIKE $$%It can't yet make videos longer than 60 seconds.%$$;

UPDATE help_articles
   SET content_md = content_md || $$

## Long videos from your own footage
A video made from your own footage, keeping its own sound, can be **2, 5 or 10 minutes** long: a walkthrough of your website or booking system, a talk, a class or a tour.
- On **Use my own footage**, choose your videos (each up to 10 minutes and 500 MB), choose **Keep the sound in my videos**, and pick 2, 5 or 10 minutes as the **Length**. Long lengths aren't offered with a voiceover.
- A long video is told in **chapters**. Your Video Producer splits a long take into scenes, one topic or step each, always at the end of a sentence, and keeps your best takes. Each scene becomes a chapter, in the app and on YouTube. A long video can have up to 20 scenes.
- **Tighten my clips** works across the whole video, taking out pauses, "um"s and repeated takes.
- Music plays under the whole video, and a track shorter than the video repeats with a smooth fade.
- A video is never longer than 10 minutes. If the scenes would run over, the ones just before the end are left out, and a note under the title says so.
- Making a long video takes a few minutes, like a short one. Long videos use the same tasks as short ones: tightening, cutting and your own sound use none.
- A 10-minute video is a large file (several hundred MB), so it can take a while to download.$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Long videos from your own footage%';

COMMIT;

-- Check (expect 1, 1, 1):
-- SELECT count(*) FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%## Long videos from your own footage%';
-- SELECT count(*) FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%up to 10 minutes and 500 MB%';
-- SELECT count(*) FROM help_articles WHERE title = 'Meet Your Video Producer' AND content_md LIKE '%2, 5 or 10 minutes from your own footage%';
