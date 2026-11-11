-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzz-made-with-ai-label.sql — Help Centre: the "Made with AI" line (11 November 2026)
--
-- Posts whose video contains realistic AI footage get "Made with AI" after the caption when they publish,
-- while the workspace setting is on (src/utils/ai-disclosure.ts, db/z-ai-video-label.sql). Described in the
-- Social Media Assistant's article and the Video Producer's "Making a Video" article.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Bodies dollar-quoted (apostrophes NOT doubled), no semicolons inside the bodies. Apply to BOTH databases
-- with the release that carries it. (The column itself is db/z-ai-video-label.sql, which must run first.)

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## "Made with AI" on AI videos

When a post's video contains AI footage that looks real, "Made with AI" is added after the caption as the post is published on Facebook, Instagram, LinkedIn, X and Threads. It isn't shown in the caption while you edit, and it's added only once.

- 3D animated and 2D cartoon AI clips aren't labelled.
- On YouTube, a video with AI footage is always marked as altered or synthetic content through YouTube's own setting.
- It's on for every workspace to start with. To turn it off, open **Settings** and find **"Made with AI" on AI videos**, or ask any assistant in chat.
$$,
       updated_at = now()
 WHERE title IN ('The Social Media Assistant', 'Making a Video: From Storyboard to Finished Post')
   AND content_md NOT LIKE '%## "Made with AI" on AI videos%';

COMMIT;

-- Check (expect two rows, has_section = t):
-- SELECT title, content_md LIKE '%## "Made with AI" on AI videos%' AS has_section
--   FROM help_articles WHERE title IN ('The Social Media Assistant', 'Making a Video: From Storyboard to Finished Post');
