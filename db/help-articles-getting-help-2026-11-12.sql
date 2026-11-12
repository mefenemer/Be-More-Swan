-- db/help-articles-getting-help-2026-11-12.sql — Help Centre: how getting help works now (2026-11-12).
--
-- 'Getting Help: Issues, Tickets and Feature Requests' still described four tabs, including a
-- "Report an Issue" tab and a "Support Tickets" tab that became one "Contact us" tab on 2026-10-18.
-- Rewritten for what the product does after PR #555 and the 2026-11-12 support changes:
--   • Contact us: one form; "Something isn't working" becomes an issue, with "How bad is it?"
--   • security and billing go straight to a person (src/utils/support-priority.ts)
--   • matching articles are suggested while typing (help.js)
--   • a fix is reported when it is LIVE, and issues and tickets close after 7 quiet days
--     (issue-fix-live.ts, ticket-auto-close.ts); a reply reopens them
--   • ideas can be sent from any assistant's chat as well as the Feature Requests tab
-- Plus two phrase fixes in other articles that still point at "Report an Issue" / "Support Tickets".
--
-- Same title, so ON CONFLICT (title) updates it in place. Dollar-quoted body (apostrophes are NOT
-- doubled inside $$). The REPLACEs change nothing where the old phrase is already gone.
-- Ship WITH or AFTER the code (it describes article suggestions, the direct route and ticket
-- auto-close, which are in the same change):
--   node scripts/db-migrate.mjs apply --only help-articles-getting-help-2026-11-12 --execute --yes
--   node scripts/db-migrate.mjs apply --only help-articles-getting-help-2026-11-12 --url-var DATABASE_URL_PROD --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Getting Started', 40, 'Getting Help: Issues, Tickets and Feature Requests', $$
# Getting Help: Issues, Tickets and Feature Requests

Everything to do with help lives in **Help & Support** in the sidebar. It has three tabs: **Knowledge Base**, **Contact us** and **Feature Requests**. You can also ask from any assistant's chat.

## Knowledge Base

Guides like this one. Search, or filter by topic. **Still stuck? Contact us** at the foot of every article takes you to the form.

## Contact us

One form for anything you need from the team. Choose what it's about:

- **Something isn't working** — a button that does nothing, a page that won't load, a wrong figure. This becomes an **issue**. Tell us **how bad it is**, **where it happened**, what went wrong and what you expected, and attach a screenshot if you can (PNG, JPG, GIF or WebP, up to 5 MB).
- **How do I…? / Account help**, **An assistant isn't doing what I expect** or **Something else** — a question for the team, answered within 1–2 business days.
- **Billing / Subscription** and **Security, privacy or my data** — these go **straight to a person**, ahead of the usual queue. We aim to reply within one business day.

While you type, articles that might answer your question appear under the box. Open one if it helps, or send as normal. Billing and security messages skip this and go straight to the team.

Everything you've sent is listed beside the form with its status. You get an email copy of each one.

### When it's an issue

- **More info required** — we need something from you. Reply on the issue.
- **Fixed and live** — we tell you when the fix is **live on the site you use**, not before. Press **Confirm fix works**, or **Still broken — reply** to tell us it isn't.
- If we don't hear back within **7 days** of the fix going live, the issue closes on its own. Still broken after that? **Reply to reopen** it.

### When it's a question

- A request marked **Awaiting your reply** is waiting on you. Replying reopens it for the team.
- If we've answered and don't hear back within **7 days**, it closes on its own. Reply within 30 days of it closing and we'll pick it straight back up.

## Feature Requests

Have an idea? Search the **Board** first — if someone has already asked for it, vote for theirs instead (the form suggests similar ideas as you type). Ideas you submit are reviewed before they appear on the Board, and **Roadmap** shows what's planned. Everyone who asked or voted hears when an idea's status changes.

## Asking from an assistant's chat

Tell any assistant something is broken, that you need help, or that you have an idea. It shows you a card with exactly what will be sent, and nothing goes until you press **Send**. Issues and questions then appear in **Contact us**, and ideas in **Feature Requests ▸ Your requests**.

## Ask Your Team Anything

The button at the top of Help & Support (or ⌘K anywhere) asks your assistants directly. It's often the quickest answer to "how do I…?".
$$, TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- "Still stuck?" endings that name the two retired tabs.
UPDATE help_articles
   SET content_md = replace(content_md,
         $$Use **Report an Issue** if something is broken (add a screenshot), or **Support Tickets** for a question. You'll get a reply within 1–2 business days.$$,
         $$Open **Contact us** and choose **Something isn't working** if something is broken (add a screenshot), or another topic for a question. You'll get a reply within 1–2 business days.$$),
       updated_at = NOW()
 WHERE content_md LIKE '%Use **Report an Issue** if something is broken%';

-- The Business Mentor article's support-card line.
UPDATE help_articles
   SET content_md = replace(content_md,
         $$Follow it under **Help & Support ▸ Report an Issue**.$$,
         $$Follow it under **Help & Support ▸ Contact us**, where it shows as an issue.$$),
       updated_at = NOW()
 WHERE content_md LIKE '%Help & Support ▸ Report an Issue%';

COMMIT;
