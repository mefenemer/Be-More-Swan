-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-long-presenter.sql — Help Centre: long walkthroughs with an AI presenter (Phase 4c-3, 19 November 2026)
--
-- docs/video-producer-screen-walkthrough-plan.md §12 ("4c design"). An AI presenter walking through the owner's screen
-- recordings can now be 2, 5 or 10 minutes, told in chapters. APPEND a section to "Making a Video: From Storyboard to
-- Finished Post", guarded by its heading (a no-op once applied; safe to re-run). No schema change. Apply to BOTH
-- databases AFTER the release that carries Phase 4c reaches them. Named to sort after every other 2026-12z… video
-- article. The price is written out, not a {{tasks.ai_presenter}} token: the live cost is 0 until 19 December 2026.
-- Body dollar-quoted (apostrophes NOT doubled), title single-quoted. No semicolons inside the body.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Long walkthroughs with an AI presenter
An AI presenter can walk viewers through your screen recordings, for example a tour of your website, app or booking system, in a video of **2, 5 or 10 minutes**.
- On **New video**, choose an **AI presenter**, tick the **screen recordings** to walk through (and that you have permission to use them), then pick 2, 5 or 10 minutes as the **Length**. Long lengths open once a presenter and a screen recording are chosen.
- A long video is told in **chapters**: each scene is one topic or step, with the presenter in a round bubble over your screen, or your screen in a window beside them. Each chapter shows in the app and, on a wide video, on YouTube.
- The script can be up to about 10 minutes of speech. If you lengthen the lines past that, it tells you how much to shorten before anything is made.
- **What it uses.** The presenter counts by the second they're on screen: no tasks until 19 December 2026, then 2 tasks a second. A 5-minute walkthrough with the presenter in every scene is about 600 tasks, and a 10-minute one about 1,200, plus 1 task for the voiceover. The "Make the video" button shows the exact number before you press it, and you're never charged more than it shows.
- Making a long presenter video takes a while, often half an hour or more, because the presenter is made in short pieces side by side. It carries on by itself, so you can leave the page and come back to it.$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Long walkthroughs with an AI presenter%';

COMMIT;

-- Check (expect 1):
-- SELECT count(*) FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%## Long walkthroughs with an AI presenter%';
