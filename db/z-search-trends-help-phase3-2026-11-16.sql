-- db/z-search-trends-help-phase3-2026-11-16.sql — Help Centre: What People Search, updated for Phase 3 (Social, Email, calendar, look-ups).
-- Replaces the body z-search-trends-help-2026-11-16.sql wrote (same title, upsert).
-- Ask Your Team answers ONLY from published help_articles, so without this it would say there is no such setting.
--
-- Run on the database the app code is on: staging now, prod when the staging→main PR carries it.
-- Idempotent: upserts by title. RETURNs, so the Neon SQL editor shows what it did. No semicolons inside
-- string literals (the Neon editor splits pasted scripts on them). The body is $$-quoted.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Getting Started', 41, 'What People Search: Google Trends for Your Business', $$
# What People Search: Google Trends for Your Business

**What People Search** is a short list of the words your customers type into Google, such as "boiler service" or "dog grooming". Be More Swan checks them on **Google Trends** every week. Your **Business Mentor**, **Blog Writing Assistant**, **Social Media Assistant** and **Email Marketing Assistant** use the list to:

- plan content **before your busy months**, because articles published a few weeks ahead tend to be found
- spot when interest in a term is **rising**
- write about the **related searches** people make, such as questions about cost

## Choosing your search terms

1. Go to **Business Information ▸ What People Search**.
2. Press **Suggest terms for me**. We suggest terms from your industry, business description, Products & Services and blog keywords. They're saved as suggestions, and nothing is tracked until you approve them.
3. Press **Approve** on the ones that fit (or **Approve all**). Press **Remove** on any you don't want.
4. To add your own, type it, choose the country and press **Add**.

You can track up to **20 terms**. Broad words your customers really type work best. Use "wedding venues", not your business name or a town. The first data for a new term arrives within a day.

## Reading the results

Each term shows:

- a small chart of the **past 12 months**
- the months it's **usually busiest** and when the next busy spell starts
- whether interest is **rising**, **falling** or **steady** compared with the 8 weeks before
- **related searches** people make. Searches that aren't useful are removed first, such as brand names, news and other towns.

The numbers are **relative interest**, where 100 is the busiest week of the past year. They are **not** a number of searches. Busy months are **last year's pattern**, not a forecast. If a term shows "Not enough searches in this region to chart", too few people search for it in that country. Try a broader term.

## In Blog setup

Open your Blog Writing Assistant. On its **Blogs** tab, click **Blog setup**, then **Search performance**. Under **What people search for**, click a related search to ask your Blog Writer for an article on it. It opens the chat with the request typed in, ready for you to send.

## Timely posts and emails

When one of your terms is in its busy months, starts them next month, or is rising, your Social Media and Email Marketing Assistants can give a scheduled post or email a **timely angle** on it. The post still covers its usual topic. It just ties in what people are searching for right now.

You choose how often on each assistant's page, under **Profile ▸ Notifications ▸ Timely angles from search trends**:

- **Never**
- **Occasionally**, about 1 in 5 scheduled posts or emails (the default)
- **Often**, about 1 in 3

Only the terms you've approved are ever used. Your assistants never jump on national news or whatever is trending that day.

## On your calendar

When one of your terms is usually busy in the month or week you're looking at, the **Calendar** shows a faint "Busy season for…" line above the dates, so you can plan posts and emails for it.

## In your weekly review

When one of your terms has a busy spell starting in the next month or two, your Business Mentor mentions it in your weekly review and suggests writing for it now. It also reminds you if suggested terms are still waiting for your OK.

## Asking in chat

Ask your Business Mentor, Blog Writing, Social Media or Email Marketing Assistant things like "when do people search for boiler servicing most?" or "track heat pumps". To change the list, it shows a card, and nothing changes until you press the card's button.

To check a term that isn't on your list, ask to **look it up**. The card shows its busy months and related searches straight away, without adding it to your list. Look-ups are free, up to **10 a day**. After that, the term is added as a suggestion instead, and its data arrives with the weekly refresh once you approve it.

You can also ask your Social Media or Email Marketing Assistant to change how often it uses timely angles. It shows a card to confirm.
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = now()
RETURNING title, is_published;

COMMIT;
