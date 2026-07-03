-- US-HELP-1.3.1: Help Center seed script
-- All inserts use ON CONFLICT (title) DO UPDATE so re-running is safe (UPSERT).
-- Wrapped in a transaction — all succeed or all roll back.

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

- **Sales Assistant — Lead Generator**: Finds, scores, enriches, and exports qualified sales leads automatically.
- **Social Media Manager**: Drafts and schedules content across your connected social channels.

## Getting started

1. Choose a plan from the [pricing page](/pricing.html).
2. Complete the onboarding flow to describe your business and ideal customer.
3. Your assistant is configured by the Be More Swan team within one business day.
4. Log in to your workspace and watch it work.
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
| Assistants | Manage and view your active assistants |
| Lead Inbox | Review, merge, and export leads (Lead Generator only) |
| Integrations | Connect CRMs, social accounts, and other apps |
| Help | This Help Center and support tickets |
| Settings | Account, billing, and notification preferences |

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

This guide walks you through setting up your **Sales Assistant — Lead Generator**, the most common starting point for new Be More Swan users.

## Step 1: Complete onboarding

When you first log in after choosing a plan, you will be guided through a short onboarding flow. You will be asked to describe:

- Your business in plain English (e.g. "We sell HR software to medium-sized UK businesses")
- Your ideal customer profile (company size, industry, location, job titles)
- Your scoring priorities (what matters most — company size, buying intent signals, or specific industries)

## Step 2: Choose your lead scoring mode

Be More Swan offers two ways to define your lead scoring rules:

**Simple Mode (recommended for first-time users)**
Write a plain-English description of your ideal customer. The assistant converts it into scoring rules automatically.

**Advanced Mode**
Adjust sliders to control exactly how much weight each factor carries — firmographics, intent triggers, and anti-persona penalties.

> Switching from Simple to Advanced pre-fills the sliders from your description so you do not lose any setup.

## Step 3: Connect a CRM

Go to **Integrations** in the sidebar. Connect your CRM to enable automatic lead export for Hot leads (score ≥ 70).

Standard tier supports core CRM integrations. Premium tier unlocks additional premium CRMs.

## Step 4: Let it run

Once configured, your assistant works in the background — scoring leads, enriching data, and exporting qualifying leads to your CRM automatically. Check your Lead Inbox daily to review Warm leads and resolve any Pending Merge items.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- ── Your Assistants ──────────────────────────────────────────────────────────

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 10, 'How Lead Scoring Works (And How to Trust It)',
$$
# How Lead Scoring Works (And How to Trust It)

Your Lead Generator assistant scores every lead on a scale of **0 to 100**. Think of it as a trust score — the higher the number, the more confident the assistant is that this is the right person to pursue.

## The scoring equation

> **Score = Firmographics + Buying Intent − Anti-Personas**

| Component | What it measures |
|-----------|-----------------|
| **Firmographics** | Company size, industry, location, and other profile data |
| **Buying Intent** | Signals that suggest the person is actively looking to buy |
| **Anti-Personas** | Characteristics that disqualify a lead from your ideal profile |

**Example:** A Head of HR at a 200-person UK software company who has visited your pricing page scores highly on all three axes — strong firmographics, clear intent, no disqualifying traits.

## Score bands

| Score | Band | What happens |
|-------|------|-------------|
| 70–100 | 🔥 **Hot** | Automatically queued for CRM export |
| 40–69 | 🌡️ **Warm** | Appears in Lead Inbox for manual review |
| 0–39 | ❄️ **Cold** | Deprioritised — not exported to CRM |

## Intent Triggers

Intent Triggers are signals that indicate a lead is actively in buying mode. Examples:

- Visiting your pricing page more than once in a week
- Opening a product comparison email
- Requesting a demo or free trial

You can manage your Intent Triggers in **Assistant Settings → Lead Scoring**.

## Simple Mode vs. Advanced Mode

- **Simple Mode**: Describe your ideal customer in plain English. The assistant generates scoring rules from your description.
- **Advanced Mode**: Use sliders to fine-tune how much weight each factor carries.

Switching to Advanced Mode always pre-fills the sliders from your Simple Mode description — no setup is lost.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Your Assistants', 20, 'Setting Up Lead Scoring: Simple Mode vs. Advanced Mode',
$$
# Setting Up Lead Scoring: Simple Mode vs. Advanced Mode

Be More Swan gives you two ways to define your lead scoring rules. Both live in **Assistant Settings → Lead Scoring**.

## Simple Mode

Simple Mode lets you describe your ideal customer in plain English — the assistant converts it into scoring rules automatically.

**Steps:**

1. Go to **Assistant Settings → Lead Scoring**.
2. Select **Simple Mode** (the default for new assistants).
3. Type a plain-English description of your ideal customer. Be specific — include industry, company size, location, and job title.
   > Example: "Head of HR or People Director at a UK-based SaaS company with 50–500 employees."
4. Click **Save Rules**. The assistant generates scoring weights from your description within a few seconds.
5. Check the **Preview** panel to see how recently scored leads would change under the new rules.

## Advanced Mode

Advanced Mode gives you direct control over how much weight each scoring factor carries.

**Steps:**

1. Go to **Assistant Settings → Lead Scoring**.
2. Click **Switch to Advanced Mode**.
3. Adjust the sliders for each scoring dimension:
   - Firmographic match strength
   - Intent trigger weight
   - Anti-persona penalty severity
4. Add or remove specific Intent Triggers and Anti-Persona rules using the + and − buttons.
5. Click **Save Rules** to apply.

> **Before switching back to Simple Mode**, note any custom slider values you want to keep. Switching back replaces Advanced settings with a freshly generated Simple Mode ruleset.

## Switching between modes

| From | To | What happens |
|------|----|-------------|
| Simple → Advanced | Sliders are pre-filled from your description — nothing is lost |
| Advanced → Simple | Slider values are replaced by auto-generated rules from your description |
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- ── Lead Management ──────────────────────────────────────────────────────────

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 10, 'Why Is My Lead Stuck in ''Pending Merge''?',
$$
# Why Is My Lead Stuck in ''Pending Merge''?

When a lead arrives in your inbox with **Pending Merge** status, it means the assistant found another lead in your workspace that looks like the same person or company, but is not certain enough to merge them automatically.

## How deduplication works

Your assistant uses a two-layer deduplication system:

**Layer 1 — Exact match (automatic)**
If two leads share the same email address, the new record is silently merged into the existing one. You never see this happen — it just keeps your inbox clean.

**Layer 2 — Fuzzy match (requires your approval)**
If two leads look similar but are not an exact match — for example, "Acme Ltd" and "Acme Limited" — the assistant flags them for review rather than merging automatically. These appear as **Pending Merge**.

## Why does the assistant not just decide?

Merging two lead records is irreversible. If the assistant merged two leads that turned out to be different people at companies with similar names, you would lose data with no way to undo it. The assistant asks when it is not certain — it is a deliberate protective feature, not a bug.

## How to resolve a Pending Merge

1. Go to **Lead Inbox** in the sidebar.
2. Click the **Pending Merge** tab.
3. Select the flagged lead to open the side-by-side comparison view.
4. Review the two records. Look at company name, domain, location, and job title.
5. Choose one of:
   - **Merge** — combines both records into one (irreversible)
   - **Keep Both** — treats them as separate leads and removes the Pending Merge flag

Most Pending Merge cases can be resolved in under a minute.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 20, 'Understanding Email Verification',
$$
# Understanding Email Verification

Every lead''s email address is automatically verified when it arrives in your workspace. This protects your sending reputation and keeps your CRM clean.

## Why email verification matters

Sending emails to invalid or risky addresses damages your domain reputation — over time, this causes your legitimate emails to land in spam folders. Be More Swan verifies email addresses before exporting them so you only contact addresses that are safe to use.

The verification process checks whether the address exists and can receive mail (using an SMTP check), without actually sending anything.

## Verification results

| Result | What it means | What happens next |
|--------|--------------|------------------|
| **Valid** | Address exists and accepts mail | Lead is eligible for CRM export |
| **Risky** | Catch-all inbox or disposable address — may or may not work | Lead appears in inbox; you decide whether to export manually |
| **Invalid** | Address does not exist or permanently bounces | Lead is blocked from automatic CRM export |

## What to do if a lead is marked Invalid

If you believe a lead''s email has been incorrectly flagged:

1. Open the lead''s detail page in **Lead Inbox**.
2. Update the email address if you have a corrected one.
3. Click **Re-check** to run verification again.

The assistant will re-evaluate the lead and update its export eligibility.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 30, 'How Automated Data Enrichment Works',
$$
# How Automated Data Enrichment Works

When a new lead arrives, your assistant automatically tries to fill in any missing profile information. This process is called **data enrichment**.

## What enrichment fills in

The assistant attempts to find and populate the following fields for each lead:

- Company name
- Website domain
- Industry
- Company size (employee count)
- Location (city and country)
- LinkedIn profile URL
- Job title

## Where to find the Enrichment Log

Open any lead''s detail page in **Lead Inbox**. The **Enrichment Log** panel on the right shows:

- Which fields were filled in successfully
- Which fields show **Not Found** — meaning the assistant could not locate a reliable source for that data

**Not Found** does not mean the data does not exist — it means the assistant did not find it with the information it had at the time.

## How to improve enrichment results

The single most effective thing you can do is add the lead''s **company website domain** to their record. A domain gives the enrichment engine a precise anchor to look up company data.

1. Open the lead detail page.
2. Add or correct the company website domain.
3. Click **Re-enrich**.

The assistant will run enrichment again and fill in as many fields as it can find.

## How enrichment affects the lead score

Firmographic points (company size, industry, location) are only awarded when data is actually present. An unenriched lead with missing firmographics will score lower than the same lead after enrichment fills those fields.

**The lead score updates automatically** after enrichment completes — no manual refresh needed.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Lead Management', 40, 'Exporting Leads: CRM Sync vs. CSV Download',
$$
# Exporting Leads: CRM Sync vs. CSV Download

Be More Swan gives you two ways to get leads out of your workspace and into your sales process.

## Automatic CRM sync

Hot leads (score ≥ 70) with a Valid email address are **automatically exported to your connected CRM** — no manual action needed.

### Conditions that block automatic export

| Condition | Why it blocks export |
|-----------|---------------------|
| Score below 70 | Lead is Warm or Cold — review manually before exporting |
| Invalid email address | Protects your CRM data quality and sending reputation |
| No CRM connected | Go to **Integrations** to connect one |
| CRM connection limit reached | Your workspace tier limits the number of active CRM connections |

## Manual CSV download

You can download any lead as a CSV regardless of its score or email status.

1. Go to **Lead Inbox**.
2. Select the leads you want to export (use the checkbox column to select multiple).
3. Click **Export → Download CSV**.

The CSV includes all available lead data fields.

## CRM availability by tier

| CRM | Standard | Premium |
|-----|----------|---------|
| HubSpot | ✓ | ✓ |
| Pipedrive | ✓ | ✓ |
| Salesforce | — | ✓ |
| Microsoft Dynamics | — | ✓ |
| Zoho CRM | — | ✓ |

Upgrade to Premium to unlock the full CRM library. See [Billing & Your Plan](#billing-your-plan) for pricing details.
$$,
TRUE)
ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  is_published = EXCLUDED.is_published,
  updated_at = NOW();

-- ── Integrations & Connections ───────────────────────────────────────────────

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES
('Integrations & Connections', 10, 'Connecting Apps & Integrations',
$$
# Connecting Apps & Integrations

Go to **Integrations** in the sidebar to connect external apps to your Be More Swan workspace.

## How connections work

Most integrations use **OAuth** — a secure, standardised authorisation flow that never exposes your password to Be More Swan.

**How to connect an app:**

1. Go to **Integrations**.
2. Find the app you want to connect and click **Connect**.
3. You will be redirected to that app''s login page.
4. Log in and grant the requested permissions.
5. You are redirected back to Be More Swan and the connection is confirmed.

If the connection fails, you will see an error message with a suggested fix. Common causes are expired sessions or revoked permissions — simply disconnect and reconnect.

## CRM integrations

CRM connections control where your Hot leads are automatically exported.

**Standard tier CRMs:** HubSpot, Pipedrive
**Premium tier CRMs:** Salesforce, Microsoft Dynamics, Zoho CRM (and all Standard CRMs)

You can only connect CRMs available on your current tier. Upgrade to Premium to unlock the full CRM library.

## Connection limits

Each workspace tier has a limit on the number of active connections. If you reach the limit, disconnect an unused integration before adding a new one.

## Disconnecting an integration

1. Go to **Integrations**.
2. Find the connected app.
3. Click **Disconnect**.

Disconnecting an integration does not delete your data in that external app — it only removes Be More Swan''s access.
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
| 1 | Lead did not export to CRM | Score below 70 (Warm or Cold) | Review lead in Lead Inbox → adjust scoring rules or export manually via CSV if appropriate. See [How Lead Scoring Works](#how-lead-scoring-works-and-how-to-trust-it). |
| 2 | Lead did not export to CRM | Email marked Invalid | Open lead detail → update email address → click Re-check. See [Understanding Email Verification](#understanding-email-verification). |
| 3 | Lead did not export to CRM | CRM connection limit reached | Go to Integrations → disconnect an unused CRM → reconnect your preferred one. |
| 4 | Lead stuck in Pending Merge | Fuzzy duplicate detected — manual review required | Go to Lead Inbox → Pending Merge tab → review side-by-side → choose Merge or Keep Both. See [Why Is My Lead Stuck in ''Pending Merge''?](#why-is-my-lead-stuck-in-pending-merge). |
| 5 | Lead score unexpectedly low | Anti-Persona rule matching this lead | Go to Assistant Settings → Lead Scoring → Anti-Personas → review and adjust rules. |
| 6 | Lead score unexpectedly low | Firmographic data missing on arrival | Add the company website domain to the lead → click Re-enrich. See [How Automated Data Enrichment Works](#how-automated-data-enrichment-works). |
| 7 | Data Enrichment did not run | Insufficient seed data (no email, no domain) | Add at minimum one of: company website domain, LinkedIn URL, or verified email → click Re-enrich. |
| 8 | Cannot add another assistant | Workspace assistant limit reached | Go to Settings → Billing → upgrade to Premium (up to 5 assistants). |
| 9 | Cannot connect a Premium CRM | Workspace on Standard tier | Go to Settings → Billing → upgrade to Premium to unlock Salesforce, Dynamics, and Zoho. |
| 10 | Simple Mode not producing expected scoring rules | Ideal customer description too vague | Rewrite your description to include specific industry, company size range, job titles, and location. The more precise, the better the rules. |

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

COMMIT;
