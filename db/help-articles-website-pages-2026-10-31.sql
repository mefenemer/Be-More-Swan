-- db/help-articles-website-pages-2026-10-31.sql — Help Centre: Business Information ▸ Website Pages
-- (the site page directory, docs/site-directory-plan.md). NEW article; nothing else changes.
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted, NO semicolons inside
-- the body. Apply staging first, then prod:
--   node scripts/db-migrate.mjs apply --only help-articles-website-pages-2026-10-31 --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Getting Started', 40, 'Your Website Pages', $$
# Your Website Pages

Your assistants read a short list of the pages on your website, so a post, an article or an email links the page it is about instead of your homepage. You'll find it in **Business Information ▸ Website Pages**.

## What's on the list

For each page: its address, its title, one line about it and up to four things it offers. Everything comes from your own pages (their description, first paragraph and headings). Nothing is written by AI and nothing is invented.

## Where it comes from

| Your website | How it's read |
|--------------|---------------|
| A site you published with your **Website Assistant** | Straight from the published site, every time you publish |
| Any other website | From the address on **Business Profile**, using its sitemap or its menu. Up to 30 pages |

We follow your site's robots.txt. Our reader is called **bemoreswan-sitedirectory**, so you can block it on its own if you want to.

## How your assistants use it

- **Social posts and emails** link the page that matches the post.
- **Blog articles** add two or three links to your own relevant pages.
- **Lead outreach** points a prospect at the service they need, when the email allows a link.
- Your **Business Mentor** points out what your site is missing, for example a service you sell that no page mentions.

**Business Information always wins.** If a page on your site says something different, your assistants follow Business Information. Prices are never taken from your website, only from **Products & Services**.

## Keeping it up to date

- It is read again **every week** by itself.
- Press **Re-read my site** after you change your website (once an hour at most).
- Press **Leave out** on any page your assistants should never use or link to. It stays left out after every re-read. **Put back** undoes it.

You can also ask any assistant in chat to re-read your site or leave a page out. It shows a card for you to confirm.

Reading your website never uses any of your tasks.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

COMMIT;
