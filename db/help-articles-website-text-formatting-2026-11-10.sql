-- db/help-articles-website-text-formatting-2026-11-10.sql — Help Centre: the formatting buttons above
-- website text boxes (bold, italics, bullet and numbered lists, link, subheading — text-format-bar.js).
-- Rewrites one paragraph of 'Designing Your Website'. Where that article isn't in the database yet,
-- this does nothing: help-articles-website-import-design-2026-11-09.sql already carries the new words.
--
-- NO semicolons inside the bodies. Apply with the release that takes the formatting bar to production.
-- Staging first, then prod:
--   node scripts/db-migrate.mjs apply --only help-articles-website-text-formatting-2026-11-10 --execute --yes

BEGIN;

UPDATE help_articles
SET content_md = replace(content_md, $old$In any text you can add:

- **A link inside a sentence**: write `[our courses](/our-courses)`
- **A subheading**: start a line with `###`
$old$, $new$In any text box, the buttons above it format your words:

- **B** makes the words you've chosen bold, and **I** puts them in italics. Ctrl+B and Ctrl+I (⌘B and ⌘I on a Mac) do the same.
- **• List** and **1. List** turn the lines you've chosen into a bullet list or a numbered list.
- **Link** links the words you've chosen. Type the page, like `/our-courses`, or a web address in the brackets.
- **Subheading** (in a text section) puts a subheading on a line of its own.

Press a button again to take the format off. In the box you'll see small marks, like `**bold**` or `- ` at the start of a list line. They make the formatting, and your site shows it properly.
$new$),
    updated_at = NOW()
WHERE title = 'Designing Your Website'
  AND position($old$In any text you can add:

- **A link inside a sentence**: write `[our courses](/our-courses)`
- **A subheading**: start a line with `###`
$old$ in content_md) > 0
RETURNING id, title;

COMMIT;
