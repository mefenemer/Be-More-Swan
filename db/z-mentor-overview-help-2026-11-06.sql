-- db/z-mentor-overview-help-2026-11-06.sql — Help Centre, owner decision 2026-11-06.
--
-- The Business Mentor's Overview tab was split: it now holds what needs the user now (this week's
-- Commitments, Suggestions with Waiting / Accepted / Dismissed pills, the Set-up checklist, Recommended
-- next). Reviews and Customers moved to its Results tab, Get feedback to its Plan tab, and What I can
-- see to its Assistant Settings. Ask Your Team answers ONLY from published help_articles, so these
-- sentences would send people to the wrong tab.
--
-- ⚠️ Run on each database WITH the release that carries the new page, not before: until then the old
-- page is the true one.
--
-- Idempotent: REPLACE on exact strings is a no-op once applied, and the WHERE needs the old words.
-- It RETURNs, so the Neon SQL editor shows what it changed. No semicolons inside string literals (the
-- Neon editor splits pasted scripts on them). Apostrophes are DOUBLED because every string is single-quoted.

BEGIN;

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(content_md,
         'Dismissed suggestions are listed on its **Overview** tab, each with **Bring back**.',
         'Dismissed suggestions are on its **Overview** tab, under **Suggestions** ▸ **Dismissed**, each with **Bring back**.'),
         'Suggestions waiting for an answer are on the Overview tab and in your Inbox under **Needs you**.',
         'Suggestions waiting for an answer are on the Overview tab, under **Suggestions** ▸ **Waiting**, and in your Inbox under **Needs you**.'),
         'The full list is on its **Overview** tab under **What I can see**.',
         'The full list is in its **Assistant Settings**, under **What I can see**.'),
         '**Get feedback** on its Overview tab',
         '**Get feedback** on its Plan tab'),
         '**Review my week now** on its Overview tab',
         '**Review my week now** on its Results tab'),
         'They''re at the top of your Mentor''s **Results** tab, and you can set them in chat too.',
         'This week''s are at the top of your Mentor''s **Overview** tab, the full list with earlier weeks is on its **Results** tab, and you can set them in chat too.'),
         '## Track record',
         '## Accepted suggestions'),
         'The **Track record** panel on the Overview tab lists the suggestions you accepted',
         '**Accepted**, under **Suggestions** on the Overview tab, lists the suggestions you accepted'),
       updated_at = now()
 WHERE content_md LIKE '%Dismissed suggestions are listed on its **Overview** tab%'
    OR content_md LIKE '%Suggestions waiting for an answer are on the Overview tab and in your Inbox%'
    OR content_md LIKE '%The full list is on its **Overview** tab under **What I can see**%'
    OR content_md LIKE '%**Get feedback** on its Overview tab%'
    OR content_md LIKE '%**Review my week now** on its Overview tab%'
    OR content_md LIKE '%They''re at the top of your Mentor''s **Results** tab%'
    OR content_md LIKE '%The **Track record** panel on the Overview tab%'
RETURNING title, is_published, 'wording updated' AS result;

-- Check: expect NO rows. Any row here is an article still naming the old place.
SELECT title, 'still names the old place' AS problem
  FROM help_articles
 WHERE content_md LIKE '%Dismissed suggestions are listed on its **Overview** tab%'
    OR content_md LIKE '%Suggestions waiting for an answer are on the Overview tab and in your Inbox%'
    OR content_md LIKE '%The full list is on its **Overview** tab under **What I can see**%'
    OR content_md LIKE '%**Get feedback** on its Overview tab%'
    OR content_md LIKE '%**Review my week now** on its Overview tab%'
    OR content_md LIKE '%They''re at the top of your Mentor''s **Results** tab%'
    OR content_md LIKE '%The **Track record** panel on the Overview tab%';

COMMIT;
