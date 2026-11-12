-- db/help-articles-website-text-align-2026-11-12.sql — Help Centre: a text section's words can sit on the left,
-- centred or on the right, as its heading already could (FR#11). Rewrites the heading sentence that
-- help-articles-website-heading-align-2026-11-11.sql added to 'Your Website Pages'.
-- Does nothing where that sentence isn't there, or where this has already been applied.
--
-- NO semicolons inside the bodies. Run AFTER the code reaches each database's site (staging now, prod after
-- the merge), or the help describes a setting the Website tab doesn't have yet:
--   node scripts/db-migrate.mjs apply --only help-articles-website-text-align-2026-11-12 --execute --yes
--   node scripts/db-migrate.mjs apply --only help-articles-website-text-align-2026-11-12 --url-var DATABASE_URL_PROD --execute --yes

BEGIN;

UPDATE help_articles
SET content_md = replace(content_md,
$old$Its **heading** can sit on the left, centred or on the right. To alternate the headings down a page, ask your Website Assistant in chat.$old$,
$new$Its **heading** and its **text** can each sit on the left, centred or on the right. Choose them in the section's settings on the Website tab, or ask your Website Assistant in chat, for example to centre a section or to alternate the headings down a page.$new$),
    updated_at = NOW()
WHERE title = 'Your Website Pages'
  AND position($old$Its **heading** can sit on the left, centred or on the right. To alternate the headings down a page, ask your Website Assistant in chat.$old$ in content_md) > 0
RETURNING id, title;

COMMIT;
