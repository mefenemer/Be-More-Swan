-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-layouts.sql — Help Centre: scene layouts (17 November 2026)
--
-- Phases 1–2 of docs/video-producer-screen-walkthrough-plan.md: a scene of your own footage can show a screen
-- recording (or stock footage / a picture) with you in a round corner bubble, the screen alone while you're heard,
-- or you with the screen in a small corner window (src/lib/scene-cover.ts). Changed on the scene ("Change" →
-- Layout) or from chat (video_scene_edit). The "Screen recordings" section added in Phase 0 said this couldn't be
-- done yet, so that sentence is rewritten here.
--
-- Both statements are guarded: a no-op when already applied, safe to re-run. Body dollar-quoted (apostrophes NOT
-- doubled), title single-quoted. No semicolons in the bodies. No schema change. Apply to BOTH databases AFTER
-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-screen-recordings.sql, with the release that
-- carries the layouts AND after the Remotion site is redeployed on that environment.

BEGIN;

UPDATE help_articles
   SET content_md = replace(content_md,
         $$It can't yet put a separate camera recording in a bubble over a separate screen recording, or make videos longer than 60 seconds.$$,
         $$You can also record yourself and your screen separately, upload both, and choose a **Layout** on each scene (below). It can't yet make videos longer than 60 seconds.$$),
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md LIKE '%It can''t yet put a separate camera recording in a bubble%';

UPDATE help_articles
   SET content_md = content_md || $$

## Layouts: you and your screen

On a scene made from your own footage, press **Change** and choose a **Layout** for what people see while you talk:

- **Presenter.** You, full frame.
- **Screen + bubble.** Your screen fills the frame and you appear in a round bubble in a corner.
- **Screen only.** Your screen fills the frame. People still hear you.
- **Presenter + window.** You fill the frame, with your screen in a small window in a corner.

Then choose what's **On the screen**: another of your videos for this video (a screen recording, say, and where in it to start), stock footage or a stock photo. You can pick the corner, make the bubble smaller, and cover only part of the scene with **From** and **To**. A screen recording is shown whole, with dark edges if its shape differs from the video's.

Your voice and captions carry on underneath whichever layout you choose, and captions move up out of the way of a bubble at the bottom. You can also ask your Video Producer in chat, for example "show my screen recording in scene 2 with me in the corner". Layouts don't use any tasks.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Layouts: you and your screen%';

COMMIT;

-- Check (both databases):
-- SELECT position('## Layouts: you and your screen' in content_md) > 0 AS has_layouts, position('It can''t yet put a separate camera' in content_md) = 0 AS old_line_gone FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
