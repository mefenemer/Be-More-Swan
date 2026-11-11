-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzz-video-ai-clip.sql — Help Centre: an AI clip on its own (11 November 2026)
--
-- Video Producer: "New AI clip" on the Videos tab and in chat (src/lib/ai-clip.ts, plan Phase 5), plus
-- "Add a voiceover in my own voice" on the footage form. Described in the "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases
-- with the release that carries the AI clip. No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## A single AI clip

For one short clip rather than a whole video, press **New AI clip** on the **Videos** tab, or ask your Video Producer in chat.

1. Say what it should show, then pick a style (Realistic, Cinematic, 3D animated, 2D cartoon or Product close-up), a length (5 or 10 seconds) and a shape. Saving it is free.
2. Press **See the first frame**. That uses 1 task and shows the picture the clip will start from. Not right? Press **Try another frame**.
3. Press **Make the clip**. The button says how many tasks it uses. The finished clip is saved to **My Content**.

AI clips only show made-up people, never a real, famous or look-alike person, and realistic clips can't show children. They never picture your own product: use your own photos or footage for that.

Making a video from your own footage? Choose **Add a voiceover in my own voice** under Sound to read the voiceover yourself.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## A single AI clip%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## A single AI clip%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
