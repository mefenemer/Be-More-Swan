-- db/help-articles-2026-10b.sql — Help Centre update (2026-10-11)
--
-- Named "2026-10b" so it sorts AFTER db/help-articles-2026-10.sql (the migration runner sorts "-"
-- before ".", so a "2026-10-11" name would run first on a fresh database and then be overwritten).
--
-- What changed, and why:
--   • Your Audience — REWRITTEN. It claimed "Leads from your Lead Generation Assistant can be
--     promoted into your audience". That path was removed on 2026-08-21 and leads and the Audience
--     are separate by decision. Also describes the new page: sidebar, filters, grouping, columns,
--     engagement, saving filters as a segment, bulk actions and the growth chart.
--   • Exporting Your Audience to Excel — NEW.
--   • Billing & Your Plan — tasks now count background work (src/utils/work-metering.ts), credits
--     cover music too, and the "upgrade lifts the pause" timing is stated truthfully.
--   • Tasks and AI Media Credits: What Uses What — NEW, per assistant.
--   • Your Setup Guide — NEW. The setup checklist, including the new Products & services step.
--   • Business Information and Products & Services — NEW. The fields, the "i" help icons and the
--     social handle boxes that now take just the handle.
--   • Common Issues — new rows for the task allowance and the waiting lead search.
--
-- Every claim checked against the code on 2026-10-11.
--
-- Same rules as db/seed-help-articles.sql:
--   • bodies are dollar-quoted — apostrophes are literal (write it's, never it''s)
--   • titles are single-quoted — apostrophes ARE doubled
--   • ON CONFLICT (title) cannot rename — a renamed article needs the old title unpublished below
--   • NO SEMICOLONS inside the bodies, so a web SQL editor that splits on them cannot cut one in half
-- Apply with the migration runner (staging first):
--   node scripts/db-migrate.mjs apply --only help-articles-2026-10b --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

-- ── Getting Started ─────────────────────────────────────────────────────────────────────────────

('Getting Started', 25, 'Your Setup Guide', $$
# Your Setup Guide

When you first sign in, the **setup guide** opens on the right of your workspace. It's a checklist of everything your first assistant needs, in order. Each step opens the page where you do it, and ticks itself once that page is filled in. Nothing is typed into the guide itself.

## The steps

| # | Step | What you do |
|---|------|-------------|
| 1 | **Choose your plan** | Pick a plan and activate your account |
| 2 | **Business information** | Your industry, what your business does and who your customers are |
| 3 | **Products & services** | Add at least one thing you sell, with a price if you want it quoted |
| 4 | **Your profile** | Your working hours and timezone |
| 5 | **Compliance & data use** | Review and accept your agreements in **My Account ▸ My Agreements** |
| 6 | **Choose your assistant** | Pick the assistant you want to hire first |
| 7 | **Onboard your assistant** | Answer its setup questions — your goals, brand voice and rules |
| 8 | **Preparing your assistant** | Set its AI disclosure and guardrails, then press **Initiate Kick Off** |
| 9 | **Your assistant goes live** | It starts work |

Steps unlock one at a time. If **Onboard your assistant** looks stuck, the guide shows which setup is still open and who started it, with buttons to resume or cancel it.

## Recommended for you

Under the steps, the guide suggests extras that make your assistants better, picked for the assistants you've hired. None of them hold anything up, and each ticks itself when it's done:

| Suggested when you've hired | Step |
|-----------------------------|------|
| Lead Generation or Email Marketing | Add your business postal address — required in every marketing email |
| Lead Generation | Connect your Gmail or Outlook, so outreach is sent from your own address |
| Email Marketing | Add your first contacts, put a sign-up form on your website, and set up your sending domain |
| Blog Writing | Put your blog on your website with the embed snippet |
| Social Media, Blog Writing, Email Marketing or Brand Designer | Add your logo and brand colours |
| Any assistant | Set your first goal, invite a teammate, and set your hourly rate |

They stay in the guide after your assistant goes live, so you can come back to them from **My Account ▸ Resume setup guide**.

## Why products and services matter

Every assistant reads your products and services list. With it, posts, articles, emails and outreach name what you sell correctly and quote only the prices you give. Without it, they can only describe your business in general terms. See [Business Information and Products & Services](#business-information-and-products-services).

## Closing and reopening the guide

Close the guide and a **Resume** button stays in the corner for the rest of your visit. You can reopen it any time from **My Account ▸ Profile Information ▸ Resume setup guide**. Hiring another assistant later walks you through the assistant steps again for that one only.
$$, TRUE),

('Getting Started', 35, 'Business Information and Products & Services', $$
# Business Information and Products & Services

**My Account ▸ Business Information** is what every assistant knows about your business. It's split into tabs, and everything saves as you type.

> **Not sure what to type?** Hover over (or tap) the pink **i** beside any field. It explains what the field is for and shows an example in the format we expect.

## Business Profile

- **Business name**, **industry** and **website**.
- **Business postal address** — your registered address on one line. It's added to the footer of outreach emails, and the law in the US and Canada requires one, so the Lead Generation Assistant can't send without it. Don't use a home address — prospects see it.
- **Social media accounts** — each box already shows the start of the platform's address (for example *instagram.com/* or *tiktok.com/@*). **Type only your handle**, the part that comes after it. For LinkedIn, first choose **company/** for a business page or **in/** for a personal profile. Pasting a full link works too — it's tidied into the handle when you leave the box. Adding a platform here is what lets you connect it to an assistant later.
- **Other links** — Linktree, booking pages, review pages, one per row.
- **What your business does** and **Target audience** — a couple of specific sentences each. Your assistants read these before they write anything.

## Products & Services

Press **Add Product or Service** and fill in:

| Field | What to enter |
|-------|---------------|
| **Type** | *Product* for something you sell and hand over, *Service* for something you do for people |
| **Name** | Exactly as customers see it |
| **Price** | Written the way you'd say it — *£29*, *from £450*, *£15/month*. Leave it blank and your assistants never mention a price |
| **What it is** | A sentence or two on what the customer gets |
| **Key benefits** | Why people buy it |
| **Who it's for** | The customer it suits best |
| **Link** | The page where people can see or buy it |

Use the arrows to put your most important products first. **Archive** stops your assistants using one without deleting it, and **Restore** brings it back.

## Legal & Billing

Your legal company name, billing email, VAT number and billing address. These appear on your invoices.

## Team Members

Invite colleagues by email and choose a role: **Viewer** (can look, can't change anything), **Member** (uses the assistants and manages content) or **Admin** (everything, including the team and settings).

## Brand Assets

- **Brand style** — accent, background and text colours, a wordmark, a footer line, a font and an optional logo, used on branded text cards. The preview shows a real card.
- **Picture guidelines** — the photo style you want, what to include where it fits, what must never appear, and up to four extra colours. Every AI image follows these.
- **Brand assets** — upload files or add links (brand guides, price lists, brochures) and choose a category so your assistants know how to use each one.
$$, TRUE),

-- ── Audience ────────────────────────────────────────────────────────────────────────────────────

('Audience & Email', 10, 'Your Audience: Contacts, Segments and Consent', $$
# Your Audience: Contacts, Segments and Consent

**Audience** in the sidebar is everyone who has agreed to hear from you. The Email Marketing Assistant sends to it, and an unsubscribe here also stops your Lead Generation Assistant from contacting that address.

## The page

- **On the left** — your **Segments**, **Tags**, **Custom fields**, **API keys** and **Export history**. Click a segment or tag to see who is in it. **Everyone** shows your whole audience.
- **On the right** — the status counts (click one to show just those people), a **New contacts per week** chart, and the list itself.

## Contact statuses

| Status | Means |
|--------|-------|
| **Subscribed** | Can be emailed |
| **Awaiting confirmation** | Signed up but hasn't confirmed their address yet |
| **Unsubscribed** | Asked to stop — never emailed again |
| **Bounced** | Their address doesn't accept email |
| **Marked as spam** | Reported an email as spam — never emailed again |
| **Suppressed** | Blocked by us, for example after repeated bounces |

## Finding people

- **Search** by name, email or company.
- Filter by **status** and **how they joined**. **More filters** adds the date they joined, a **custom field** (has any value, or contains some text) and **engagement** — opened an email in the last 90 days, not opened in 180 days, emailed at least once, or never emailed.
- **Group by** status, how they joined, company, email domain, month joined or tag. Click a column heading to sort.
- **Columns ▾** chooses which columns show, including **Last opened**, **Opens** (for example *2 of 5*) and your custom fields. Your choice is remembered on this browser.

## Saving your filters as a segment

When a filter is on, **Save as segment** turns it into a **rule-based segment** that keeps itself up to date — new people who match join it automatically. A rule can't include search text, a status or a *joined up to* date, so those are named and left out before you save.

## Acting on several people at once

Tick contacts (the box in the heading ticks the whole page), then use the bar that appears: **Add to segment**, **Tag**, **Remove tag**, **Set field** (fill in or clear one custom field for all of them), **Export**, **Unsubscribe** or **Delete**.

## Adding people

- **Add contact** — one at a time. Only add people who have agreed to hear from you. This is recorded against your account.
- **Import CSV** — you confirm that everyone in it gave you permission, and when and how.
- **Sign-up forms** — a form for your website, or a hosted page to share. By default people confirm their own address (double opt-in), which you can switch off per form.
- **API keys** — let your own website, shop or booking system add subscribers.

## Do my leads appear here?

**Not while they're prospects.** Leads found by your Lead Generation Assistant are companies you might contact once, and they haven't agreed to receive your newsletter, so they stay in that assistant's own tabs.

**When a lead becomes a customer, you can add them.** Mark the lead **Won** (Record outcome, on the lead or its conversation) and leave **Add them to my Audience** ticked. They join as **Subscribed**, with *Became a customer* as how they joined. The law allows you to email existing customers about similar products as long as every email lets them unsubscribe — and every email from your Email Marketing Assistant does. Untick the box for a customer who shouldn't get marketing.

A won lead is not added if it has no email address, or if that person asked not to be contacted. Someone already in your Audience keeps their status — an unsubscribe is never undone.

What *does* cross over is a refusal. Someone who unsubscribes or pauses emails here is not sent cold outreach either, and a lead who opts out of outreach is never sent a newsletter.

## Segments, tags and custom fields

- **Tags** describe people (*Bought something*, for example).
- **Rule-based segments** (◆) are worked out from a rule every time, so they never go stale.
- **Manual segments** are lists you choose yourself.
- **Custom fields** store anything else you want to know about a contact.

## Removing someone

Unsubscribing or deleting a contact keeps their opt-out on record, so a sign-up form can't add them again by mistake.
$$, TRUE),

('Audience & Email', 20, 'Exporting Your Audience to Excel', $$
# Exporting Your Audience to Excel

You can download your contacts as an Excel file (.xlsx) that opens in Excel, Numbers or Google Sheets.

## How to export

1. On the **Audience** page, press **Export to Excel** (or tick some contacts and press **Export** in the bar).
2. Choose **who**: the contacts you ticked, everyone matching your current filters and segment, or your whole audience.
3. Tick the **fields** you want. Email, name, company, status, how they joined, tags and date added are ticked to start with. You can add phone, consent details, confirmation and unsubscribe dates, last emailed, last opened, emails sent and opened, timezone, email frequency and any of your custom fields. Your choice is remembered next time.
4. Press **Download .xlsx**.

The file has a bold header row that stays in place as you scroll, with filters already switched on. Large audiences are fetched in batches, so an audience of any size exports in full.

## Export history

Every export is recorded — who exported, when, how many contacts and which fields. Open **Export history** on the left of the Audience page to see it. The data itself is never stored, only the fact that it was exported.

## Look after the file

An export contains personal data. Store it somewhere secure, share it only with people who need it, and delete it when you're done. Anything you do with it outside Be More Swan is your responsibility under data protection law.
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

## Tasks

A task is **one finished piece of work** — a drafted post, a blog article, a lead search, an email or email campaign, a quality review or rewrite of a post, or a message to an assistant in chat. A post that goes out to several platforms counts once. Work is counted only once it's delivered, so a failure or a retry never costs you a task. See [Tasks and AI Media Credits: What Uses What](#tasks-and-ai-media-credits-what-uses-what).

## What happens at the limit

We notify you at **80%** of your monthly allowance. At **100%** your assistants pause and new work isn't started. Lead searches you've started wait and begin by themselves when the allowance resets. You are **never charged for going over**.

Your allowance resets on the **1st of each month**. If you upgrade, the higher allowance applies straight away, and paused assistants start working again overnight.

## AI media credits

Generating images, video and music uses **AI media credits**, which come with your plan. Unused credits roll over to the next month. See your balance under **Usage and Credits** on the billing page.

## Managing your subscription

Open **My Account ▸ Billing & Subscription** to:

- see your active plan, usage and credits
- **change your plan** — a downgrade shows you what will change before you confirm
- update your **payment card**
- download **invoices** and see your payment history

Your legal company name, billing email and VAT number for invoices are under **Business Information ▸ Legal & Billing**.

## If a payment fails

We email you to let you know. Update your card under **Payment Method** on the billing page to settle it.

## Pausing or cancelling

Cancelling offers to **pause** instead — your assistants and data are kept, you aren't charged while paused, and you can reactivate any time. If you do cancel, you keep access until the end of the period you've paid for.
$$, TRUE),

('Billing & Your Plan', 20, 'Tasks and AI Media Credits: What Uses What', $$
# Tasks and AI Media Credits: What Uses What

Your plan comes with two allowances. They measure different things, so they're kept apart.

- **Tasks** — the work your assistants do: writing, researching, reviewing. Monthly, and resets on the 1st.
- **AI media credits** — generating pictures, video and music, which cost far more to make than words. Unused credits roll over.

## By assistant

| Assistant | Uses one task for | Uses AI media credits for |
|-----------|-------------------|---------------------------|
| **Social Media Assistant** | Each drafted post (once, however many platforms it goes to), each quality review, rewrite or suggestion you apply, copying a post to another platform | AI images (1 credit), AI video (5), AI music (5, or 3 if you share the track) |
| **Blog Writing Assistant** | Each drafted article | AI images for an article |
| **Email Marketing Assistant** | Each drafted email — on its own schedule, or when you ask it to draft or rewrite one in Email Studio — and each email campaign written for a Marketing Campaign Orchestrator order | — |
| **Lead Generation Assistant** | Each finished lead search, however many leads it finds | — |
| **Marketing Campaign Orchestrator** | Nothing itself — the posts, articles, searches and emails it asks your other assistants for are counted where they're made | — |
| **Any assistant, in chat** | Each message you send | — |

## What doesn't use either

Browsing, approving or scheduling something already drafted, editing a draft yourself, changing settings, connecting apps, uploading your own media, stock photos and videos, and branded text cards.

## When something fails

Nothing is counted until the work is delivered. A draft that fails and retries, or never arrives, costs no task. A failed AI generation returns its credits.

## Seeing your usage

**My Account ▸ Billing & Subscription** shows tasks used this month and your credit balance. The credit balance also shows on the **My Content** page.
$$, TRUE),

-- ── Troubleshooting ────────────────────────────────────────────────────────────────────────────

('Troubleshooting & Quick Fixes', 10, 'Common Issues: Symptoms, Causes & Fixes', $$
# Common Issues: Symptoms, Causes & Fixes

Find your symptom, read the most likely cause, and follow the quick fix.

## Across your workspace

| Symptom | Most likely cause | Quick fix |
|---------|------------------|-----------|
| A post didn't publish | It wasn't approved, or its platform connection has lapsed | Check **Review** for the post, and press **Reconnect** on the assistant's connection if it's shown |
| An assistant stopped working | Your monthly task allowance was used up | Wait for the 1st, or change your plan under **My Account ▸ Billing & Subscription**. You are never charged for going over |
| A draft failed with *Your monthly task allowance is used up* | The allowance ran out before it started | Nothing was charged. New drafts start again when the allowance resets or you upgrade |
| A lead search says *Waiting — your monthly task allowance is used up* | It was started after the allowance ran out | Nothing to do. It starts by itself on the 1st, or upgrade to start sooner |
| Cannot hire another assistant | Your plan's assistant limit is reached | Change your plan, or pause an assistant you don't need |
| A platform isn't offered for a new post | It's switched off for this assistant, or has no handle in Business Information | Add the handle under **Business Information ▸ Social media accounts**, then switch it on under **Assistant Profile ▸ Connections** |
| I'm not sure what to type in a field | — | Hover over (or tap) the pink **i** beside it for an explanation and an example |
| My leads aren't in my Audience | Only leads you mark **Won** are added, and only if you leave **Add them to my Audience** ticked | Record the outcome as Won with the box ticked. See [Your Audience](#your-audience-contacts-segments-and-consent) |
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

COMMIT;
