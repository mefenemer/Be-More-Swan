-- db/help-articles-2026-12zzzzzzzzzz-outreach-stages.sql — Help Centre: the Lead Generator's Outreach
-- tab is now laid out in stages, and the Conversations tab is gone (2026-10-27).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzz-lead-contacts.sql.
-- docs/lead-outreach-restructure-plan.md, Phase 2.
--
-- What changed in the product (written from the code):
--   Outreach strip: 1 To approve │ 2 Following up │ 3 Replied │ 4 Finished │ Archived
--                                       — src/components/assistant-lead-outreach.js
--   which stage a lead is in            — src/config/lead-outreach-phase.ts leadOutreachPhase
--   To approve's two groups             — "Waiting for your approval" / "Approved — send it yourself"
--   Following up / Replied / Finished   — the old Conversations list, one stage at a time
--                                         (src/components/assistant-lead-threads.js)
--   the reply notification              — opens Outreach › Replied (notifications.js)
--
-- Two kinds of statement:
--   1. ONE article rewritten whole, 'Sending Outreach and Handling Replies' — it was built around the
--      old columns and the Conversations tab, so a phrase swap would leave it describing neither. Same
--      title, so ON CONFLICT updates it in place.
--   2. Phrase swaps in the other articles that name the tab in passing. Their live text has been
--      through several rename files, so each swap matches the smallest phrase that is certainly
--      there, and the final SELECT lists anything still saying "Conversations" for a human to read.
--
-- Same rules as the other help files: body dollar-quoted (apostrophes NOT doubled), single-quoted
-- literals with '' for an apostrophe, NO semicolons inside any body or literal (the Neon editor
-- splits pasted scripts on them). Idempotent: every swap is guarded by LIKE on the old phrase, and no
-- new phrase contains an old one. Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzz-outreach-stages --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Lead Management', 20, 'Sending Outreach and Handling Replies', $$
# Sending Outreach and Handling Replies

The **Outreach** tab holds every lead you email, laid out left to right as the steps it goes through:

**1 To approve → 2 Following up → 3 Replied → 4 Finished**, plus **Archived**.

Each lead is in exactly one step, and moves along by itself as things happen.

## 1. To approve

Each lead here shows the email your assistant drafted for it. Read it, edit it if you want, then approve.

Leads arrive two ways: automatically, once a search has scored a company and written its draft, or because you pressed **Move to Outreach** on a lead in the **All leads** tab. Neither route sends anything.

> **Approve & send email** does exactly that — the email goes immediately, from your own connected mailbox. There is no queue to release and no undo.

To approve several at once, tick them (or **Select all**) and press **Approve & send**.

If you have no inbox connected, an approved lead stays here under **Approved — send it yourself**, with its draft ready to copy. Use **Send email now** once you connect Gmail or Outlook, or **Mark outreach sent** if you sent it another way.

## 2. Following up

The email has gone and no reply has come back yet.

If your assistant is set to chase, approving also starts its follow-up plan: **up to three more emails** — after 3 days, then a week, then a short sign-off — each written in the context of the conversation. Each lead shows which follow-up is next and when. They stop the moment the prospect replies, and the last one always says it is the last. Turn the whole thing off with **Chase leads who do not reply?** in the assistant's operational setup.

Open a lead to read everything sent so far, send the next follow-up early, or stop them.

Two groups to know about:

- **Contacted outside the app** — leads you marked as sent yourself. The assistant never saw that email, so it cannot see a reply or send follow-ups. Record how it ends when you know.
- **Needs attention** (in red) — the follow-ups stopped because your mailbox disconnected or sending kept failing. Reconnect your mailbox in Connections.

## 3. Replied

When a prospect replies, three things happen at once:

- follow-up emails to that prospect **stop**
- you get a notification — **Read the reply** opens it here
- the lead moves to **Replied**

Open it to read the thread and **write your answer there**. It sends from the same mailbox, keeps the same subject thread, and their next reply comes back to the same place.

> A reply written from your own email client instead of here still reaches the prospect, but this assistant will not know about it. If they answered your own inbox, press **They replied to me directly** so the follow-ups stop.

## 4. Finished

A lead lands here when you **record its outcome** — won, lost or disqualified — or when the follow-up plan runs out with no reply, or when they ask not to be contacted.

- **Won** — the form has **Add them to my Audience**, ticked to start with. Leave it ticked and they join your Audience as a customer, so your Email Marketing Assistant can write to them.
- Leads with **no reply** are never added to a marketing list. They stay on the normal 30-day clock.

You can record an outcome from any step, including on the phone after a first email. Doing so stops any follow-ups still running.

## Archived

Leads you turned down before anything was sent. The reason feeds your targeting.

## What is in every email

Your assistant's draft, plus a footer added at send time: who the email is from, your business postal address, and a working unsubscribe link. The footer is added by the system rather than written by the assistant, so it cannot be paraphrased away or deleted while editing a draft.

If a prospect clicks unsubscribe — or replies with the word "unsubscribe" — they are recorded immediately, any follow-ups stop, and nothing in the product will email that address again.

## Where the Conversations tab went

It is now steps 2 to 4 of the Outreach tab. Everything it did — the thread, your replies, the follow-up controls, notes and the deal outcome — is in the same place, one step at a time.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  updated_at = now();

-- Tables of tabs ('The Lead Generation Assistant at a Glance', 'Setting Up Your First Assistant'):
-- the Conversations row goes, and the Outreach row describes the steps.
UPDATE help_articles
   SET content_md = replace(replace(replace(replace(content_md,
           '| **Conversations** | Replies, follow-ups, your answers and the deal outcome |' || chr(10), ''),
           '| **Conversations** | What happened after the email: replies, chasers, your own answers, and the deal outcome |' || chr(10), ''),
           '| **Outreach** | Read each drafted email and approve it. Approving is what sends |',
           '| **Outreach** | Every lead you email, step by step: **To approve** (read each drafted email and approve it — approving is what sends), **Following up**, **Replied**, **Finished** |'),
           '| **Outreach** | Read each drafted email and approve or archive it. Approving is what sends |',
           '| **Outreach** | Every lead you email, step by step: **To approve** (read each drafted email and approve or archive it — approving is what sends), **Following up**, **Replied**, **Finished** |'),
       updated_at = now()
 WHERE content_md LIKE '%| **Conversations** |%'
    OR content_md LIKE '%| **Outreach** | Read each drafted email and approve%'
RETURNING title, is_published;

-- Lists of tab names ('Your Assistant''s Page', 'Your Dashboard Overview').
UPDATE help_articles
   SET content_md = replace(replace(content_md,
           '**Outreach** and **Conversations** for the Lead Generation Assistant',
           '**Outreach** and **Results** for the Lead Generation Assistant'),
           'Outreach, Conversations, ', 'Outreach, '),
       updated_at = now()
 WHERE content_md LIKE '%**Outreach** and **Conversations** for the Lead Generation Assistant%'
    OR content_md LIKE '%Outreach, Conversations, %'
RETURNING title, is_published;

-- Passing mentions: where replies land, where Move to Outreach puts a lead, and Common Issues row 11.
UPDATE help_articles
   SET content_md = replace(replace(replace(replace(content_md,
           'with replies coming back into its Conversations tab',
           'with replies coming back into its Outreach tab'),
           'replies routed back into the assistant''s Conversations tab',
           'replies routed back into the assistant''s Outreach tab'),
           'the **Outreach** tab''s **Review** column',
           'the **Outreach** tab''s **To approve** step'),
           'Answer them yourself in the **Conversations** tab',
           'Answer them yourself under **Outreach › Replied**'),
       updated_at = now()
 WHERE content_md LIKE '%into its Conversations tab%'
    OR content_md LIKE '%assistant''s Conversations tab%'
    OR content_md LIKE '%tab''s **Review** column%'
    OR content_md LIKE '%Answer them yourself in the **Conversations** tab%'
RETURNING title, is_published;

COMMIT;

-- What is left that still names the old tab or columns in a PUBLISHED article — expected: no rows.
-- Anything listed is a phrase the swaps above did not anticipate. Read it and fix it in a new file.
SELECT title, substring(content_md from greatest(position('Conversations' in content_md), position('Awaiting reply' in content_md)) - 60 for 140) AS context
  FROM help_articles
 WHERE is_published
   AND (content_md LIKE '%Conversations%' OR content_md LIKE '%Awaiting reply%');
