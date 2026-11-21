-- db/help-articles-2026-12zzz…z-video-record-screen.sql — Help Centre: "Record my screen" (Phase 3, 21 November 2026)
--
-- docs/video-producer-screen-walkthrough-plan.md §13. The Videos tab can now record the screen in the browser (PR #792).
-- Two changes to "Making a Video: From Storyboard to Finished Post":
--   1. APPEND a "## Record your screen" section, guarded by its heading (a no-op once applied, safe to re-run).
--   2. Correct two stale lines in the Phase 0 "## Screen recordings" section (5 minutes → 10 since Phase 4b, and the
--      "… or make videos longer than 60 seconds" half of the "can't yet" line, which long videos have made untrue; the
--      camera-bubble half is still true, plan §13 D-R1). replace()
--      on the exact old text: a no-op once replaced, or if the section was never applied.
-- No schema change. Apply to BOTH databases AFTER the release that carries #792 reaches them. Named to sort after every
-- other 2026-12z… article. Body dollar-quoted (apostrophes NOT doubled), title single-quoted. No semicolons in bodies.

BEGIN;

UPDATE help_articles
   SET content_md = replace(replace(content_md,
         $$Each recording can be up to 5 minutes and 500 MB, and you can use up to 10.$$,
         $$Each recording can be up to 10 minutes and 500 MB, and you can use up to 10.$$),
         $$It can't yet put a separate camera recording in a bubble over a separate screen recording, or make videos longer than 60 seconds.$$,
         $$It can't yet put a separate camera recording in a bubble over a separate screen recording. You can also record your screen straight from the Videos tab (see Record your screen, below).$$),
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND (content_md LIKE '%up to 5 minutes and 500 MB%' OR content_md LIKE '%longer than 60 seconds.%');

UPDATE help_articles
   SET content_md = content_md || $$

## Record your screen
You can record your screen straight from the **Videos** tab, without another app, on a computer in Chrome, Edge, Firefox or Safari.
- **For an AI presenter to talk over:** on **New video**, choose an AI presenter, then press **Record my screen** under Screen recordings. **Record my voice too** is left unticked, because the presenter does the talking. Once you've watched it back and pressed **Use this**, it's saved to My Content and ticked for that video.
- **To talk viewers through it yourself:** in **Use my own footage**, press **Record my screen** with **Record my voice too** ticked. It's added to your footage, keeps your voice, and can make a walkthrough of 2, 5 or 10 minutes told in chapters.
- **Choose what to share** opens your browser's own window to pick a tab, a window or your whole screen. Recording starts as soon as you pick, and stops when you press **Stop recording** or your browser's **Stop sharing**. A recording can be up to 10 minutes.
- **Only share what you need.** Everything in the window you share is recorded. Close emails, customer details and passwords first, and turn on Do Not Disturb so notifications don't appear. You watch every recording back before it's saved, and it's saved only to your own My Content. When your Video Producer reviews your footage, it may point out private details it can make out, such as an email address, and suggest cutting that part. It can miss small text, so check before you publish. Screen recordings for an AI presenter aren't reviewed.
- **The screen's own sound** is left out unless you tick **Keep the screen's sound** (in Chrome and Edge), so notification sounds don't end up in your video.
- Give each recording a name that says what it shows, such as "Booking a class in our app". It helps your Video Producer choose which part to show when.
- **On a phone or tablet,** browsers can't record the screen. Use your device's own screen recorder, then add the video with Use my own footage or to My Content.
- Recording and saving are free. The video you make from it uses tasks as usual, shown before anything is made.$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Record your screen%';

COMMIT;

-- Check (both databases; expect true, true, false):
-- SELECT position('## Record your screen' in content_md) > 0 AS has_section,
--        position('up to 10 minutes and 500 MB' in content_md) > 0 AS ten_minutes,
--        position('longer than 60 seconds.' in content_md) > 0 AS stale_line_left
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
