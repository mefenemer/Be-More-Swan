-- db/z-watch-list-help-2026-11-16.sql — Help Centre: the Lead Generator's Watch list (buying triggers Phase 2,
-- docs/buying-triggers-plan.md §5). Ask Your Team answers ONLY from published help_articles, so without this it
-- would say there is no such tab.
--
-- Run on BOTH databases (the Watch list is live on prod since 2026-11-16, release #649).
-- Idempotent: upserts by title. RETURNs, so the Neon SQL editor shows what it did. No semicolons inside
-- string literals (the Neon editor splits pasted scripts on them). The body is $$-quoted, so apostrophes in it
-- are written once.

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 60, 'The Watch List: News on Your Customers and Leads', $$
# The Watch List: News on Your Customers and Leads

The **Watch list** is a tab on your **Lead Generation Assistant**. It checks companies you care about on **Companies House** and tells you when something changes that could be a reason to get in touch. For example, a new director has been appointed, or the company has moved.

It is free, it runs by itself, and **it never contacts anyone**. You decide what to do with the news.

## Which companies are watched

- **Your customers:** every lead you have marked **Won**.
- **Your leads:** leads your assistant has matched to a company on Companies House. Up to 300, the most recent first.
- **Companies you add:** any UK company you type in yourself, such as a customer you had before Be More Swan, or a prospect you know about. Up to 200.

Leads you delete, mark as lost or disqualified, or mark do-not-contact are no longer checked.

Only **UK limited companies and LLPs** on Companies House can be watched. Sole traders and partnerships are not on the register.

## What it tells you

| News | What it can mean |
| --- | --- |
| Appointed a new director | A new decision-maker, often with new plans |
| A director stepped down | Your contact may have left. Check who you are talking to |
| New owner or controller | The company changed hands or took on an investor |
| Moved registered office | A move, often because the business is growing |
| Registered a new charge (borrowing) | The company has borrowed money, often to spend it |
| In liquidation, in administration or dissolved | The company is closing. **Follow-up emails to that lead stop automatically** |

Each item says exactly what the register shows and links to the filing on Companies House, so you can check it yourself.

## What it spots on their website

For leads with a website, the Watch list also reads their site about once a week and tells you when:

- someone senior **joins their team page**
- they **post a new job**, or a careers page appears
- they **add ad tracking** (the Meta Pixel, Google Ads or the TikTok Pixel), which usually means they are starting to advertise
- they **start taking bookings** online (for example Calendly, Fresha, Treatwell or OpenTable)
- they **start selling online** (for example a Shopify or WooCommerce shop, or Stripe payments)
- they **rebuild their website** on a different builder

For companies with **no website**, it looks once a month for a new website with exactly their name. Because a name match is not proof, that news says the site **may be theirs**: check before you mention it.

For US leads that have raised money, it can also spot a new **SEC Form D** filing.

**Nothing from the past is reported.** The first time a company is checked, we only note where it stands. You hear about changes from then on.

## How often

Each company is checked about **once a week**, and again a few days later after good news. You get **one note a day at most**, in Team Chat and your Inbox, and only when there is a reason to get in touch or a warning. Smaller news (like a director leaving) is shown on the tab without a note.

Good news on a lead also **restarts its 30-day countdown** before it moves to Deleted, so a lead with a fresh reason to contact stays in your list.

## Using the tab

1. Open your Lead Generation Assistant and click the **Watch list** tab.
2. **News** shows the last 90 days, newest first.
3. To add a company, type its name or Companies House number under **Add a company** and press **Find**, then **Watch** beside the right one.
4. **Companies watched** lists everything, with filters for Customers, Leads and Added by you. Press **Stop watching** on a lead or customer to stop the checks (you can press **Watch again** later), or **Remove** on a company you added.
5. The switch at the top turns the whole Watch list off and on.

## Asking in chat

Ask your Lead Generation Assistant things like "what's new with my customers?", "watch Acme Signs Ltd" or "stop watching Bolt Fitouts". To change the list, it shows a card, and **nothing changes until you press the card's button**.

The information comes from the Companies House register (Crown copyright, Open Government Licence v3.0).
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = now()
RETURNING title, is_published;

COMMIT;
