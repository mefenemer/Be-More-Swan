-- db/help-articles-2026-11-18-ai-presenter.sql — Help Centre: the AI presenter (18 November 2026)
--
-- docs/video-producer-screen-walkthrough-plan.md §11, Phase A5. The AI presenter went live for every workspace on
-- 18 November 2026 (flag ai_presenter), free until 19 December 2026 and then 2 tasks for each second on screen
-- (task cost change 3, announced 18 November; Terms v2.4 clause 5.2). Nothing in the Help Centre described it.
--
-- Two guarded edits, safe to re-run (each is a no-op once applied). No schema change. Apply to BOTH databases.
--   1. APPEND "## An AI presenter" to "Making a Video: From Storyboard to Finished Post".
--   2. ADD a row to the cost table in "What Counts as a Task", after the AI video row.
-- The price is written out, NOT a {{tasks.ai_presenter}} token: the live cost is 0 until 19 December, so a token
-- would read "no tasks". Bodies dollar-quoted (apostrophes NOT doubled), titles single-quoted. No semicolons
-- inside the bodies.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## An AI presenter
Your Video Producer can put an **AI presenter** in a video: a made-up person who speaks your script to camera. They aren't real people, and every video with one is labelled as made with AI, with a short "AI presenter" note on screen when they first appear.
- On **New video**, choose an **AI presenter**. There are 12, men and women, and you can watch a short sample of each before you choose.
- The presenter speaks your script in their own voice, in the language of the voice you pick. Changing the voice's language changes theirs.
- By default the presenter opens the video, speaks at one key moment and closes it, and your other scenes use stock footage, your pictures or branded cards. Tick **Show them throughout** to have them in every scene.
- **Screen recordings.** Once you've chosen a presenter, you can pick videos of your own as screen recordings, for example a walk through your website or app, and tick that you have permission to use the people and music in them. The presenter then walks viewers through them from a round bubble in the corner, in every scene.
- On a presenter's scene, **Change** has a **Layout**: the presenter full frame, the screen with the presenter in a bubble, or the presenter with the screen in a small window. There's no "Screen only" for a presenter, so you never pay for a presenter nobody sees.
- You can't read the voiceover yourself on a video with an AI presenter.
- You can also ask in chat, for example "make a 30-second video with Amara presenting".

**What it uses.** An AI presenter uses no tasks until 19 December 2026. From then, it counts as 2 tasks for each second the presenter is on screen, rounded up to the next whole second (a 15-second appearance is 30 tasks). The "Make the video" button shows the exact number before you press it, you're never charged more than it shows, and only presenter clips that were actually made count. Presenter scenes take a few minutes longer to make than the rest.$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## An AI presenter%';

UPDATE help_articles
   SET content_md = replace(content_md,
           $$| An AI video (Busywork Buster) | {{tasks.ai_video}} |$$,
           $$| An AI video (Busywork Buster) | {{tasks.ai_video}} |
| An AI presenter in a video, for each second they're on screen | No tasks until 19 December 2026, then 2 tasks a second |$$),
       updated_at = now()
 WHERE title = 'What Counts as a Task'
   AND content_md LIKE $$%| An AI video (Busywork Buster) | {{tasks.ai_video}} |%$$
   AND content_md NOT LIKE '%An AI presenter in a video%';

COMMIT;

-- Check (expect 1 and 1):
-- SELECT count(*) FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post' AND content_md LIKE '%## An AI presenter%';
-- SELECT count(*) FROM help_articles WHERE title = 'What Counts as a Task' AND content_md LIKE '%An AI presenter in a video%';
