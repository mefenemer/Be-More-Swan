-- db/help-articles-website-heading-align-2026-11-11.sql — Help Centre: a text section's heading can sit on
-- the left, centred or on the right (FR#8, staging aacf6967), and its picture on either side.
-- Adds a short section to 'Your Website Pages', just before "## Keeping it up to date". (It first
-- targeted 'Designing Your Website', which exists on neither database, so it changed nothing.)
-- Does nothing where that heading isn't there, or where this has already been applied.
--
-- NO semicolons inside the bodies. Staging first, then prod:
--   node scripts/db-migrate.mjs apply --only help-articles-website-heading-align-2026-11-11 --execute --yes
--   node scripts/db-migrate.mjs apply --only help-articles-website-heading-align-2026-11-11 --url-var DATABASE_URL_PROD --execute --yes

BEGIN;

UPDATE help_articles
SET content_md = replace(content_md, $old$
## Keeping it up to date
$old$, $new$
## Text sections on a site made with your Website Assistant

A text section can have a **picture** beside its words, on the left or the right. Its **heading** can sit on the left, centred or on the right. To alternate the headings down a page, ask your Website Assistant in chat.

## Keeping it up to date
$new$),
    updated_at = NOW()
WHERE title = 'Your Website Pages'
  AND position($old$
## Keeping it up to date
$old$ in content_md) > 0
  AND position('## Text sections on a site made with your Website Assistant' in content_md) = 0
RETURNING id, title;

COMMIT;
