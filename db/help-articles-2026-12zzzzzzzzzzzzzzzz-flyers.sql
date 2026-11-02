-- db/help-articles-2026-12zzzzzzzzzzzzzzzz-flyers.sql — Help Centre: printable flyers (2026-11-02).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzzzzz-mentor-morning.sql. One article
-- (docs/brand-designer-flyers-plan.md §3.8).
--
-- ⚠️ INSERTED UNPUBLISHED (is_published = FALSE). Flyers are on staging only. Ask Your Team answers from
-- PUBLISHED articles only (src/utils/help-knowledge.ts), so publishing now would put copy ahead of the
-- product. Publish with the statement at the foot of this file in the release that ships flyers.
--
-- Written from the code, not the plan:
--   New flyer form, buttons, words, paper sizes — src/components/assistant-briefs.js, src/config/flyer-vocab.ts
--   three pages, words refused not cut off, soft-photo warning — src/utils/flyer-briefs.ts, src/lib/flyer.ts
--   contact details from the last flyer or the website, offer from the recorded offer — src/utils/flyer-words.ts
--   1 task to draft the words, pages free, AI photo 1 task — src/config/task-weights.ts, flyerCostLine
--   two PDFs, 3 mm bleed, Print / downloads — src/lib/flyer.ts renderFlyerPdfs, my-content.js, my-content.html
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzzzzz-flyers --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Your Assistants', 72, 'Making a Printed Flyer', $$
# Making a Printed Flyer

Your **Brand Designer** makes printable flyers in your brand colours, with your logo. You approve the one you like, and a print-ready PDF is saved to **My Content**, ready to print at home or send to a print shop.

## Start a flyer

1. Open your Brand Designer and go to the **Briefs** tab.
2. Press **New flyer**.
3. Give it a name, say what the flyer is for, and choose the paper: **A5** (the usual handout), **A4** (a poster or notice), **A6** (a postcard) or **DL** (a slim leaflet). Every flyer is portrait and one-sided.
4. Choose a photo: a stock photo, an AI photo, or untick both for a words-only flyer.
5. Press **Next: draft the words for me** (1 task) or **Next: I'll write the words**.

You can also ask your Brand Designer in chat, for example "make me an A5 flyer for our November open day".

## The words

A flyer prints exactly the words you save: a headline, an optional subheading, up to three points, an offer, a call to action, a date or opening times, your contact details and a QR code link.

- **Draft the words for me** writes the headline, subheading, points and call to action from your Business Information and Products & Services. It never invents a price, a date or a review.
- Your **offer** is filled in only from the introductory offer you recorded under Business Information ▸ Products & Services.
- Your **contact details** are never written by AI. The first time, only your website is filled in. Type your phone, email and address once, and every later flyer starts from them.

Check every word, especially phone numbers and prices, before you print.

## Choosing a page

Press **Save and ask … for pages**. Your Brand Designer draws up to three pages from your words: **Photo at the top**, **Full-page photo** and **Words only**. Press **Use this flyer** on the one you like, or **Not this** with a reason, and ask for more.

- If the words are too long for the paper, that page is left out and the brief says which part to shorten. Words are never cut off.
- If a photo would look soft when printed, the page says so. Try a smaller paper size or another round.

## Printing it

Approving a page makes two PDFs, saved together as a **Flyer** in **My Content**.

| Button | What it's for |
|---|---|
| **Print** | Opens the flyer in a new tab, where your browser prints it |
| **PDF for home printing** | The exact page size, for your own printer |
| **PDF for a print shop** | Adds 3 mm of picture past each edge (bleed) and marks where to cut. Send this one to a printer |

## What it costs

| What | Tasks |
|---|---|
| Drafting the words | 1 task |
| A round of pages | none |
| An AI photo on a round | 1 task |
| Typing your own words, a stock photo or a words-only flyer | none |

## What it can't do yet

- Print or post flyers for you, or send them to a print shop for you
- Double-sided flyers or folded leaflets
$$, FALSE)

ON CONFLICT (title) DO UPDATE SET
    category = EXCLUDED.category,
    sort_order = EXCLUDED.sort_order,
    content_md = EXCLUDED.content_md,
    updated_at = now();

COMMIT;

-- At go-live (flyers on prod), publish:
--   UPDATE help_articles SET is_published = TRUE, updated_at = now() WHERE title = 'Making a Printed Flyer';
