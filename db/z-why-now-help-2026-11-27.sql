-- db/z-why-now-help-2026-11-27.sql — Help Centre: the Lead Generator's "Why now" column
-- (docs/lead-why-now-and-watching-plan.md, Phase 1). Ask Your Team answers ONLY from published help_articles,
-- so without this it cannot explain the column, "Cooling off" or "Not checked".
--
-- Run on BOTH databases (Why now is live on prod). The words follow src/config/lead-why-now.ts
-- (WHY_NOW_STATE_LABELS, 30 / 90 days) and the All leads tab (src/components/assistant-data-hub.js).
-- Idempotent: upserts by title. RETURNs, so the Neon SQL editor shows what it did. No semicolons inside
-- string literals (the Neon editor splits pasted scripts on them). The body is $$-quoted, so apostrophes in it
-- are written once.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 35, 'Why Now: Which Leads to Contact Today', $$
# Why Now: Which Leads to Contact Today

The **Why now** column on your Lead Generation Assistant's **All leads** tab shows a recent, dated reason to get in touch with each lead. For example, they have just raised money, they are hiring, or they have launched a new website.

**Rating** tells you how well a lead fits your business. **Why now** tells you **when** to reach out. A lead that is only a fair fit but has a fresh reason can be worth a call today.

## What the column shows

| You see | What it means |
| --- | --- |
| A short reason, with how long ago it happened | **Reason now.** Something happened in the last 30 days. Click the age (for example "5 days ago") to open the page it came from |
| The reason in grey | **Cooling off.** The reason is 30 to 90 days old. It may still be worth mentioning, but it is no longer news |
| No recent reason | We researched the lead and found nothing dated and recent, or the last reason is over 90 days old. Older reasons stay in the lead's research |
| Not checked | The lead has not been researched for a reason yet. This includes leads researched before Why now existed |

Sort by **Why now** to put the freshest reasons at the top.

## Where the reasons come from

When a lead is researched, your assistant reads news and pages about the company. A reason is only shown when we have the page it came from **and** that page has a date. The age is worked out from that date, not guessed, and every reason links to its source so you can check it before you mention it.

When a reason is found, the lead's research panel also shows a **Why now** box with the reason, its age and a link to the source.

## Getting a reason for more leads

- Open a lead and choose **Research this lead**, or **Research again** for a lead that says **Not checked**.
- The **Watch list** tab keeps checking companies you care about. When it spots good news, such as a new director, a new job advert, a new senior person on their team page, or a US fundraising filing, that news becomes the lead's Why now. See **The Watch List: News on Your Customers and Leads**.

Nothing is ever sent to the lead. Why now only helps you choose who to contact first.

## Asking in chat

Ask your Lead Generation Assistant "who should I contact today?" or "which leads should I work first this week?". It answers from the leads that have a reason now, freshest first, and can move the one you pick to Outreach. If no lead has a reason on file, it says so.
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = now()
RETURNING title, is_published;

COMMIT;
