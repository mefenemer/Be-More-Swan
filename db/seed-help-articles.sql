-- US-HELP-1.3.1: Help Center seed script
-- All inserts use ON CONFLICT (title) DO UPDATE so re-running is safe (UPSERT).
-- Wrapped in a transaction — all succeed or all roll back.
--
-- ⚠️ TWO QUOTING RULES, AND THEY ARE OPPOSITE. The article BODIES are dollar-quoted ($$ … $$), where
-- everything is literal: write `lead's`, never `lead''s`, or the doubled pair is published verbatim.
-- (It was — twelve of them, reading "lead''s email" in the live Help Centre, fixed 2026-08-17.) The
-- TITLES and the WHERE-clause literals are ordinary single-quoted strings, where an apostrophe MUST
-- be doubled: 'Why Can''t This Lead Be Emailed?'.
--
-- ⚠️ ON CONFLICT (title) CANNOT RENAME AN ARTICLE. Changing a title inserts a new row and leaves the
-- old one published beside it. Retiring copy therefore takes two steps: the new article here, and an
-- explicit UPDATE … is_published = FALSE at the foot of this file.

BEGIN;

-- ── Getting Started ──────────────────────────────────────────────────────────

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Getting Started', 10, 'What is Be More Swan?',
$$
# What is Be More Swan?

Be More Swan is an AI-powered business automation platform that gives you a dedicated **Digital Assistant** trained to handle the repetitive tasks that slow down your day.

## How it works

Your assistant lives in your Be More Swan workspace. You describe what good work looks like in plain English — no coding required — and the assistant carries out tasks based on those instructions.

## Workspace tiers

Be More Swan is available on two tiers:

| Tier | Assistants | Key Features |
|------|-----------|--------------|
| **Standard** | Up to 2 active | Core CRM integrations, CSV export, lead scoring |
| **Premium** | Up to 5 active | All Standard features + premium CRM connections, priority support |

## Assistant roles

Each assistant has a specific role. The current roles available are:

- **Lead Generation Assistant**: Searches the public web for companies matching your ideal customer
  profile, scores them, finds published contact details, and drafts a personalised outreach email for
  each one. You approve every email before it is sent.
- **Social Media Assistant**: Drafts and schedules content across your connected social channels.
- **Blog Writing Assistant**: Researches, drafts and publishes long-form posts on a cadence you set.

## Getting started

1. Choose a plan from the [pricing page](/pricing.html).
2. Complete the onboarding flow to describe your business.
3. Hire your first assistant from the catalogue and answer its setup questions — it is ready to work
   as soon as you finish, with nothing to wait for.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Getting Started', 20, 'Your Dashboard Overview',
$$
# Your Dashboard Overview

Your Be More Swan dashboard is the control centre for your workspace. Here is what you will find on it.

## Workspace summary

The top of the dashboard shows your current workspace at a glance:

- **Active assistants** — how many assistants are currently running versus your tier limit.
- **Plan tier** — Standard or Premium, with a link to upgrade if you need more capacity.
- **Plan gate** — if you have not yet chosen a plan, a prompt will appear asking you to select one before you can use the workspace.

## ROI card

The persistent ROI card below the header tracks the value your assistant has generated:

- **Hours saved** this week and this month
- **GBP value** of that time at your hourly rate (set in Account Settings)
- **Tasks completed** in the current period

## Navigation

Use the left-hand sidebar to move between sections:

| Section | What you will find |
|---------|-------------------|
| Dashboard | Overview and ROI summary |
| My Assistants | Manage your assistants — open one to reach its own tabs, where the work happens |
| Hire Assistant | The catalogue of assistant roles you can add |
| Business Information | Your business profile, brand assets, and the postal address used in outreach emails |
| Notifications | Everything your assistants have told you, and your alert preferences |
| Help | This Help Centre and support tickets |
| Settings | Account, billing, and notification preferences |

> Leads, searches, conversations and connections all live **inside an assistant**, not in the
> sidebar. Open your Lead Generator from **My Assistants** and you will find its tabs across the top:
> Searches, Enrichment, Outreach, Conversations, Calendar and Goals.

## Trial and tier indicators

If you are on a free trial, a countdown badge appears at the top of every page showing how many days remain. When your trial expires, a full-page gate appears — choose a paid plan to restore access.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Getting Started', 30, 'Setting Up Your First Assistant',
$$
# Setting Up Your First Assistant

This guide walks you through setting up a **Lead Generation Assistant**, the most common starting
point for new Be More Swan users. Every step below is something you will actually be asked for.

## Step 1: Hire the assistant

Go to **Hire Assistant**, choose the Lead Generation Assistant, and give it a name. It appears in
**My Assistants** straight away. Everything after this happens inside the assistant itself.

## Step 2: Answer the setup questions

Setup asks a short set of questions and nothing more. There is no rules editor and no scoring
sliders — these answers *are* the configuration, and your assistant is given them verbatim every
time it judges a company.

| Question | What it does |
|----------|-------------|
| **Target industries** | Companies in these industries score higher |
| **Minimum company headcount** | Companies below it score lower |
| **Who is NOT a customer?** | A hard no, not a low score — peers, competitors and resellers never reach your review queue. Optional, and the single most useful answer you can give |
| **Sales tone** | Formal or casual, applied to every drafted email |
| **Send outreach from your own inbox?** | Gmail, Outlook, or "I'll send it myself" |
| **Chase leads who do not reply?** | Whether approving a lead also starts up to three follow-ups |

You can change any of these later from the assistant's **Profile ▸ Operational set-up**.

## Step 3: Add your business postal address

Go to **Business Information** and fill in **Business postal address**.

> **Outreach cannot be sent without it.** Anti-spam law in the US (CAN-SPAM) and Canada (CASL)
> requires a physical postal address in every marketing email, so your assistant will refuse to send
> until one is saved. Use your registered business address — prospects see it in the email footer.

## Step 4: Connect a mailbox (optional)

On the assistant's **Connections** tab, connect Gmail or Outlook. Approved outreach then sends from
your own mailbox, with replies routed back into the assistant.

Without a mailbox you still get everything else — the assistant drafts each email and hands it to you
to send yourself.

## Step 5: Start your first search

Open the **Searches** tab and press **Find New Leads**. Describe who you want to find in plain
English ("boutique hotels in Southern Europe without an online booking system").

Your assistant drafts a **search plan** and shows it to you *before* spending anything. Read the
queries, edit them, then approve. The run searches the public web, scores what it finds against your
setup answers, and files the results.

## Step 6: Work the results

| Tab | What you do there |
|-----|------------------|
| **Searches** | Start searches, review plans, see what each run found |
| **Enrichment** | Every lead in every state. Find contact details, correct details, research a company to improve its rating |
| **Outreach** | Read each drafted email and approve or archive it. Approving is what sends |
| **Conversations** | What happened after the email: replies, chasers, your own answers, and the deal outcome |

Leads left undecided in Outreach for 30 days move to the Deleted section of the Enrichment tab —
you are warned three days beforehand, nothing is destroyed, and one button puts a lead back.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 10, 'How Lead Scoring Works (And How to Trust It)',
$$
# How Lead Scoring Works (And How to Trust It)

Your Lead Generator scores every company it finds from **0 to 100**. The score answers one question:
how well does this company match the profile you described at setup?

## What the score is

There is no formula and no weighting to tune. Your assistant reads what a search turned up about a
company — its own website copy, the search result, and anything a deeper look found — and judges it
against your setup answers: target industries, minimum headcount, and who is *not* a customer.

Every score comes with **reasons**, and each reason names the criterion it met or missed. If the
reasons do not mention your criteria, the assistant did not have enough to go on — which is a signal
about the search, not about the company.

## Score bands

| Score | Band | What it means |
|-------|------|--------------|
| 70–100 | 🔥 **Hot** | Strong profile fit with signs of buying intent |
| 40–69 | 🌡️ **Warm** | Partial fit, or intent that is not clear |
| 0–39 | ❄️ **Cold** | Poor fit, or no intent |

Hot and warm leads get a drafted outreach email. **Cold leads deliberately do not** — nor does
anything flagged do-not-contact. A lead with no drafted email in the Outreach tab is telling you
something about the lead, not hiding a broken feature.

## The gate that runs before the score

Before scoring, the assistant decides *what a result is*. Only an actual target business can score
above 10, whatever else matches:

| Verdict | Example |
|---------|---------|
| **Target business** | A hotel, when you sell to hotels |
| **Supplier to your market** | Software, agencies, logistics, lenders — anyone selling *to* hotels |
| **Aggregator** | A directory or collection listing many hotels |
| **Media** | A trade magazine covering hospitality |
| **Article or guide** | "The 20 best boutique hotels" — a page, not a company |
| **Platform** | A social network, forum or job board |

This exists because suppliers describe your market in exactly the words their customers use, so they
scored hot repeatedly until the judgement was separated from the score.

## What can change a rating

A score is formed from whatever was known at the time — often a single search result. Two things can
move it, both in the **Enrichment** tab:

- **Research this lead** — reads the company properly (site, buying signals, decision makers) and
  re-scores on what it finds. This is the only action that can turn a cold lead warm.
- **Send back for enrichment** — for a lead in the Deleted section: restores it, looks for a contact
  address, and researches it in the same press.

Both cost real money per press, which is why neither runs automatically on every lead.

## Where it disagrees with you

Reject a lead and you are telling the assistant the *targeting* was wrong. Those reasons are kept and
grouped on **Profile ▸ Rules**, where you can see what you have been rejecting and why — and, for
the reasons that support it, exclude that company's domain from future searches.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 20, 'Finding Leads: How a Search Works',
$$
# Finding Leads: How a Search Works

A **search** (your assistant calls them saved searches, and they live on the **Searches** tab) is one
hypothesis about where your next customers are. Everything the Lead Generator does starts here.

## Creating one

Press **Find New Leads** and describe who you want, in plain English. Add a short name, and
optionally words or domains to avoid.

You can also let the assistant propose ideas: **Review Lead Ideas** suggests a few target segments
drawn from your profile, and approving one turns it into a real search.

## The search plan comes first

Your assistant drafts the actual search queries and shows them to you **before spending anything**.
Read them. Edit them. Delete the ones that will not work.

This step exists because a real run once spent its whole budget searching job boards and review sites
— every result useless, and invisible until the money had gone. You now see the queries first.

## What a run does

1. Searches the public web with the approved queries.
2. Resolves each result to the company it is actually about, and drops articles, directories and
   duplicates.
3. Scores every surviving company against your profile.
4. Looks for a published contact address on the hot and warm ones.
5. Files every scored company as a lead, and tells you when it has finished.

Each company appears in the **Enrichment** tab as it is scored, so the tab fills while the run is
still going.

## Cadence and limits

A search can run **once**, **daily** or **weekly**. Every run has built-in ceilings on how many leads
and how much searching it will do, and a workspace can have up to **10 searches running at once** —
pause one to start another. Paused and draft searches do not count.

## Reading the results

The Searches tab states what each search is doing — queued, searching, finished, or failed with a
**Run again** button. Open a finished run to see exactly what it found.

If a run finished and found little, the queries are usually the reason. Edit the search, or start a
narrower one: the assistant is only ever as good as the description of who you want.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 10, 'Why Can''t This Lead Be Emailed?',
$$
# Why Can't This Lead Be Emailed?

Outreach is email only, and most companies do not publish an address. On UK small-business websites
roughly **one in three** does — so "we cannot reach this one" is the normal state of a lead list, not
a fault.

The **Contact** column in the Enrichment tab tells you which case you are in.

| Chip | Meaning | What you can do |
|------|---------|----------------|
| **Role inbox** | A general address like info@ or enquiries@ | Nothing — this is the best case |
| **Named person** | An individual's address, found on their site | Approving asks you to confirm before it sends |
| **None found** | We read their site and it publishes no address | Add one by hand with **Edit**, or press **Look again** later |
| **Checking…** | A lookup is in progress | Wait for the run to finish |
| **Not checked** | Nobody has looked yet — cold leads are not looked up | Research the lead to improve its rating first |

## How addresses are found

1. **Their own website**, free: the home page, /contact, /contact-us and /about are read for a
   published address. We identify ourselves honestly and honour robots.txt.
2. **A paid lookup**, only for hot and warm leads whose site published nothing, and only when your
   workspace has that turned on.

Nothing is guessed. An empty address field is always the truth; an invented one would be worse than
useless.

## The other reasons a send is refused

Approving a lead runs several checks, and each one that stops a send tells you which:

| Reason | What it means |
|--------|--------------|
| **No postal address** | *Yours*, not theirs — add it in Business Information. Legally required in every outreach email, so nothing sends until it is saved |
| **Do not contact** | Qualification decided this is a competitor, an existing customer, or an internal or test account. You can override it with a written reason, which is recorded |
| **Suppressed** | The address, or its whole company, is on your suppression list — usually because your connected CRM says they are already a customer, or because they asked to be left alone |
| **Named individual, unconfirmed** | A scraped personal address. Confirm once and it sends |
| **No mailbox connected** | The email is drafted and handed to you to send yourself |

Every one of these is checked on our side, not just in the browser, so none of them can be skipped by
clicking twice.

## Duplicates

A search cannot file the same company twice — results are resolved to a domain and deduplicated
before anything is scored, including a company's blog post and its home page arriving as separate
hits. There is no merge queue to work through.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 20, 'Sending Outreach and Handling Replies',
$$
# Sending Outreach and Handling Replies

## Approving is sending

The **Outreach** tab holds each lead with the email your assistant drafted for it. Read the email,
edit it if you want, then approve.

> **Approve & send email** does exactly that — the email goes immediately, from your own connected
> mailbox. There is no queue to release and no undo.

If your assistant is set to chase, approving also starts the follow-up sequence: **up to three more
emails** — after 3 days, then a week, then a short sign-off — each written in the context of the
conversation. They stop the moment the prospect replies, and the last one always says it is the last.
Turn the whole thing off with **Chase leads who do not reply?** in the assistant's operational setup.

## The five columns

| Column | What is in it |
|--------|--------------|
| **Review** | Waiting on your decision, with a deliverable email |
| **Approved** | You cleared it. Also where **Send email now** and **Mark outreach sent** live |
| **Awaiting reply** | The email has **already gone** — this is the chase reminder, not a pending send |
| **Archived** | You turned it down. The reason feeds your targeting |

A lead whose email has gone appears in both Approved and Awaiting reply, because each states
something different and true about it. That is why the column counts add up to more than the total.

## What is in every email

Your assistant's draft, plus a footer added at send time: who the email is from, your business
postal address, and a working unsubscribe link. The footer is added by the system rather than written
by the assistant, so it cannot be paraphrased away or deleted while editing a draft.

If a prospect clicks unsubscribe — or replies with the word "unsubscribe" — they are recorded
immediately, any running cadence stops, and nothing in the product will email that address again.

## When they reply

The reply arrives in the **Conversations** tab, and three things happen at once:

- follow-up emails to that prospect **stop**;
- you get a notification (it is the one alert from this assistant worth interrupting you for);
- the conversation moves to **Replied**.

Open the conversation to read the thread and **write your answer there**. It sends from the same
mailbox, keeps the same subject thread, and their next reply comes back to the same place. You can
also send the next chaser early, stop the cadence, add a note, or record how the deal ended.

> A reply written from your own email client instead of here still reaches the prospect, but this
> assistant will not know about it — the transcript stops at their message, and any chaser it writes
> next will not know what you said.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 30, 'The Enrichment Tab: Working a Lead Up',
$$
# The Enrichment Tab: Working a Lead Up

The **Enrichment** tab holds every lead this assistant has scored, in every state, plus anything you
imported from a spreadsheet. It is where a lead is improved rather than judged.

## What you can do to one lead

| Action | What it does | Cost |
|--------|-------------|------|
| **Research this lead** | Reads the company properly — site, buying signals, decision makers — and re-scores it. The only thing that can move a rating | Real money per press |
| **Look again** | Puts a lead with no address back in the queue for the next run to re-read | Free |
| **Send back for enrichment** | Rescues a lead from the Deleted section: restores it, hunts for an address, and researches it in one press | Real money per press |
| **Edit** | Correct the company details, or add a contact address by hand | Free |
| **Add a note** | Contemporaneous notes, newest first, kept with the lead everywhere it appears | Free |
| **Delete** | Removes the lead and records *why* — which is what teaches your targeting | Free |

There is no "research everything" button, deliberately: one click across a full lead list would be
several hundred searches, so each press is a decision you make per lead.

## The columns

Lead, approval state, contact state, score, rating, the suggested next step, how long until it is
retired, and when it last changed. You can filter, sort and group the table by any of them, and the
filters read the same values you see on screen.

## The 30-day clock, and the Deleted section

A lead left sitting in **Outreach ▸ Review** or **▸ Archived** for 30 days without a decision is
moved to the **Deleted** section at the foot of this tab. So is any lead you delete yourself.

- **Nothing is destroyed.** The lead, its research and its history all stay; it leaves your working
  queue and stops appearing as though it were new next time.
- **The reason is kept with it** — never reviewed, rejected, no contact address ever found, or
  deleted by you.
- **Any action on a lead restarts its clock**, and **Send back for enrichment** returns it to the
  pipeline outright.
- **You are warned three days before**, once per assistant, not once per lead.

Approved leads and leads awaiting a reply are never swept — an email has already gone to a real
person, and their conversation is not on a timer.

## Importing your own leads

Use the spreadsheet import for a list you already have: one row per lead, with name, company, email,
website, industry, headcount and notes. Imported leads are scored on arrival like any other, but they
have no discovery history, so **Look again** does not apply to them — use **Send back for
enrichment**, which can work from the website on the record itself.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 40, 'Exporting Leads and Recording Outcomes',
$$
# Exporting Leads and Recording Outcomes

## Getting leads out

Export from the **Enrichment** tab. Nothing is exported automatically and nothing is pushed into a
CRM on its own — an export happens when you ask for one.

| Format | Use it for |
|--------|-----------|
| **CSV** | Anything. Every field the lead has |
| **HubSpot column layout** | Dragging straight into HubSpot's importer — the headers map themselves |
| **Salesforce column layout** | The same, for Salesforce |

The two CRM layouts are column *shapes*, not connections: there is no CRM sync to set up, no
credentials to hold, and nothing to break silently. Deliberately absent from both: any lead status
column (both CRMs model status as a customisable picklist, and a value outside yours fails the row on
import — your approval state goes in the description instead) and any field we do not actually hold,
such as phone number or job title. A blank cell is correct; a plausible guess is not.

## The other direction: your existing customers

If you connect a CRM as an integration, your assistant reads it for one purpose — building a
**suppression list** of companies you already work with, so cold outreach never lands on an existing
customer. That check runs before every send.

## Recording what happened

When a deal ends, record it on the lead or in its conversation: **Won** (with a value), **Lost**, or
**Disqualified** — each with a reason.

This is worth the ten seconds. It is what turns the Overview cards from activity counts into a funnel:

- **Qualified Leads** — how many you cleared for outreach
- **Qualification Rate** — of the leads you ruled on, the share you kept
- **Reply Rate** — prospects who wrote back, out of those actually emailed, with opt-outs beside it
- **Deals Won** — closed-won value, and how many contacted prospects became customers

All four read the last 90 days, because a B2B cycle runs in weeks and months.

> **Lost is not the same as Archived.** *Archived* (rejecting a lead) says the targeting was wrong —
> this company should never have been found. *Lost* or *Disqualified* says you pursued a real prospect
> and it went nowhere. Using the second for the first puts a dead deal in your revenue numbers for a
> company nobody ever contacted, and files the complaint where no search can learn from it.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Integrations & Connections', 10, 'Connecting Apps & Integrations',
$$
# Connecting Apps & Integrations

Go to **Integrations** in the sidebar to connect external apps to your Be More Swan workspace.

## How connections work

Most integrations use **OAuth** — a secure, standardised authorisation flow that never exposes your password to Be More Swan.

**How to connect an app:**

1. Open the assistant that needs the connection and go to its **Connections** tab.
2. Find the app you want to connect and click **Connect**.
3. You will be redirected to that app's login page.
4. Log in and grant the requested permissions.
5. You are redirected back to Be More Swan and the connection is confirmed.

> Connections belong to an **assistant**, not to the workspace sidebar — a Lead Generator needs a
> mailbox, a Social Media Assistant needs social accounts, and each asks for what it needs on its own
> Connections tab.

If the connection fails, you will see an error message with a suggested fix. Common causes are expired sessions or revoked permissions — simply disconnect and reconnect.

## What a mailbox connection does

For a Lead Generator, connecting **Gmail** or **Outlook** is what lets it send the outreach you
approve — from your own address, with replies routed back into the assistant's Conversations tab.
Without one, every approved lead still gets a drafted email; you send it yourself.

> Work and school Microsoft accounts may need your IT administrator to approve the connection.

## What a CRM connection does

Connecting a CRM does **not** export leads to it. Nothing in Be More Swan pushes leads into a CRM,
and leads are exported only when you ask, as a CSV (see
[Exporting Leads and Recording Outcomes](#exporting-leads-and-recording-outcomes)).

A connected CRM is read for one purpose: building your **suppression list** of companies you already
work with, so cold outreach never lands on an existing customer. That check runs before every send.

## Connection limits

Each workspace tier has a limit on the number of active connections. If you reach the limit, disconnect an unused integration before adding a new one.

## Disconnecting an integration

1. Go to **Integrations**.
2. Find the connected app.
3. Click **Disconnect**.

Disconnecting an integration does not delete your data in that external app — it only removes Be More Swan's access.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- ── Billing & Your Plan ──────────────────────────────────────────────────────

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Billing & Your Plan', 10, 'Billing & Your Plan',
$$
# Billing & Your Plan

Be More Swan uses a monthly subscription model. Your plan controls how many assistants you can run simultaneously and which integrations you can access.

## Plan tiers

| Feature | Standard | Premium |
|---------|----------|---------|
| Active assistants | Up to 2 | Up to 5 |
| CRM integrations | Core CRMs (HubSpot, Pipedrive) | All CRMs incl. Salesforce & Dynamics |
| Lead export | CSV + Core CRM | CSV + All CRMs |
| Support | Email support | Priority support |

## Billing cycle

Your subscription renews monthly on the same day you first subscribed. You will receive an email reminder 14 days before each renewal.

## Changing your plan

To upgrade, go to **Settings → Billing** and select a new plan. Upgrades take effect immediately — you are charged the difference pro-rated for the remainder of your billing period.

Downgrades take effect at the end of your current billing period.

## Payment failure

If a payment fails, your plan enters a **Past Due** state. Your assistants continue running during a 7-day grace period. Update your payment method in **Settings → Billing** before the grace period ends to avoid interruption.

## Cancelling

You can cancel at any time from **Settings → Billing → Cancel Subscription**. Your access continues until the end of your current billing period — you will not be charged again after cancellation.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- ── Troubleshooting & Quick Fixes ────────────────────────────────────────────

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Troubleshooting & Quick Fixes', 10, 'Common Issues: Symptoms, Causes & Fixes',
$$
# Common Issues: Symptoms, Causes & Fixes

Use this table to diagnose common problems quickly. Find your symptom in the left column, read the most likely cause, and follow the Quick Fix.

| # | Symptom | Most Likely Cause | Quick Fix |
|---|---------|------------------|-----------|
| 1 | Approving a lead sent nothing | No business postal address saved | Business Information → **Business postal address**. Legally required in every outreach email, so nothing sends until it is filled in. |
| 2 | Approving a lead sent nothing | No mailbox connected, or its connection has lapsed | The assistant's **Connections** tab → connect or reconnect Gmail/Outlook. Until then each approval hands you the draft to send yourself. |
| 3 | Approving a lead sent nothing | The lead is flagged do-not-contact, or its address is suppressed | Both are deliberate. A do-not-contact verdict can be overridden with a written reason; a suppressed address cannot — they asked not to be contacted, or your CRM says they are already a customer. |
| 4 | A lead has no drafted email | It scored **cold**, or was flagged do-not-contact | Not a fault: emails are only drafted for hot and warm leads. **Research this lead** on the Enrichment tab is what can move a rating. See [How Lead Scoring Works](#how-lead-scoring-works-and-how-to-trust-it). |
| 5 | Most leads show no contact address | Their websites publish none — roughly two in three do not | Expected. Add an address by hand with **Edit**, press **Look again** later, or read [Why Can't This Lead Be Emailed?](#why-cant-this-lead-be-emailed). |
| 6 | A lead scored lower than expected | It was judged on a single search result | **Research this lead** reads the company properly and re-scores it. |
| 7 | A supplier or directory scored highly | Suppliers describe your market in their customers' words | Add them to **Who is NOT a customer?** in setup — that list is a hard no, not a low score. |
| 8 | A search found little or nothing | The queries were too broad, or the wrong shape | Open the search, edit its plan, and run it again. The plan is shown before every first run for exactly this reason. |
| 9 | Cannot start another search | 10 searches are already running in this workspace | Pause one on the **Searches** tab. Paused and draft searches do not count. |
| 10 | Leads vanished from the Outreach tab | They sat 30 days without a decision and were retired | They are in the **Deleted** section at the foot of the Enrichment tab, with the reason. **Send back for enrichment** returns one to the pipeline. |
| 11 | A prospect replied but nothing chased them again | Correct — a reply stops the cadence immediately | Answer them yourself in the **Conversations** tab; the thread is where the reply and your answer both live. |
| 12 | Cannot add another assistant | Workspace assistant limit reached | Settings → Billing → change your plan. |

---

> **Still stuck?** Contact our support team with your **workspace ID** and the **lead ID** (both visible in the URL when viewing a lead) and we will investigate within one business day.
> Email: [hello@bemoreswan.com](mailto:hello@bemoreswan.com)
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- Archive the legacy troubleshooting article if it exists
UPDATE help_articles SET is_published = FALSE, updated_at = NOW()
WHERE title = 'Troubleshooting'
  AND title != 'Common Issues: Symptoms, Causes & Fixes';

-- ── Retired articles ─────────────────────────────────────────────────────────
-- ⚠️ These five described a Lead Generator that was never built: a "Lead Inbox" nav item, Simple and
-- Advanced scoring modes with weight sliders, a Pending Merge queue, SMTP email verification, an
-- Enrichment Log with a Re-enrich button, and automatic CRM export of hot leads. Every one of them
-- sent a paying user hunting for a control that does not exist. Their replacements are above under
-- new titles.
--
-- ⚠️ UNPUBLISHED, not deleted, and this cannot be skipped: every insert in this file upserts ON
-- CONFLICT (title), so a rename leaves the ORIGINAL row untouched and still published — the stale
-- article would simply sit next to its replacement. Unpublished rather than DELETEd so an admin can
-- still read what was there while auditing what changed.
UPDATE help_articles SET is_published = FALSE, updated_at = NOW()
WHERE title IN (
  'Setting Up Lead Scoring: Simple Mode vs. Advanced Mode',
  'Why Is My Lead Stuck in ''Pending Merge''?',
  'Understanding Email Verification',
  'How Automated Data Enrichment Works',
  'Exporting Leads: CRM Sync vs. CSV Download'
);

COMMIT;
