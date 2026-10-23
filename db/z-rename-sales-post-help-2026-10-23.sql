-- db/z-rename-sales-post-help-2026-10-23.sql — Help Centre, Calendar/Review review 2026-10-23.
--
-- The Review card's origin pill now says "Sales post" instead of "Conversion post" (the explanation
-- lived in a hover, which a phone does not have). "The Social Media Assistant" article still used the
-- old name, and Ask Your Team answers only from published help_articles, so it would have described
-- a label nobody can see any more.
--
-- Idempotent: REPLACE on exact strings is a no-op once applied. RETURNs, so the Neon SQL editor shows
-- what it changed. No semicolons inside string literals.

BEGIN;

UPDATE help_articles
   SET content_md = REPLACE(REPLACE(content_md,
         '## Conversion posts',
         '## Sales posts'),
         'writes a **Conversion post**',
         'writes a **Sales post** (labelled "Sales post" on the Review card)'),
       updated_at = now()
 WHERE title = 'The Social Media Assistant'
   AND content_md LIKE '%Conversion post%'
RETURNING title, 'Conversion post renamed to Sales post' AS result;

COMMIT;
