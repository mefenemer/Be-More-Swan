-- db/z-your-brand-help-2026-11-06.sql — Help Centre, owner decision 2026-11-06.
--
-- Every assistant's settings now has a "Your brand" section: the brand style, picture guidelines and the
-- files and links from Business Information ▸ Brand Assets, shared by all assistants (a change in either
-- place is the change in both). It replaces the old "Business Information & Brand Knowledge" card, and the
-- name "Brand Knowledge" is gone from the app and from what the chat says.
--
-- 1. Every published article: "Brand Knowledge" → "Your brand".
-- 2. The "Assistant Settings" article gets a short "Your brand" section, once.
--
-- Run on the database the app code is on: staging now, prod when the staging→main PR carries it.
-- Idempotent: REPLACE on exact strings is a no-op once applied, and every WHERE needs the old words.
-- Each statement RETURNs, so the Neon SQL editor shows what it changed. No semicolons inside string
-- literals (the Neon editor splits pasted scripts on them). Apostrophes are DOUBLED.

BEGIN;

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(REPLACE(content_md,
         '**Brand Knowledge** documents and links', '**Your brand** files and links'),
         'Business Information & Brand Knowledge', 'Your brand'),
         'Brand Knowledge', 'Your brand'),
       updated_at = now()
 WHERE is_published
   AND content_md LIKE '%Brand Knowledge%'
RETURNING title, 'wording updated' AS result;

UPDATE help_articles
   SET content_md = content_md || E'\n\n## Your brand\n\n'
         || 'Every assistant''s settings has a **Your brand** section. It shows your brand style (colours and font), your picture guidelines, and the files and links your assistants read, such as your logo and brand guidelines. You can change any of them there, add a file or link, or remove one.'
         || E'\n\n'
         || 'Your brand is shared by all your assistants. It is the same as **Business Information ▸ Brand Assets**, so anything you change in one place changes in the other, and every assistant uses it from then on.',
       updated_at = now()
 WHERE title = 'Assistant Settings'
   AND content_md NOT LIKE '%## Your brand%'
RETURNING title, 'Your brand section added' AS result;

-- Check: expect NO rows. Any row here is a published article still using the old name.
SELECT title, 'still says Brand Knowledge' AS problem
  FROM help_articles
 WHERE is_published
   AND (title ILIKE '%brand knowledge%' OR content_md ILIKE '%brand knowledge%');

COMMIT;
