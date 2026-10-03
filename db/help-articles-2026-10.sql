-- db/help-articles-2026-10.sql — Help Centre refresh (2026-10-03)
--
-- Rewrites the general articles that described a product that no longer exists (a "Standard /
-- Premium" plan pair with 2 or 5 assistants, CRM tiers, an "Integrations" sidebar item), and adds
-- articles for what had none: the assistant page, the Assistant Profile pane, Goals, each live
-- assistant, the post editor, the Audience page and Help & Support itself.
--
-- Every claim was checked against the shipped UI on 2026-10-03 (plans against get-plans, live roles
-- against master-assistants, everything else against the markup that renders it).
--
-- Same rules as db/seed-help-articles.sql:
--   • bodies are dollar-quoted — apostrophes are literal (write it's, never it''s)
--   • titles are single-quoted — apostrophes ARE doubled
--   • ON CONFLICT (title) cannot rename — a renamed article needs the old title unpublished below
--   • NO SEMICOLONS inside the bodies, so a web SQL editor that splits on them cannot cut one in half
-- Apply with the migration runner (staging first):
--   node scripts/db-migrate.mjs apply --only help-articles-2026-10 --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

-- ── Getting Started ─────────────────────────────────────────────────────────────────────────────

('Getting Started', 10, 'What is Be More Swan?', $$
# What is Be More Swan?

Be More Swan gives your business a team of **digital assistants**. Each one is hired for a specific job, learns your business and brand, and does the work — drafting posts, writing blogs and emails, finding and contacting leads, running campaigns — while you stay in charge of what goes out.

## The assistants you can hire today

| Assistant | What it does for you |
|-----------|---------------------|
| **Social Media Assistant** | Plans, writes and schedules on-brand posts for your connected social accounts |
| **Blog Writing Assistant** | Researches and writes long-form posts in your voice, on a cadence you set |
| **Email Marketing Assistant** | Writes newsletters and email campaigns for your Audience, and grows it with sign-up forms |
| **Lead Generation Assistant** | Finds companies that match your ideal customer, scores them, and drafts personal outreach |
| **Marketing Campaign Assistant** | Turns one objective into coordinated work across your other assistants |

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

('Getting Started', 20, 'Your Dashboard Overview', $$
# Your Dashboard Overview

**Dashboard** in the sidebar opens your *Workspace Overview* — what your digital team has been doing, and what it needs from you.

## What's on it

- **Welcome back** — a short summary of what your team did while you were away.
- **The value your team created** — time and money saved. Set your hourly rate in **My Account** to see the money figure, and use *See the tasks behind this* to check the working.
- **When your team is working** — when your assistants are scheduled to do their work.
- **Your ideas and suggestions** — things your assistants suggest doing next. One tap and the assistant gets started.
- **Your workspace** — widgets you choose yourself.

## Arranging your widgets

Open the **Widget library** to switch widgets on or off, then drag the cards into the order you want. The widgets are:

| Widget | Shows |
|--------|-------|
| Value this week | Hours and money saved this week |
| Your assistants | Who is working right now |
| Latest updates | Your most recent activity |
| Tip | A way to get more from your team |
| Invite a teammate | Your referral link |

## Finding your way around

| Sidebar | What's there |
|---------|-------------|
| **Dashboard** | This overview |
| **Inbox** | Notifications from your assistants, and your alert preferences |
| **My Assistants** | Every assistant you've hired. Open one to reach its own page, where its work lives |
| **Audience** | Your contacts — the people who have agreed to hear from you |
| **Calendar** | Everything scheduled, across all your assistants |
| **Review** | Everything waiting for your approval |
| **Refer a Friend** | Your referral rewards |
| **My Account** | Profile, Business Information, notification preferences and billing |
| **Help & Support** | This Help Centre, issue reports, support tickets and feature requests |

> Leads, posts, blogs, emails and connections all live **inside an assistant**. Open the assistant from **My Assistants** to work with them.
$$, TRUE),

('Getting Started', 40, 'Getting Help: Issues, Tickets and Feature Requests', $$
# Getting Help: Issues, Tickets and Feature Requests

Everything to do with help lives in **Help & Support** in the sidebar. It has four tabs.

## Knowledge Base

Guides like this one. Search, or filter by topic. If an article doesn't answer your question, **Still stuck? Open a support ticket** at the foot of every article takes you straight to a ticket.

## Report an Issue

Use this when something is **broken** — a button that does nothing, a page that won't load, a wrong figure.

1. Pick **where it happened**. It's pre-filled with the page you were on before opening Help & Support.
2. Describe what went wrong and what you expected.
3. Attach a screenshot if you can (PNG, JPG, GIF or WebP, up to 5 MB).

Your reports are listed beside the form with their status. When the team needs more from you it's marked **More Info Required**, and when a fix is ready it's marked **Fixed & Ready to Test** — press **Confirm fix works**, or **Still broken — reply** to tell us it isn't.

## Support Tickets

Use this for **questions and account help** — how to do something, why an assistant is behaving a certain way, or billing.

- You get an email confirming your ticket, and the team replies within 1–2 business days.
- Select any ticket in **Your Ticket History** to read the replies and answer in the same thread.
- A ticket marked **Awaiting your reply** is waiting on you. Replying reopens it for the team.

## Feature Requests

Have an idea? Search the **Board** first — if someone has already asked for it, vote for theirs instead (the form suggests similar ideas as you type). Ideas you submit are reviewed before they appear on the Board, and **Roadmap** shows what's planned.

## Ask Your Team Anything

The button at the top of Help & Support (or ⌘K anywhere) asks your assistants directly. It's often the quickest answer to "how do I…?".
$$, TRUE),

-- ── Your Assistants ────────────────────────────────────────────────────────────────────────────

('Your Assistants', 1, 'Your Assistant''s Page', $$
# Your Assistant's Page

Open any assistant from **My Assistants** to reach its own page — where its work is reviewed, its goals are tracked and its settings live.

## The header

- **The name** — click it (or the pencil beside it) to rename your assistant. **Suggest a name** offers ideas.
- **The icon** — click the pencil on the icon to change its letter and colour. The colour is used everywhere the assistant appears: cards, the calendar and notifications.
- **The role and status** under the name show what it does and whether it's working, paused or waiting for you.
- **Chat** opens a conversation with the assistant. Ask it a question, give it a task or steer its work.
- **Assistant Profile** opens everything the assistant knows and follows — see [The Assistant Profile Pane](#the-assistant-profile-pane).

## The overview

- **The main action** — the big button below the header. It's different for each assistant: *Create a Post*, *Write Blog Post*, *Write Email*, *Set an Objective*.
- **Goal Progress** — your targets for this assistant and how close it is. **Check again now** re-measures them on the spot. See [Goals](#goals-setting-targets-and-tracking-progress).
- **Performance Metrics** — the last 30 days of the measures that matter for this role.
- **Autopilot and connections** (Social Media Assistant) — what's being drafted and scheduled, and which platforms it posts to.

## The tabs

Each assistant has tabs for its own work — for example **Review**, **Calendar**, **Goals** and **Activity**, plus role-specific ones such as **Content Library** and **Inspo** for content assistants, or **Searches**, **Enrichment**, **Outreach** and **Conversations** for the Lead Generation Assistant.
$$, TRUE),

('Your Assistants', 2, 'The Assistant Profile Pane', $$
# The Assistant Profile Pane

Press **Assistant Profile** on an assistant's page to open its profile — the brief it works from. It opens with a summary of your setup answers, then the **Operating File**: a card for each part of the brief. Everything here saves automatically.

## Mandate

The bottleneck this assistant was hired to solve. The more specific you are, the better it prioritises. *Quick Start Suggestions* give you a starting point.

## Operational Setup

When the assistant runs and where its content comes from.

- **Trigger** — on demand, when new data arrives, or on a fixed schedule.
- **Content source** — you provide the material, the assistant researches it, or a mix.
- **Posting schedule** (content assistants) — how many posts a week, on which days, at what times, and how far ahead to keep **Review** stocked with drafts.
- **Autopilot mode** (Social Media Assistant) — per platform, either *hold every draft for review* (the default) or *publish without review*. Even in publish mode, a draft is held for you if its caption isn't confidently factual, or it uses an AI-generated image you haven't allowed to auto-publish.
- **Media sources** — where images and video come from.

## Creative Brief

Objective and message, audience and voice, reference and visual style, and a strategy for each platform. Some assistants call this card something that fits their job better.

## Connections

The platforms and apps this assistant uses. **Emergency: Revoke All Connections** cuts every connection at once if you ever need to.

## Rules

- **Strict Rules** — hard MUST DO / NEVER DO constraints. These override everything else.
- **Assistant Rules** — anything else you want written into its brief.
- **What you rejected, and why** — the reasons behind drafts you turned down.
- **Learned Directives** — rules it has learned from your corrections. Toggle one off to pause it, or delete it.

## Brand Safety and Legal

Background knowledge and brand context, the **AI disclosure** shown with its work (required before the assistant can be activated), and what to do when your content library is empty.

## Notifications

How you're alerted about this assistant — approvals, finished work, content and connections — and how urgently to chase you when drafts are waiting. These start from your workspace-wide settings, and a change here applies to this assistant only.
$$, TRUE),

('Your Assistants', 3, 'Goals: Setting Targets and Tracking Progress', $$
# Goals: Setting Targets and Tracking Progress

Goals tell an assistant what success looks like — and it reads them when it decides what to write and which calls to action to use.

## Setting a goal

Open the assistant's **Goals** tab (or **Manage goals** on the Goal Progress card) and add a goal. Every field makes it SMART:

1. **Goal name** — so you can tell your goals apart.
2. **Objective** — *Grow my Audience*, *Increase Interaction*, *Drive Traffic*, or a *Business Outcome*.
3. **Target metric** — the list depends on the objective and on what you've connected. For example Instagram or LinkedIn followers, engagement rate, reach, link clicks, search clicks, qualified leads or email subscribers.
4. **Target value** and **target date**.
5. **Context** — anything that should steer the work toward this goal.

## How progress is measured

- Most metrics are **measured automatically** from your connected accounts by a background check. How often depends on your plan — hourly at best, daily on the entry plan. The Goal Progress card says when the next check is due.
- **Check again now** re-measures every goal on the spot.
- Some figures only you have (revenue, enquiries). These are **reported by you** — enter the latest figure on the card and we'll remind you when one is due.

## When a goal falls behind

If a goal is off pace, the assistant offers a **One-Click Fix** and its own **Recommendations** for getting back on track. Nothing changes until you choose one.
$$, TRUE),

('Your Assistants', 40, 'The Social Media Assistant', $$
# The Social Media Assistant

Plans, writes and schedules on-brand posts for the social accounts you connect.

## How it works

1. **Connect** the platforms you post to, on the assistant's Connections card or under **Assistant Profile ▸ Connections**.
2. Set a **posting schedule** under **Assistant Profile ▸ Operational Setup** — posts per week, days and times.
3. The assistant keeps **Review** stocked with drafts on that schedule. Open one, edit it, and approve it to schedule it.

## Creating a post yourself

Press **Create a Post**, choose the platforms and formats (only platforms switched on for this assistant are offered), and the post editor opens. See [Creating and Editing a Post](#creating-and-editing-a-post).

## Where things live

| Tab | What's there |
|-----|-------------|
| **Review** | Drafts waiting for your approval |
| **Calendar** | What's scheduled and when |
| **Content Library** | Every post, with its platform and status |
| **My Content** | Your own images and videos for the assistant to use |
| **Inspo** | Ideas and topics to draw on |
| **Goals** | Your targets for this assistant |

## Publishing without review

By default every draft waits for you. Under **Autopilot mode** you can let a platform publish without review. Posts still appear on the calendar first, so you can change or cancel one before it goes out, and anything the assistant isn't confident about is held for you regardless.

## Conversion posts

About once a week the assistant writes a **Conversion post** — a direct "here's how to work with me" post built from your service offerings, with a clear call to action. The rest of your posts stay value-first. You review it like any other draft.
$$, TRUE),

('Your Assistants', 45, 'Creating and Editing a Post', $$
# Creating and Editing a Post

The post editor opens full-page when you create a post or open one from **Review**. Breadcrumbs at the top take you back to where you came from.

## The steps

The rail on the left walks you through a post. You can do them in any order.

| Step | What you do |
|------|-------------|
| **Write with your assistant** | Write the caption, or ask the assistant to draft or improve it. *Dictate* lets you speak it |
| **Media** | Upload your own, pick from My Content, find a stock photo or video, or generate an image with AI |
| **On the image** | Add text on top of a picture |
| **Video overlays and sound** | Trim and arrange clips, add text and sound |
| **Link and call to action** | Where the post should send people |
| **Check and improve** | A quality review with suggested fixes |
| **Schedule and publish** | Approve it, and choose when it goes out |

## Platforms and formats

The tabs above the preview are the platforms this post goes to — each with its own caption and media. **Change platform and format** switches between formats (a feed post or a Reel, for example) or adds and removes platforms. A format only accepts the media it can carry, so switching from a video format to an image one asks you for a picture.

## Editing video

Each clip has its own row under **Timeline**:

- Drag either end of the green bar to **trim** the clip.
- Drag the **pink playhead** to find a frame, then press **Split** to cut the clip in two there. Trim, move or remove either half.
- **Duplicate** adds a copy of the clip straight after it.
- **▶** plays just that clip, from the playhead.
- **+ Add text** puts text on that clip, and **Suggest** asks the assistant for a line.
- **+ Add another clip** joins more footage into one video.

Your cut is applied when you approve the post.

## AI images

Generating an image uses **AI media credits** from your plan. Posts with AI-generated images are marked so you can spot them.
$$, TRUE),

('Your Assistants', 50, 'The Blog Writing Assistant', $$
# The Blog Writing Assistant

Researches and writes long-form posts in your voice, on a cadence you set.

## How it works

1. Tell it what to cover during setup — topics, tone and how often to publish.
2. It drafts posts and sends them to **Review**. Press **Write Blog Post** to ask for one on a subject of your choice.
3. Open a post in **Blog Studio** to edit it, then approve it. Approved posts are scheduled into the next free slot of your cadence — you never pick a date by hand.

## Where your blog appears

- **Your own website** — add the blog widget to a page on your site. See [Publishing Your Blog to Your Own Website](#publishing-your-blog-to-your-own-website).
- **LinkedIn** — as an article, once LinkedIn is connected.
- **The Swan Index** — Be More Swan's own publication, if you choose to syndicate there.

## Search performance

Connect **Google Search Console** from Blog Studio to see impressions and clicks for each post. The assistant flags a post for a refresh when its traffic starts to slide.

## Where things live

| Tab | What's there |
|-----|-------------|
| **Review** | Blog drafts waiting for you |
| **Content Library** | Every post and its status |
| **Inspo** | Topics and ideas |
| **Goals** | Targets such as publishing consistency and search clicks |
$$, TRUE),

('Your Assistants', 60, 'The Email Marketing Assistant', $$
# The Email Marketing Assistant

Writes newsletters and email campaigns for your Audience, and helps you grow it.

## Writing an email

Press **Write Email** to open **Email Studio**. Ask the assistant to draft it, or write it yourself, then preview it. When it's ready, **Approve for sending** — or **Send now** — and it goes to the audience or segment you chose. Nothing is sent until you approve it.

## Email campaigns

An email campaign is a planned sequence of emails with a shared aim — welcoming new subscribers, for example. Describe what you want and the assistant plans the whole sequence and drafts each email. Campaigns can start automatically when someone joins through one of your sign-up forms.

## Who receives your emails

Your emails go to your **Audience** — the people who have agreed to hear from you. Only contacts who can be emailed receive anything. Anyone who unsubscribes is never emailed again. See [Your Audience](#your-audience-contacts-segments-and-consent).

## Growing your list

**Sign-up forms** (on the Audience page) give you a form to embed on your website or a hosted page to share. By default, new sign-ups confirm their address by email before they can be emailed — you can switch that off for a form.

## Measuring it

Opens and clicks are recorded where they can be measured, and the assistant's **Performance Metrics** and **Goals** track audience growth and engagement.
$$, TRUE),

('Your Assistants', 70, 'The Marketing Campaign Assistant', $$
# The Marketing Campaign Assistant

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

('Your Assistants', 80, 'The Lead Generation Assistant at a Glance', $$
# The Lead Generation Assistant at a Glance

Finds companies that match your ideal customer, scores them against what you told it, finds their published contact details, and drafts a personal outreach email for each one. You approve every email before it's sent.

## The tabs, in the order you use them

| Tab | What you do there |
|-----|------------------|
| **Searches** | Press **Find New Leads**, describe who you want, review the search plan and approve it |
| **Enrichment** | Every lead in every state. Find contact details, research a company, and move the good ones on |
| **Outreach** | Read each drafted email and approve it. Approving is what sends |
| **Conversations** | Replies, follow-ups, your answers and the deal outcome |
| **Strategy** | What's working, and suggested changes to your targeting |

**Review Lead Ideas** suggests where to find your next customers. Approve one and the assistant runs the search.

## Before your first send

- Add your **business postal address** in Business Information — the law requires it in every outreach email, so nothing sends without it.
- Connect **Gmail** or **Outlook** to send from your own address. Without one, you get each draft to send yourself.

## Read next

- [Setting Up Your First Assistant](#setting-up-your-first-assistant)
- [Finding Leads: How a Search Works](#finding-leads-how-a-search-works)
- [How Lead Scoring Works](#how-lead-scoring-works-and-how-to-trust-it)
- [Sending Outreach and Handling Replies](#sending-outreach-and-handling-replies)
$$, TRUE),

-- ── Audience ────────────────────────────────────────────────────────────────────────────────────

('Audience & Email', 10, 'Your Audience: Contacts, Segments and Consent', $$
# Your Audience: Contacts, Segments and Consent

**Audience** in the sidebar is everyone who has agreed to hear from you. It's shared by every assistant you hire.

## Contact statuses

| Status | Means |
|--------|-------|
| **Can be emailed** | Subscribed and confirmed |
| **Awaiting confirmation** | Signed up but hasn't confirmed yet |
| **Unsubscribed** | Never emailed again |
| **Marked as spam** | Reported an email as spam, and never emailed again |

Open a contact to see their history — how they joined, what they've been sent, and opens and clicks where those could be measured.

## Adding people

- **Add a contact** — one at a time. Only add people who have agreed to hear from you. This is recorded against your account.
- **Import contacts** — upload a CSV. You confirm that everyone in it gave you permission, and when and how. Rows with values we can't trust are skipped and listed, rather than guessed.
- **Sign-up forms** — a form for your website, or a hosted page to share. By default people confirm their own address (double opt-in), which you can switch off per form.
- Leads from your Lead Generation Assistant can be promoted into your audience.

## Segments, tags and custom fields

- **Tags** describe people (*Bought something*, for example).
- **Rule-based segments** are worked out from a rule every time, so they never go stale.
- **Manual segments** are lists you choose yourself.
- **Custom fields** store anything else you want to know about a contact.

Use a segment to send an email to part of your audience.

## Removing someone

Unsubscribing or removing a contact keeps their opt-out on record, so a sign-up form can't add them again by mistake.
$$, TRUE),

-- ── Integrations ───────────────────────────────────────────────────────────────────────────────

('Integrations & Connections', 10, 'Connecting Apps & Integrations', $$
# Connecting Apps & Integrations

Connections belong to an **assistant**. Each one asks for what it needs: the Social Media Assistant needs your social accounts, the Lead Generation Assistant needs a mailbox, and the Blog Writing Assistant can connect LinkedIn and Google Search Console.

## Connecting an app

1. Open the assistant from **My Assistants**.
2. Use its **Connections** card, or **Assistant Profile ▸ Connections**.
3. Press **Connect** next to the app and sign in to it.
4. Grant the permissions it asks for. You're returned to Be More Swan and the connection is confirmed.

Most connections use OAuth, so Be More Swan never sees your password.

## When a connection needs attention

A connection can lapse — a password change, expired permission or revoked access. The assistant shows **Reconnect** on that connection. Press it and sign in again.

> Work and school Microsoft accounts may need your IT administrator to approve the connection.

## What a mailbox does

For the Lead Generation Assistant, connecting **Gmail** or **Outlook** lets it send the outreach you approve from your own address, with replies coming back into its Conversations tab. Without one, every approved lead still gets a drafted email for you to send yourself.

## What a CRM does

A connected CRM is read to build your **suppression list** of existing customers, so cold outreach never lands on someone you already work with. Leads are not pushed into your CRM — export them as a CSV when you want them there.

## Connection limits

Each plan includes a number of app connections. If you reach yours, disconnect one you don't use before adding another.

## Disconnecting

Press **Disconnect** on the connection. Your data in the other app is untouched — only Be More Swan's access is removed. **Assistant Profile ▸ Connections ▸ Emergency: Revoke All Connections** removes every connection at once.
$$, TRUE),

-- ── Billing ────────────────────────────────────────────────────────────────────────────────────

('Billing & Your Plan', 10, 'Billing & Your Plan', $$
# Billing & Your Plan

Be More Swan is a monthly subscription. Every plan includes the same assistants. Plans differ in how many can work at once and how much they can do each month.

## The plans

| Plan | Price | Assistants working at once | Tasks per month |
|------|-------|---------------------------|----------------|
| **The Workflow Saver** | £29 / month | 1 | 500 |
| **The Busywork Buster** | £79 / month | 3 | 2,500 |
| **The Digital Employee** | £349 / month | 10 | 10,000 |

The pricing page lists everything else each plan includes — app connections, AI media credits, reporting and support.

## Tasks, and what happens at the limit

A task is a piece of work an assistant does for you, including chat requests. When you reach your monthly limit, assistants **stop** until the next month or until you upgrade. You are **never charged for going over**.

## AI media credits

Generating images and video uses **AI media credits**, which come with your plan. See your balance under **Usage and Credits** on the billing page.

## Managing your subscription

Open **My Account ▸ Subscription and Billing** to:

- see your active plan, usage and credits
- **change your plan** — a downgrade shows you what will change before you confirm
- update your **payment card**
- download **invoices** and see your payment history
- add your legal company name, billing email and VAT number for your invoices (managed in Business Information)

## If a payment fails

We email you to let you know. Update your card under **Payment Method** on the billing page to settle it.

## Pausing or cancelling

Cancelling offers to **pause** instead — your assistants and data are kept, you aren't charged while paused, and you can reactivate any time. If you do cancel, you keep access until the end of the period you've paid for.
$$, TRUE),

-- ── Troubleshooting ────────────────────────────────────────────────────────────────────────────

('Troubleshooting & Quick Fixes', 10, 'Common Issues: Symptoms, Causes & Fixes', $$
# Common Issues: Symptoms, Causes & Fixes

Find your symptom, read the most likely cause, and follow the quick fix.

## Across your workspace

| Symptom | Most likely cause | Quick fix |
|---------|------------------|-----------|
| A post didn't publish | It wasn't approved, or its platform connection has lapsed | Check **Review** for the post, and press **Reconnect** on the assistant's connection if it's shown |
| An assistant stopped working | Your monthly task limit was reached | Wait for next month, or change your plan under **My Account ▸ Subscription and Billing**. You are never charged for going over |
| Cannot hire another assistant | Your plan's assistant limit is reached | Change your plan, or pause an assistant you don't need |
| A platform isn't offered for a new post | It's switched off for this assistant | Switch it on under **Assistant Profile ▸ Connections** |
| A post says its format can't carry the media | The format needs a different kind of media (a video for a Reel, for example) | Swap the media, or press the suggested format to switch |
| A goal's figure looks out of date | Goals are measured by a background check | Press **Check again now** on the Goal Progress card |
| I don't get alerts I expect | Notifications are set per assistant | **Assistant Profile ▸ Notifications**, or your workspace settings in **Inbox** |

## Lead Generation Assistant

| Symptom | Most likely cause | Quick fix |
|---------|------------------|-----------|
| Approving a lead sent nothing | No business postal address saved | Business Information ▸ **Business postal address**. It's legally required in every outreach email |
| Approving a lead sent nothing | No mailbox connected, or it has lapsed | The assistant's **Connections** — connect or reconnect Gmail or Outlook. Until then each approval hands you the draft to send yourself |
| Approving a lead sent nothing | The lead is flagged do-not-contact, or its address is suppressed | Both are deliberate. A do-not-contact flag can be overridden with a written reason. A suppressed address cannot |
| A lead has no drafted email | It scored cold, or was flagged do-not-contact | Emails are only drafted for hot and warm leads. **Research this lead** on the Enrichment tab can move a rating |
| Most leads show no contact address | Their websites publish none — roughly two in three don't | Add one with **Edit**, press **Look again** later, or read [Why Can't This Lead Be Emailed?](#why-cant-this-lead-be-emailed) |
| A supplier or directory scored highly | Suppliers describe your market in their customers' words | Add them to **Who is NOT a customer?** in setup |
| A search found little or nothing | The queries were too broad, or the wrong shape | Open the search, edit its plan, and run it again |
| Cannot start another search | 10 searches are already running | Pause one on the **Searches** tab |
| Leads vanished from Outreach | They sat 30 days without a decision | They're in **Deleted** at the foot of the Enrichment tab. **Send back for enrichment** returns one |
| Deleting many leads stopped part-way | A very large selection | Press **Delete** again on what's left. Deleted leads move to the Deleted section, nothing is lost |

## Still stuck?

Go to **Help & Support**. Use **Report an Issue** if something is broken (add a screenshot), or **Support Tickets** for a question. You'll get a reply within 1–2 business days.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- Existing articles re-ordered so each sits beside its assistant (general → Social → Blog → Email →
-- Campaign → Lead Generation). Titles unchanged, so these are plain UPDATEs.
UPDATE help_articles SET sort_order = 55, updated_at = NOW() WHERE title = 'Publishing Your Blog to Your Own Website';
UPDATE help_articles SET sort_order = 85, updated_at = NOW() WHERE title = 'Finding Leads: How a Search Works';
UPDATE help_articles SET sort_order = 86, updated_at = NOW() WHERE title = 'How Lead Scoring Works (And How to Trust It)';

COMMIT;
