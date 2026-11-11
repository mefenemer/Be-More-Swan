-- db/help-articles-website-heading-align-2026-11-11.sql — Help Centre: a text section's heading can sit on
-- the left, centred or on the right (FR#8, staging aacf6967), and its picture on either side.
-- Adds one paragraph to 'Designing Your Website', after the one about feature and step cards. Does
-- nothing where that paragraph isn't there, or where this has already been applied.
--
-- NO semicolons inside the bodies. Apply with the release that takes heading alignment to production.
-- Staging first, then prod:
--   node scripts/db-migrate.mjs apply --only help-articles-website-heading-align-2026-11-11 --execute --yes

BEGIN;

UPDATE help_articles
SET content_md = replace(content_md, $old$Feature and step cards can each have a **picture** across the top and a **link** under the words, such as "Read more" pointing at the page about that service.
$old$, $new$Feature and step cards can each have a **picture** across the top and a **link** under the words, such as "Read more" pointing at the page about that service.

A text section can have a **picture** beside its words, on the left or the right. Its **Heading** can sit on the left, centred or on the right. To alternate the headings down a page, ask your Website Assistant in chat.
$new$),
    updated_at = NOW()
WHERE title = 'Designing Your Website'
  AND position($old$Feature and step cards can each have a **picture** across the top and a **link** under the words, such as "Read more" pointing at the page about that service.
$old$ in content_md) > 0
  AND position('Its **Heading** can sit on the left' in content_md) = 0
RETURNING id, title;

COMMIT;
