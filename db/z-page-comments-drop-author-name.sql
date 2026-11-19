-- db/z-page-comments-drop-author-name.sql — stop keeping commenters' names.
--
-- page_comments.author_name was meant to hold the commenter's name from LinkedIn's `actor~`
-- decoration. LinkedIn gives a Community Management app no documented way to name a commenter, and
-- its terms bar storing profile data of members other than the signed-in one — so the column was
-- always empty and shouldn't exist. The Comments tab now says "Someone commented" (or "A LinkedIn
-- Page") and Open on LinkedIn shows who it was. author_urn stays: it tells the Page's own replies apart.
--
-- APPLY AFTER the code that no longer reads the column has deployed (the older code still selects
-- it), staging and prod separately. On a database that hasn't had db/z-page-comments.sql yet, run that
-- first and this straight after. Idempotent.

ALTER TABLE page_comments DROP COLUMN IF EXISTS author_name;

-- Check: expect 0 rows.
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'page_comments' AND column_name = 'author_name';
