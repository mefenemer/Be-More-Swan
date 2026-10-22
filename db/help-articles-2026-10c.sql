-- db/help-articles-2026-10c.sql — Help Centre follow-up (2026-10-12)
--
-- • The campaign role is named "Marketing Campaign Orchestrator" in the catalogue (Admin ▸ Assistants).
--   The article was titled "The Marketing Campaign Assistant" — a rename is a NEW title plus the old one
--   unpublished (ON CONFLICT (title) cannot rename, see db/seed-help-articles.sql).
-- • "What is Be More Swan?" listed five live assistants and the old name. Brand Designer is live too.
-- • NEW: The Brand Designer — it had no article. Costs and behaviour from src/config/visual-brief-vocab.ts
--   and explainers.js (brand-brief-*).
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-10c --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Getting Started', 10, 'What is Be More Swan?', $$
# What is Be More Swan?

Be More Swan gives your business a team of **digital assistants**. Each one is hired for a specific job, learns your business and brand, and does the work — drafting posts, writing blogs and emails, finding and contacting leads, running campaigns — while you stay in charge of what goes out.

## The assistants you can hire today

| Assistant | What it does for you |
|-----------|---------------------|
| **Social Media Assistant** | Plans, writes and schedules on-brand posts for your connected social accounts |
| **Blog Writing Assistant** | Researches and writes long-form posts in your voice, on a cadence you set |
| **Email Marketing Assistant** | Writes newsletters and email flows for your Audience, and grows it with sign-up forms |
| **Lead Generation Assistant** | Finds companies that match your ideal customer, scores them, and drafts personal outreach |
| **Marketing Campaign Orchestrator** | Turns one objective into coordinated work across your other assistants |
| **Brand Designer** | Finds stock photos and videos, makes AI images and videos, and designs branded graphics — you pick the ones to use |

More roles are listed in **Hire Assistant** as *Coming soon* — join the waitlist on any of them to be told when it opens.

## You stay in control

- Your assistants **draft**, and by default you **approve** before anything is published or sent. Every approval waits for you in **Review**.
- The Social Media Assistant can be switched to publish without review, one platform at a time — and even then, anything it isn't confident about is held for you.
- Every assistant follows the rules, brand context and AI disclosure you set in its **Assistant Profile**.

## Plans

Every plan includes the same assistants. Plans differ in how many assistants can work at once and how many tasks they can do each month. See [Billing and Your Plan](#billing-your-plan) for the details.

## Getting started

1. Choose a plan.
2. Tell us about your business in **Business Information**.
3. Hire your first assistant from **Hire Assistant**, give it a name, and answer its setup questions. It starts work as soon as you finish.
$$, TRUE),

('Your Assistants', 70, 'The Marketing Campaign Orchestrator', $$
# The Marketing Campaign Orchestrator

Turns one objective into coordinated work across your other assistants — so your posts, blogs, emails and outreach all pull the same way.

## How it works

1. **Set an objective** — tell it what the campaign is for and who it's aimed at.
2. It plans the campaign and writes **briefs** for your other assistants.
3. Their work still comes back to you for approval, as usual.

## The tabs

| Tab | What's there |
|-----|-------------|
| **Campaigns** | Every campaign and what it's doing right now |
| **Decisions** | Choices it wants to make — each with the evidence behind it and what happens if you do nothing. Approving one briefs your other assistants |
| **Orders** | Every instruction it has given another assistant — what it asked for, what it cost and what came back |

## Staying within your allowance

During setup you choose how much of your monthly task allowance one campaign may use — up to a quarter, a half or three quarters — and when it must ask you before acting. That keeps room for your everyday work.

## Measuring success

Each campaign measures what you chose — new leads found, replies from prospects, or pieces published — and its Performance Metrics show what it actually produced and what that cost.

> It works best alongside the assistants it coordinates. Hire those first, then set an objective.
$$, TRUE),

('Your Assistants', 75, 'The Brand Designer', $$
# The Brand Designer

Tell it what a picture or video is for, and it puts options in front of you: free stock photos and videos, graphics in your own brand colours and logo, and AI images or video when you want something unique. Pick the ones you like and they're saved to your library for every assistant to use.

## How it works

1. **Write a brief** — what the picture is for, what it should show, the mood, and anything to avoid.
2. **See the options** — stock, branded cards and AI side by side. Untick a source on the brief and it's never used for that brief.
3. **Pick, or ask again** — approve the ones that fit, or turn options down with a reason and the next round reads it.
4. **Use it anywhere** — approved pictures land in **My Content**, ready for every assistant.

Nothing is used anywhere until you approve it.

## Where the options come from

| Source | Cost |
|--------|------|
| Stock photos and videos (Pexels) | Free |
| Branded cards in your colours, font and logo | Free |
| AI images | 1 AI media credit for a round of four |
| AI video | 5 AI media credits for one short clip — on the Busywork Buster and Digital Employee plans |
| Your own pictures and Canva designs | Free — upload one, or choose from your library |

## Your picture guidelines

Set your photo style, what to include, what never to show and any extra colours under **Business Information ▸ Brand Assets ▸ Picture guidelines**. Every AI image follows them. Stock search can't filter by them, so check stock picks yourself.

## Why did a round miss?

Open **How the designer read your brief** to see the exact words it used for the AI, the stock search and the cards. Turn the misses down with a reason and the next round takes it into account.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

UPDATE help_articles SET is_published = FALSE, updated_at = NOW() WHERE title = 'The Marketing Campaign Assistant';

COMMIT;
