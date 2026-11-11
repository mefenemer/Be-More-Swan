-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-ai-clip-sound-label.sql — Help Centre: AI clip sound, and AI labelling on YouTube (11 November 2026)
--
-- Video Producer plan Phases 6–7 (docs/video-producer-footage-and-ai-plan.md): "With sound" on an AI clip
-- (src/lib/ai-clip.ts CLIP_SOUND_PRICE) and YouTube's synthetic-content disclosure set on posts with AI
-- video (src/utils/ai-disclosure.ts). Described in the "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases
-- with the release that carries it. No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## AI clips with sound, and AI labels

When you make a single AI clip, tick **With sound** for natural background sound that suits the scene, such as waves, a busy café or birdsong. It never has speech or music. A clip with sound uses one and a half times the clip's tasks, and the button shows the exact number. Leave it off if a voiceover or music will go over the clip. The option only appears for styles that can have sound at the moment.

When a post going to YouTube contains AI-made video, either an AI clip or a video with AI scenes, it is marked on YouTube as altered or synthetic content, as YouTube asks.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## AI clips with sound, and AI labels%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## AI clips with sound, and AI labels%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
