# Meeting Note Taker — real-account run on staging (finish plan step 8, FR#38)

**Goal:** approve real meetings on staging and record what each connection produces. **Decision 2:** no
connection is marked Live until **every** one below passes; then step 9 moves them all together.

Staging: https://staging--bemoreswan.netlify.app (steps 2–7 deployed at `bc761ed3`, 2026-11-16).

**Status (2026-11-17):** runs A and A2 done in Marmalade Productions (org 58), Minute Taker "Orbit Scribe"
(assistant 66), meetings 918 and 919. Gmail, Slack, Notion and Jira pass; Asana, Outlook and the chat
cards wait on run B; the Resend fallback waits on run C and a decision (§6). Eleven bugs found and fixed
on the way (§6).

## 0. Before you start

1. **The hand-off queue must drain on staging.** Approving a meeting queues its hand-offs in
   `scenario_jobs`; until 2026-11-16 nothing ran that queue on staging (`process-scenario-jobs` is a
   scheduled function, which Netlify fires only on production). `run-scenario-jobs` + its row in
   `staging-crons.yml` fix that. After approving, either wait for the next staging-crons tick (GitHub
   delivers these irregularly, often an hour or more apart) or run the workflow by hand:
   **Actions → Staging crons → Run workflow, branch `staging`** (leave *force* off: only due jobs run).
2. One workspace on staging, one **Meeting Note Taker** assistant. Note its id.
3. On that assistant's **Connections** tab (sections by purpose since #676; "recipes" are now
   **actions**), connect each tool and switch on its action:
   - **Send emails:** Gmail or Outlook, then **Email a Follow-Up to Attendees**
   - **Post to team chat:** Slack, then **Post Booked Meeting to Slack** — pick the channel from the list
     (blank = the workspace's main channel)
   - **Save notes and documents:** Notion, then **Create a Notion Page from Meeting Notes**
   - **Create tasks:** Jira **or** Asana (one at a time since #671), then its action — pick the project
     from the list
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
| Write-up ("New meeting" form) | A, A2 | ✅ | meetings 918, 919 | 1 decision, 1 risk, 4 action items, follow-up email; Cara correctly without an address |
| Gmail follow-up | A, A2 | ✅ | sent 16 Nov 13:59 and 17 Nov 06:38 (`followupSentVia: gmail`) | arrived at both `+` addresses; meeting 918 went twice before #663 (duplicate send, fixed); AI footer dropped by #660 |
| Slack summary | A2 | ✅ | posted 17 Nov 07:42 to the workspace's main channel | first try failed (#general doesn't exist in new workspaces, real error hidden by a logging bug) — fixed by #668 |
| Notion page | A2 | ✅ | created 17 Nov 06:38 | needed the staging redirect URI added to the Notion connection |
| Jira tickets | A2 | ✅ | SCRUM-5, SCRUM-6, SCRUM-7 | stopped after one ticket until #668; three of four because Asana was also on (split, fixed by #671) |
| Asana tickets | A2 / B | ⏳ | 1 task (1220597676877372) from the split | a full four-task run is part of run B |
| Outlook follow-up | B | ⏳ | | |
| Chat review cards | B | ⏳ | | add Cara's address, shorten the follow-up, approve |
| Resend fallback (name + Reply-To) | C | ⛔ | | blocked: `outbound.bemoreswan.com` is not verified in Resend (prod too) — see §6 |
| Nothing early | A, A2 | ✅ | | nothing went anywhere before Approve |
| Long transcript (60 min file, step 4) | any | ⏳ | | the 26 s limit, unproven so far |

When every row passes, step 9 (go live) can start, after the Note Taker rename PR.

## 6. What the run found

| # | Found | Fixed by |
|---|---|---|
| 1 | Staging never ran approval hand-offs (`process-scenario-jobs` is scheduled = prod only) | #643 `run-scenario-jobs` + staging crons |
| 2 | Minute Taker offered no Gmail/Outlook to connect, so follow-ups fell through to Resend | #658 (`MAILBOX_ROLES`) |
| 3 | Connections listed below the actions that need them | #659, then the sections in #676 |
| 4 | AI footer on a human-approved follow-up | #660 (dropped — owner decision) |
| 5 | Re-approving (or a retried job) sent the follow-up / Slack / Notion again | #663 once-per-meeting stamps |
| 6 | Connect buttons on actions returned to the Integrations page, not the assistant | #664 |
| 7 | A failed audit-log insert aborted hand-offs (Jira/Asana stopped after one ticket, Slack's error hidden) | #668 |
| 8 | Slack posted to a #general newer workspaces don't have | #668 (the workspace's main channel) |
| 9 | Typed Jira key / Asana id, an editable issue type, Slack asked for meaningless fields | #671 pickers |
| 10 | Jira and Asana both on split a meeting's tasks | #671 one task tool per assistant |
| 11 | "Recipes" and a cluttered panel | #676 sections by purpose, tool → its actions |

**Setup on staging, not code:** Slack's app credentials were placeholders (new app created); Jira used an
app owned by another Atlassian account (switched to hello@bemoreswan.com's app, staging callback added);
Notion's connection only allowed `/api/auth/callback` (staging callback added); the archived Minute Taker
"Lux" (past its deletion date — the purge job never runs on staging) blocked hiring one (deleted).

**Still open:**
- **Resend fallback (run C):** verify `outbound.bemoreswan.com` in Resend (recommended — keeps
  follow-ups away from login-email reputation) or set `OUTBOUND_EMAIL_DOMAIN=bemoreswan.com` in Netlify.
  Until then the no-inbox fallback fails everywhere, prod included.
- **Before go-live (step 9):** production's Slack/Notion/Jira/Asana apps need the prod redirect URIs,
  public distribution (Atlassian "Sharing", Asana "Any workspace", Slack public distribution) and a
  privacy-policy link on each consent screen.
- Gmail connected for sending is separate from the Email Assistant's mailbox: connecting once should be
  enough (follow-up).
