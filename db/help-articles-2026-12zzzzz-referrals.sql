-- db/help-articles-2026-12zzzzz-referrals.sql — Help Centre: Refer a Friend (2026-10-20).
--
-- Sorts after db/help-articles-2026-12zzzz-price-69.sql. The Help Centre had no referral article,
-- so Ask Your Team (which now answers from these articles, src/utils/help-knowledge.ts) could only
-- guess. Describes "give a month, get a month" (owner, 2026-10-20) exactly as the code does it:
--   • friend: the 14-day trial, then their first paid month free (src/utils/referral-offer.ts)
--   • you: one free month of YOUR plan per paying friend, ready 14 days after their first payment,
--     claimed on Refer a Friend as credit off your next bill (src/utils/referral-tokens.ts)
--   • partners earn cash instead (Partner page), never free months
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzz-referrals --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Billing & Your Plan', 40, 'Refer a Friend: Give a Month, Get a Month', $$
# Refer a Friend: Give a Month, Get a Month

Know another business owner who would get hours back from Be More Swan? Send them your link and you both get a month free.

## What your friend gets

- The usual **14-day free trial**, with no card needed
- Then their **first paid month free** when they choose a plan

## What you get

For every friend who becomes a paying customer, you earn **one free month of your own plan** — the monthly price of the plan you are on, taken off your next bill.

- Your friend's first paid month is free, so your free month is earned when they make their **first payment** after it.
- It is ready to claim **14 days after that payment** (their refund window). Until then it shows as *on the way*.
- There is **no limit** — five paying friends is five free months.

## How to refer someone

1. Open **Refer a Friend** in the side menu.
2. Copy your link, or use **Email a friend** to send it from the page. It is one reusable link — share it as often as you like.
3. Your friend signs up through the link. You can follow each invite and referral on the same page.

## Claiming a free month

When a free month is ready, the **Your free months** card on Refer a Friend shows it. Press **Claim a free month** and the credit is added to your account straight away — it comes off your next bill.

- You need to be on a **paid plan** to claim. Free months earned during your trial wait for you.
- On an annual plan, the credit is held on your account and used against your renewal.

## Partners

If you are a Be More Swan **partner**, people you invite earn you **cash commission** instead of free months. Your link and earnings are on your **Partner** page.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

COMMIT;
