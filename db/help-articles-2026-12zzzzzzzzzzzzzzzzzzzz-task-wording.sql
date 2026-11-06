-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzz-task-wording.sql — Help Centre: task wording (6 November 2026)
--
-- Owner, 2026-11-06. AI images are 1 task per set (the editors offer up to 4 options), a post to X with
-- a link is 10 on top of the post's own task, and "What Counts as a Task" now lists website copy, flyer
-- words, AI voiceovers, Business Mentor work and background removal (src/config/task-weights.ts).
--
-- REPLACE on exact strings: a no-op when already applied, so the file is safe to re-run.
-- ⚠️ Background removal is only in the app once the Brand Designer editor reaches that environment, so
-- apply this to prod with that release.

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(REPLACE(content_md,
         '| An AI image | 1 |',
         '| A set of AI images — the editors give you up to 4 options to choose from | 1 |'),
         '| A post to X with a link | 10 |',
         '| A post to X with a link | 10 extra, on top of the post''s own task |'),
         '| A website audit, draft or rewrite of a page''s words | 1 |',
         E'| A website audit, draft or rewrite of a page''s words | 1 |\n| The words for a printable flyer | 1 |\n| An AI voiceover | 1 |\n| Removing a picture''s background in the design editor | 1 |\n| A Business Mentor research answer, drafted plan or weekly review | 1 each |'),
       updated_at = now()
 WHERE title = 'What Counts as a Task';

UPDATE help_articles
   SET content_md = REPLACE(content_md,
         'An AI image is 1 task, an AI video or music track is 20, and a post to X with a link is 10.',
         'A set of AI images is 1 task, an AI video or music track is 20, and a post to X with a link is 10 extra, on top of the post''s own task.'),
       updated_at = now()
 WHERE content_md LIKE '%An AI image is 1 task, an AI video or music track is 20, and a post to X with a link is 10.%';
