-- db/help-articles-2026-12-tasks.sql — Help Centre: one monthly task allowance (cutover 2026-10-17)
--
-- Named "2026-12-tasks" so it sorts AFTER db/help-articles-2026-10c.sql (the runner sorts "-" before
-- ".", and "12" after "10").
--
-- ⚠️ APPLY AT CUTOVER ONLY (17 October 2026, with db/ops/task-allowance-cutover.sql and the
-- unified_task_metering flag). Before then these articles describe rules the product doesn't run yet.
--
-- What changed, and why:
--   • AI media credits and X posting credits are retired. Everything comes out of ONE monthly task
--     allowance, weighted for expensive outputs (src/config/task-weights.ts — image 1, video 20,
--     music 20 or 12 shared, X link post 10, X text post 0).
--   • Chat messages and editing helpers no longer use tasks. They sit under a daily fair-use limit
--     per organisation (src/utils/fair-use.ts — defaults 300 chat messages, 200 helper actions, a
--     sliding 24-hour window via checkRateLimit).
--   • Leftover media credits (×4) and unused purchased X credits (1:1) became non-expiring bonus
--     tasks, spent only after the monthly allowance.
--   • Billing & Your Plan (from October 2026) — NEW title. The old "Billing & Your Plan" is
--     unpublished below (ON CONFLICT (title) cannot rename). Upgrade/payment/cancel sections are
--     carried over from db/help-articles-2026-10b.sql unchanged.
--   • What Counts as a Task — NEW, replaces "Tasks and AI Media Credits: What Uses What".
--   • Links to #billing-your-plan in other articles are repointed, and the "AI images" line in
--     "Creating and Editing a Post" stops mentioning credits.
--   • NOT changed here: "The Brand Designer" cost table (db/help-articles-2026-10c.sql) still says
--     "1 AI media credit for a round of four" / "5 AI media credits" — needs the metered cost of a
--     round decided first.
--
-- Plan limits are the placeholder figures (600 / 2,750 / 10,500). Prices are as the pricing page
-- shows them (£29 / £79 / £349) — the seed has the Busywork Buster at £99, resolve before applying.
--
-- Same rules as db/seed-help-articles.sql:
--   • bodies are dollar-quoted — apostrophes are literal (write it's, never it''s)
--   • titles are single-quoted — apostrophes ARE doubled
--   • ON CONFLICT (title) cannot rename — a renamed article needs the old title unpublished below
--   • NO SEMICOLONS inside the bodies, so a web SQL editor that splits on them cannot cut one in half
-- Apply with the migration runner (staging first):
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12-tasks --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Billing & Your Plan', 10, 'Billing & Your Plan (from October 2026)', $$
# Billing & Your Plan

Be More Swan is a monthly subscription. Every plan includes the same assistants. Plans differ in how many can work at once and how many tasks they can do each month.

## The plans

| Plan | Price | Assistants working at once | Tasks per month |
|------|-------|---------------------------|----------------|
| **The Workflow Saver** | £29 / month | 1 | 600 |
| **The Busywork Buster** | £79 / month | 3 | 2,750 |
| **The Digital Employee** | £349 / month | 10 | 10,500 |

The pricing page lists everything else each plan includes — app connections, AI video, reporting and support.

## One task allowance

Since **17 October 2026** there is just one allowance. A task is **one finished piece of work** — a social post, a blog article, a lead search, an email or email flow, an outreach email, or a website audit or draft. A post that goes out to several platforms counts once. Work is counted only once it's delivered, so a failure or a retry never costs you a task.

AI media comes out of the same allowance. An AI image is 1 task, an AI video or music track is 20, and a post to X with a link is 10. See [What Counts as a Task](#what-counts-as-a-task) for the full list.

**Chatting with your assistants is free**, and so are the editing helpers, under a daily fair-use limit.

## Bonus tasks

Bonus tasks are extra tasks that **never expire**. They're used only after your monthly allowance runs out. If you had AI media credits or unused X posting credits on 17 October 2026, they became bonus tasks — 4 tasks for each media credit and 1 for each X credit. Your bonus balance is on the billing page.

## What happens at the limit

We notify you at **80%** of your monthly allowance. Once the allowance and any bonus tasks are used, your assistants pause and new work isn't started. Lead searches you've started wait and begin by themselves when the allowance resets. You are **never charged for going over**.

Your allowance resets on the **1st of each month**. It doesn't roll over. If you upgrade, the higher allowance applies straight away, and paused assistants start working again overnight.

## Managing your subscription

Open **My Account ▸ Billing & Subscription** to:

- see your active plan, tasks used this month and your bonus tasks
- **change your plan** — a downgrade shows you what will change before you confirm
- update your **payment card**
- download **invoices** and see your payment history

Your legal company name, billing email and VAT number for invoices are under **Business Information ▸ Legal & Billing**.

## If a payment fails

We email you to let you know. Update your card under **Payment Method** on the billing page to settle it.

## Pausing or cancelling

Cancelling offers to **pause** instead — your assistants and data are kept, you aren't charged while paused, and you can reactivate any time. If you do cancel, you keep access until the end of the period you've paid for.
$$, TRUE),

('Billing & Your Plan', 20, 'What Counts as a Task', $$
# What Counts as a Task

Your plan has **one monthly task allowance**. A task is one finished piece of work. A few things cost far more to make than words, so they count as several tasks from the same allowance.

## How many tasks each thing uses

| Work | Tasks |
|------|-------|
| A social post — once, however many platforms it goes to | 1 |
| A blog article | 1 |
| A lead search — once, however many leads it finds | 1 |
| An email, or an email flow | 1 |
| An outreach email to a lead | 1 |
| A website audit, draft or rewrite of a page's words | 1 |
| An AI image | 1 |
| An AI video (Busywork Buster and Digital Employee) | 20 |
| An AI music track | 20, or 12 if you share it with the Be More Swan community |
| A post to X with a link | 10 |
| A post to X without a link | nothing extra — it's part of the post's own task |

## By assistant

| Assistant | Uses tasks for |
|-----------|---------------|
| **Social Media Assistant** | Each drafted post, plus any AI image, video or music made for it, and X posts that carry a link |
| **Blog Writing Assistant** | Each drafted article, plus any AI images for it |
| **Email Marketing Assistant** | Each drafted email, and each email flow written for a Marketing Campaign Orchestrator order |
| **Lead Generation Assistant** | Each finished lead search, and each outreach email it drafts |
| **Marketing Campaign Orchestrator** | Nothing itself — the posts, articles, searches and emails it asks your other assistants for are counted where they're made |

## Free, under fair use

These never use tasks:

- **Chatting** with any of your assistants
- **Editing helpers** — rewriting a post, suggesting hooks or overlay text, a quality review, applying suggestions, and compliance checks

To keep the service quick for everyone, each workspace has a daily fair-use limit of **300 chat messages** and **200 helper actions** in any 24 hours. If you reach it, chat or the helpers pause for a while and free up again within a day. You are never charged for them, and they don't touch your task allowance.

## What doesn't use tasks at all

Browsing, approving or scheduling something already drafted, editing a draft yourself, changing settings, connecting apps, uploading your own media, stock photos and videos, and branded text cards.

## When something fails

Nothing is counted until the work is delivered. A draft or an AI image that fails and retries, or never arrives, costs no task.

## Bonus tasks

Bonus tasks never expire and are used only after your monthly allowance runs out. See [Billing & Your Plan (from October 2026)](#billing-your-plan-from-october-2026).

## Seeing your usage

**My Account ▸ Billing & Subscription** shows tasks used this month, what they were used on, and your bonus tasks.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- Replaced above under new titles.
UPDATE help_articles SET is_published = FALSE, updated_at = NOW() WHERE title = 'Billing & Your Plan';
UPDATE help_articles SET is_published = FALSE, updated_at = NOW() WHERE title = 'Tasks and AI Media Credits: What Uses What';

-- In-article links to the old billing article ("What is Be More Swan?" and any other) follow the new title.
UPDATE help_articles
   SET content_md = REPLACE(content_md, '(#billing-your-plan)', '(#billing-your-plan-from-october-2026)'),
       updated_at = NOW()
 WHERE content_md LIKE '%(#billing-your-plan)%';

UPDATE help_articles
   SET content_md = REPLACE(content_md, '(#tasks-and-ai-media-credits-what-uses-what)', '(#what-counts-as-a-task)'),
       updated_at = NOW()
 WHERE content_md LIKE '%(#tasks-and-ai-media-credits-what-uses-what)%';

-- "Creating and Editing a Post" — the AI images line named media credits.
UPDATE help_articles
   SET content_md = REPLACE(content_md,
         'Generating an image uses **AI media credits** from your plan.',
         'Generating an image uses **1 task** from your monthly allowance.'),
       updated_at = NOW()
 WHERE title = 'Creating and Editing a Post'
   AND content_md LIKE '%Generating an image uses **AI media credits** from your plan.%';

COMMIT;
