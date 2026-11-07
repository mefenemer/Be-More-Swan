-- db/z-rename-assistant-settings-help-2026-11-05.sql — Help Centre, owner decision 2026-11-05.
--
-- "Assistant Profile" is now "Assistant Settings" everywhere in the app and in what the chat says
-- (commit db5b71cd). The Help Centre still used the old name, so Ask Your Team (answers ONLY from
-- published help_articles) and the articles themselves sent people to a button that is no longer
-- called that. On the assistants with the new page layout (Brand Designer first), the same sections
-- are a menu down the right-hand side, so the article that describes them says so.
--
-- 1. The article "The Assistant Profile Pane" becomes "Assistant Settings" (its heading, title and
--    first line). Skipped if an "Assistant Settings" article already exists (title is unique).
-- 2. Every published article: links to it (#the-assistant-profile-pane → #assistant-settings, the
--    slug help.js builds from the title), then every remaining "Assistant Profile".
--
-- Idempotent: REPLACE on exact strings is a no-op once applied, and every WHERE needs the old words.
-- Each statement RETURNs, so the Neon SQL editor shows what it changed. No semicolons inside string
-- literals (the Neon editor splits pasted scripts on them). Apostrophes are DOUBLED here because
-- every string is single-quoted.

BEGIN;

UPDATE help_articles
   SET title = 'Assistant Settings',
       content_md = REPLACE(REPLACE(REPLACE(content_md,
         '# The Assistant Profile Pane', '# Assistant Settings'),
         'Press **Assistant Profile** on an assistant''s page to open its profile — the brief it works from.',
         'Press **Assistant Settings** at the top of an assistant''s page to open its settings, the brief it works from. Where the page has a menu down the right-hand side instead, pick a section there.'),
         'to open its profile', 'to open its settings'),
       updated_at = now()
 WHERE title = 'The Assistant Profile Pane'
   AND NOT EXISTS (SELECT 1 FROM help_articles WHERE title = 'Assistant Settings')
RETURNING title, 'article renamed' AS result;

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(REPLACE(REPLACE(content_md,
         '(#the-assistant-profile-pane)', '(#assistant-settings)'),
         '[The Assistant Profile Pane]', '[Assistant Settings]'),
         'the Assistant Profile pane', 'Assistant Settings'),
         'Assistant Profile', 'Assistant Settings'),
       updated_at = now()
 WHERE is_published
   AND (content_md LIKE '%Assistant Profile%' OR content_md LIKE '%#the-assistant-profile-pane%')
RETURNING title, 'wording updated' AS result;

-- Check: expect NO rows. Any row here is a published article still using the old name.
SELECT title, 'still says Assistant Profile' AS problem
  FROM help_articles
 WHERE is_published
   AND (title ILIKE '%assistant profile%' OR content_md ILIKE '%assistant profile%' OR content_md LIKE '%#the-assistant-profile-pane%');

COMMIT;
