-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzz-video-scene-text.sql — Help Centre: text on a video scene (10 November 2026)
--
-- A scene's Change form gained "Text on the video": where, when, look and how it appears, beside a
-- preview (docs/video-producer-manual-controls-plan.md Phase 2). Moving scenes now play on hover and are
-- tagged Moving or Still. Described in the "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Body dollar-quoted (apostrophes NOT doubled), no semicolons inside the body. Apply to BOTH databases
-- with the release that carries the scene text controls. No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Text on a scene

Each scene can have one line of text on the video, up to 60 characters. Press **Change** on the scene and use **Text on the video**:

- **Where**: top, middle or bottom. If that's where the captions are, it tells you, so the two don't overlap.
- **When**: the whole scene, the first 3 seconds, the last 3 seconds, or while that scene's voiceover line is said.
- **Look**: a dark box, plain words on a light backing, or a box in your brand colour.
- **Appears**: rise, fade, pop or cut.

The picture beside it shows roughly how it will look. The words use your brand font when the video can use it, otherwise a bold condensed font. On a branded card the words are the card's headline instead.

Changing the text is free. On a finished video, press **Change it** first. You can also ask your Video Producer in chat to move the words or change how they look.

Scenes marked **▶ Moving** are video footage. Point at the picture, or tap it, to play it. Scenes marked **Still** are pictures, which get a slow camera movement.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Text on a scene%';

COMMIT;

-- Check (expect one row, has_section = t):
-- SELECT title, content_md LIKE '%## Text on a scene%' AS has_section
--   FROM help_articles WHERE title = 'Making a Video: From Storyboard to Finished Post';
