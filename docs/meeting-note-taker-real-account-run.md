# Meeting Note Taker — real-account run on staging (finish plan step 8, FR#38)

**Goal:** approve real meetings on staging and record what each connection produces. **Decision 2:** no
connection is marked Live until **every** one below passes; then step 9 moves them all together.

Staging: https://staging--bemoreswan.netlify.app (steps 2–7 deployed at `bc761ed3`, 2026-11-16).

## 0. Before you start

1. **The hand-off queue must drain on staging.** Approving a meeting queues its hand-offs in
   `scenario_jobs`; until 2026-11-16 nothing ran that queue on staging (`process-scenario-jobs` is a
   scheduled function, which Netlify fires only on production). `run-scenario-jobs` + its row in
   `staging-crons.yml` fix that. After approving, either wait for the next staging-crons tick (GitHub
   delivers these irregularly, often an hour or more apart) or run the workflow by hand:
   **Actions → Staging crons → Run workflow, branch `staging`** (leave *force* off: only due jobs run).
2. One workspace on staging, one **Meeting Note Taker** assistant. Note its id.
3. On that assistant's **Connections** tab, switch on these recipes:
   - **Email a Follow-Up to Attendees** (`email_meeting_followup`)
   - **Post Booked Meeting to Slack** (`slack_meeting_summary`): pick the channel
   - **Create a Notion Page from Meeting Notes** (`notion_create_page`)
   - **Create Jira Tickets from Action Items** (`jira_create_tasks`): the project key, issue type Task
   - **Create Asana Tasks from Action Items** (`asana_create_tasks`): the project id
4. Use a test Slack channel, Jira project, Asana project and Notion page you don't mind filling. Use your
   own addresses (or colleagues who expect it) as the attendees: **these emails really go out.**

## 1. The meeting text (paste into "New meeting" on the Inbox tab)

Change the addresses to ones you control. Two attendees have an address, one doesn't, which tests the
"no email" warning and the chat's add-email card.

```
Weekly ops sync — 16 Nov 2026
Present: Ana Lopez (ana.test@YOURDOMAIN), Bo Chen (bo.test@YOURDOMAIN), Cara Singh

Ana: We're going with vendor A for the packaging, decided.
Bo: Legal sign-off might not land before the 30th, that's a risk.
Ana: Bo, can you chase legal by Friday?
Bo: Yes. Cara, can you update the supplier sheet before the next call?
Cara: Will do. I'll also book the photographer for next week.
Ana: I'll send the revised budget to the board by Wednesday.
```

Expected minutes: 1 decision (vendor A), 1 risk (legal sign-off), 4 action items (Bo, Cara ×2, Ana), a
follow-up email, and Cara with no email.

## 2. Runs

Gmail always wins over Outlook, so each inbox needs its own run.

| Run | Inbox connected | Recipes on | Meeting |
|---|---|---|---|
| **A** | Gmail only | follow-up, Slack, Notion, Jira | paste the text above via **New meeting** |
| **B** | Outlook only (disconnect Gmail) | follow-up, Asana | the same text in the **chat** (paste it, then use the chat's cards) |
| **C** | none (disconnect Outlook) | follow-up only | **New meeting** again, change the title line to "…— run C" |

In run B, also try the chat review cards before approving:
"add cara.test@YOURDOMAIN for Cara", "make the follow-up shorter", then "approve it".

## 3. What to check, per run

| Connection | Pass when |
|---|---|
| Follow-up email (A: Gmail) | Arrives at both addresses **from your Gmail**, and is in Gmail's Sent. No AI notice at the foot (owner 2026-11-16: approved = sent as yours). Inbox card says "This went to the attendees from your Gmail." |
| Follow-up email (B: Outlook) | Arrives **from your Outlook**, all three attendees on one email (Cara added in chat), in Outlook's Sent Items. Inbox says "…from your Outlook." |
| Follow-up email (C: Resend) | From **your business name** at `assistant@outbound.bemoreswan.com`; **Reply-To is you** (reply to it and check it reaches you). Inbox says "…because no inbox is connected — replies come to you. Connect Gmail or Outlook…" |
| Slack (A) | One summary post in the channel listing every action item and its owner. No task messages (decision 10). |
| Notion (A) | One page with the summary, decisions, risks and action items. |
| Jira (A) | 4 issues, one per action item, owner and due date in the text. Re-approving does not make 4 more. |
| Asana (B) | 4 tasks in the project, same rules. |
| Nothing early | Before Approve: no email, post, page or ticket exists anywhere. |

## 4. Checking the records (read-only SQL, staging database)

Replace `:assistant` with the assistant id.

```sql
-- The meetings and how each follow-up went
SELECT id, title, approval_status, data->>'followupSentVia' AS sent_via, data->>'followupSentAt' AS sent_at
FROM assistant_records
WHERE ai_assistant_id = :assistant AND record_type = 'meeting'
ORDER BY updated_at DESC LIMIT 5;

-- The hand-off jobs those approvals queued, and any error
SELECT id, status, attempt, error_message, created_at::text, updated_at::text
FROM scenario_jobs
WHERE assistant_id = :assistant
ORDER BY created_at DESC LIMIT 10;

-- One row per action item, with its ticket
SELECT meeting_record_id, description, assignee, sync_status, external_url
FROM action_items
WHERE meeting_record_id IN (
  SELECT id FROM assistant_records WHERE ai_assistant_id = :assistant AND record_type = 'meeting'
)
ORDER BY meeting_record_id, id;
```

## 5. Results (fill in)

| Connection | Run | Pass? | Link / evidence | Notes |
|---|---|---|---|---|
| Gmail follow-up | A | | | |
| Slack summary | A | | | |
| Notion page | A | | | |
| Jira tickets | A | | | |
| Outlook follow-up | B | | | |
| Asana tickets | B | | | |
| Chat review cards | B | | | |
| Resend fallback (name + Reply-To) | C | | | |
| Long transcript (60 min file, step 4) | any | | | the 26 s limit, unproven so far |

When every row passes, step 9 (go live) can start, after the Note Taker rename PR.
