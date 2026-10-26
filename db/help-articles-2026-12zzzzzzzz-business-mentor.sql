-- db/help-articles-2026-12zzzzzzzz-business-mentor.sql — Help Centre: the Business Mentor (2026-10-26).
--
-- Sorts after db/help-articles-2026-12zzzzzzz-seats-connections.sql. The four articles of
-- docs/business-mentor-plan.md §8.3 / §8.6, one per phase:
--   Meet Your Business Mentor                     Phase 1  (naming, what it can see, nothing without a click)
--   Asking Your Mentor for Help or to Report a Problem  Phase 1  (the mentor_support_request card)
--   Your Business and Marketing Plans             Phase 2  (Plan tab: idea check, plans, break-even, research)
--   Your Weekly Review and Commitments            Phase 3  (weekly review, commitments, track record)
--
-- ⚠️ INSERTED UNPUBLISHED (is_published = FALSE). The Mentor is behind the business_mentor feature flag,
-- so customers can't see it yet, and Ask Your Team answers from PUBLISHED articles only
-- (src/utils/help-knowledge.ts). Publishing now would put copy ahead of the product (§8.6). Publish them
-- at rollout step 6 (§8.5, role Live + flag widened) with the statement at the foot of this file.
-- A re-run never changes is_published, so it can't unpublish them after that.
--
-- Written from the code, not the plan:
--   naming / Quiet mode / weekly review set-up answers — src/public/assistant-onboarding-schemas.js
--   what it can see — src/config/mentor-data-inventory.ts (the "What I can see" panel's own lines)
--   3 a week, Not now = 14 days — src/utils/mentor-proposals.ts WEEKLY_CAP, SNOOZE_DAYS
--   support card text — src/components/disruptive-ui-registry.js mentor_support_request
--   1 task: research, "Draft it for me", a written weekly review — mentor-jobs.ts, mentor-review.ts
--   Get feedback is fair use, no task — mentor-feedback.ts (meterInteraction 'helpers')
--   approving a plan: owner or admin — strategy-documents.ts canApproveStrategy
--   miss reasons — src/utils/mentor-commitments.ts MISS_REASONS
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies (tests/help-articles-business-mentor.test.ts). Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzz-business-mentor --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Your Assistants', 5, 'Meet Your Business Mentor', $$
# Meet Your Business Mentor

Every workspace has a Business Mentor, on every plan. It doesn't take one of your plan's assistant places, and you don't need to hire it.

Your Mentor is your guide and coach. It looks across your whole workspace, tells you what it would sort out first, helps you plan, and checks your team's week with you. It never writes your posts or emails itself. Your other assistants do that.

## Getting started

Open your Mentor from **Your Assistants** and go to its **Chat** tab. On your first visit it asks whether you run an established business or are starting something new:

- **An established business:** it starts from what's already set up here and tells you the few things it would fix first.
- **Something new:** it starts with an idea check, asking who buys, why they'd buy, and how to test it cheaply.

To give your Mentor its own name, rename it on its page, the same way you rename any assistant.

## It never changes anything without your click

When your Mentor suggests a change, it shows a card. The card says what would change, which assistant it changes, and **Why?**: the figures it's based on. Nothing happens until you press the button on the card.

- It makes **at most 3 suggestions a week**. Anything you ask for directly doesn't count towards that.
- **Dismiss** a suggestion with a reason. **Not now** holds that kind of suggestion back for 14 days. **Disagree** and **Not relevant** stop it until you bring it back. Dismissed suggestions are listed on its **Overview** tab, each with **Bring back**.
- Suggestions waiting for an answer are on the Overview tab and in your Inbox under **Needs you**. **Review all** lets you tick the ones you want. Nothing is pre-ticked.
- It only points you at assistants that are **active**. If you ask for one you don't have, it says so and tells you what you could do yourself.

## What it can see

Every time you chat, it sees:

- **Your business:** Business Information, Products & Services and your offers
- **Your team:** each assistant, whether it's active or paused, and its set-up answers
- **Goals** and how close each one is
- **Brand Knowledge** documents and links
- **What your assistants did** in the last two weeks and what's booked next
- **Your plan** and the tasks used this month
- **Its own work:** your plans, what it has looked up for you, its suggestions, weekly reviews, commitments and track record

When you ask, and in the weekly review, it can also look at results such as goal measurements, post performance and email totals, and at your customers through your active assistants (counts, names of won customers, and ratings with short excerpts from reviews).

**It never sees** passwords, connection keys or other secrets, your contacts' personal details, the emails and messages your leads send, or card details and payments. It never reads your chats with your other assistants, or anyone else's chat with it.

The full list is on its **Overview** tab under **What I can see**.

## Quiet mode

Your Mentor can't be paused or archived, because it's included with your workspace. If you'd rather it stayed in the background, turn on **Quiet mode** on its profile, under **When and how I work** (or ask it in chat). It then answers your questions but makes no suggestions, health checks or weekly review until you ask.

## Does it use tasks?

Chatting with your Mentor doesn't use tasks under fair use, and neither does **Get feedback** on its Overview tab. Three things use **1 task each**, and only when they deliver: looking something up with sources, **Draft it for me** on a plan, and a written weekly review. See [What Counts as a Task](#what-counts-as-a-task).
$$, FALSE),

('Your Assistants', 6, 'Asking Your Mentor for Help or to Report a Problem', $$
# Asking Your Mentor for Help or to Report a Problem

You can ask your Business Mentor how to do anything in Be More Swan, and it will tell you the page and the button to use.

## When something isn't working

Tell your Mentor what happened in your own words, for example "the calendar won't load" or "I keep getting logged out". It shows a card ready to send:

- **Report a problem to Be More Swan** goes to the team as an issue report. Follow it under **Help & Support ▸ Report an Issue**.
- **Message Be More Swan support** is for a question, billing, or help with your account. The team replies by email and in Help & Support.

You can read and change what it wrote before you press **Send report** or **Send**.

## What is sent

Only what's written on the card is sent, with the page you were on. Nothing else from your workspace. Never put passwords, card details or other people's personal details in a report.

Your Mentor never says a problem is fixed. The team does that, in Help & Support.

You can still raise an issue or ticket yourself from Help & Support. See [Getting Help: Issues, Tickets and Feature Requests](#getting-help-issues-tickets-and-feature-requests).
$$, FALSE),

('Your Assistants', 7, 'Your Business and Marketing Plans', $$
# Your Business and Marketing Plans

Your Business Mentor keeps your plans on its **Plan** tab. You can work on them there, or in chat. Both save to the same place.

## Your plans

- **Idea check:** the questions an experienced mentor would ask about a new idea, one step at a time (**Back** and **Next** save as you go). Then a **Lean Canvas** with nine boxes you can edit, and your **Riskiest assumptions**, each with a cheap way to test it.
- **Business plan** and **Marketing plan:** edit each section and press **Save draft**. When nothing is saved yet, the sections start from what your workspace already says.

**Draft it for me** has your Mentor draft a whole plan in the background, using 1 task. It waits under **Your Mentor's draft** until you press **Use this draft**. Nothing is saved before then.

## Approving a plan

An owner or admin presses **Approve**. If the draft still has a question your Mentor left for you, answer it first. **Changes** shows what's different from the approved version, and **Earlier versions** keeps the old ones.

Once a plan is approved, your other assistants read it when they draft, so your posts, blogs and emails follow it.

## Break-even calculator

Ask "If I spend £500 on ads, how many sales do I need?" and the calculator works it out. Your Mentor doesn't guess the number. Every input is shown with where it came from, and anything you didn't give it is marked as an assumption.

## Look this up

Ask a research question and your Mentor searches the web, then answers in about two minutes with the links it used. It only keeps links the search actually found. If it finds nothing, it says so rather than guess, and nothing is charged. A delivered answer uses 1 task. Every past answer stays on the Plan tab.

## The playbook

**The playbook I'm using** shows the reviewed guide your Mentor follows for your kind of business, or says there isn't one yet.
$$, FALSE),

('Your Assistants', 8, 'Your Weekly Review and Commitments', $$
# Your Weekly Review and Commitments

## The weekly review

Once a week your Business Mentor compares what happened with your plan and goals. It looks at results from your **active** assistants (this week against last), your goals, your approved plans, last week's commitments and your customers.

- It writes its review in each owner's and admin's chat with the Mentor, and tells you by your own notification settings.
- It suggests **up to 3 changes**, each as a card naming the assistant it changes and why. Nothing changes until you press the button. The same cards are in your Inbox under **Needs you**, and answering one in either place answers it in both.
- It also checks your set-up for things that don't fit together, such as a call to action that can't be used, or a goal for a platform that isn't connected. It tells you where to fix each one.
- If there isn't enough data yet, it says so, names what's missing and asks one coaching question instead. That review uses no task.

A written review uses **1 task**.

**Choose the day** (Monday unless you change it) or switch the review off on your Mentor's profile, under **When and how I work**. An owner or admin can press **Review my week now** on its Overview tab at any time. There's no weekly review in Quiet mode or without a paid plan.

## Commitments

Each week, pick **1 to 3** things you'll do. They're at the top of your Mentor's **Results** tab, and you can set them in chat too. Everyone in the workspace can see everyone's, with your own first.

At the end of the week, mark each one **Done**, **Missed** or **Drop**. A missed one asks why: No time, Didn't know how, Priorities changed, Waiting on someone else, Decided against it, or Other. Your Mentor learns from the reasons. If "No time" keeps coming up, for example, it suggests fewer commitments or an assistant to take the work.

## Track record

The **Track record** panel on the Overview tab lists the suggestions you accepted and what has changed **since**. It says "since", not "because", because many things change in a week. When it's too early or the numbers are too small, it says that plainly.
$$, FALSE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  updated_at = now();

COMMIT;

-- Check (expect 4 rows, is_published = f until rollout step 6):
-- SELECT title, is_published, length(content_md) FROM help_articles WHERE title IN ('Meet Your Business Mentor', 'Asking Your Mentor for Help or to Report a Problem', 'Your Business and Marketing Plans', 'Your Weekly Review and Commitments') ORDER BY sort_order;
--
-- At rollout step 6 (role Live, flag widened), publish them:
-- UPDATE help_articles SET is_published = TRUE, updated_at = now() WHERE title IN ('Meet Your Business Mentor', 'Asking Your Mentor for Help or to Report a Problem', 'Your Business and Marketing Plans', 'Your Weekly Review and Commitments') RETURNING title, is_published;
