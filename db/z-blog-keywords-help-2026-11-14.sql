-- db/z-blog-keywords-help-2026-11-14.sql — Help Centre: blog keywords (src/utils/blog-keywords.ts).
-- Until 2026-11-14 an article's keywords could not be seen or changed anywhere. Ask Your Team answers
-- ONLY from published help_articles, so without this it would still say there is no such setting.
--
-- Run on the database the app code is on: staging now, prod when the staging→main PR carries it.
-- Idempotent: upserts by title. RETURNs, so the Neon SQL editor shows what it did. No semicolons inside
-- string literals (the Neon editor splits pasted scripts on them). The body is $$-quoted.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 41, 'Blog Keywords: What Readers Browse Your Blog By', $$
# Blog Keywords: What Readers Browse Your Blog By

Every blog article has up to **3 keywords**, such as "retirement planning" or "wellbeing". They do two jobs:

- Readers can **browse your blog by them**. They're the categories on your blog page and widget.
- **Search engines read them** as the article's keywords.

Your Blog Writing Assistant chooses keywords for each new article. You can change them on one article, or on every article at once.

## On one article

1. Open the article in **Blog Studio**.
2. Open the **Keywords, SEO & social preview** section.
3. Under **Keywords**, press **×** on a keyword to remove it, or type a new one and press **Add** (or Enter). The blog's other keywords are suggested as you type, so you can reuse them.

Each change saves straight away. On a live article, readers see it straight away too.

**Regenerate SEO** rewrites the keywords along with the search title and description. The new keywords show up in the same place, so you can change them if they don't fit.

## On every article at once

1. Open your Blog Writing Assistant. On its **Blogs** tab, click **Blog setup**.
2. Open **Keywords**. It lists every keyword your blog uses and how many articles carry it.
3. Press **Rename** to change a keyword on every article. If you rename it to a keyword you already use, the two are **merged**, and an article that had both keeps one.
4. Press **Remove** to take a keyword off every article. The articles stay. Only the keyword goes.

Archived articles are left out of the list but are changed too, so an article you bring back doesn't return with an old keyword.

## When your blog changes direction

New keywords follow what your blog is about now. To change that, update your assistant's **Topics & themes** (**Assistant Settings ▸ When and how I work ▸ Topics & themes**). New articles take their subject, and their keywords, from those topics. Then use **Blog setup ▸ Keywords** to rename or remove the old keywords on the articles you already have.

## Asking your assistant in chat

You can ask your Blog Writing Assistant to change an article's keywords, or to rename or remove a keyword across your blog, for example "rename employee wellbeing to wellbeing in retirement". It shows a card with the change and how many articles it touches, and nothing changes until you press the card's button.
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = now()
RETURNING title, is_published;

COMMIT;
