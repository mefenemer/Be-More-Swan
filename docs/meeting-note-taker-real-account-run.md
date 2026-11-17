# Meeting Note Taker — real-account run on staging (finish plan step 8, FR#38)

**Goal:** approve real meetings on staging and record what each connection produces. **Decision 2:** no
connection is marked Live until **every** one below passes; then step 9 moves them all together.

Staging: https://staging--bemoreswan.netlify.app (steps 2–7 deployed at `bc761ed3`, 2026-11-16).

**Status (2026-11-17):** runs A and A2 done in Marmalade Productions (org 58), Minute Taker "Orbit Scribe"
(assistant 66), meetings 918 and 919. Gmail, Slack, Notion and Jira pass. **Run B done (meeting 920):**
Outlook (owner marked passed: in Sent Items), Asana and the chat cards pass, but the chat lost its card on 3 of 6 deployed turns
(§6). Run C now checks that nothing is sent without a mailbox (owner, 2026-11-17: no Be More Swan sender). Eleven bugs found and fixed
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
| Follow-up email (C: no inbox) | The follow-up action can't be switched on (Connect Gmail / Connect Outlook in its place; a switch left on says "On, but not sending"). The chat's approve card says the follow-up won't be sent. After approving, **nothing arrives**; the Inbox shows "Follow-up not sent". Connect Gmail, press **Send the follow-up now**: it arrives from your Gmail, once. |
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
| Asana tickets | B | ✅ | 4 tasks: 1220615169703322, …773693, …686301, 1220614692499888 | one per action item, all `synced`, in Mark's first project; Jira switched itself off |
| Outlook follow-up | B | ✅ | sent 17 Nov 14:37 from mefenemer@hotmail.com to +ana, +bo, +cara; in Hotmail's Sent Items (owner checked) | sent once (`handoffs.email_meeting_followup.sentAt`). It did not reach the bmsreview.test Gmail inbox: delivery from a personal Hotmail to Gmail is down to the sending account and the recipient's spam filter, not the app. Owner marked it passed 2026-11-17 |
| Chat review cards | B | ⚠️ | add-email ✅ (card from a local run of the same code), shorten ✅, approve ✅ | the deployed chat lost its card 3 times out of 6 — see §6 |
| No inbox = no email | C | ✅ | meeting 921, 17 Nov | switch-on refused (409 no_mailbox); a switch left on reads "On, but not sending"; the chat's approve card warned; approved → nothing sent, `followupNotSent` stamped, job completed (no retries); Inbox showed "Follow-up not sent"; **Send the follow-up now** refused with no mailbox, then (Gmail reconnected) sent once via Gmail and refused a second press ("already sent") |
| Nothing early | A, A2 | ✅ | | nothing went anywhere before Approve |
| Long transcript (60 min file, step 4) | any | ✅ | 14.1 s, 10.0 s, 9.8 s on deployed staging ("New meeting") | a synthetic 58-minute, 8,433-word, six-speaker meeting with 25 action items; 24–25 action items, 8 decisions, 8–9 risks back each time; well inside the 26 s limit (room for ~1.5–2 h; the form refuses over ~2 h) |

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

**Run B findings (2026-11-17):**
- **Chat lost its card, intermittently.** For the add-email request, the deployed chat (Haiku 5.5): (1) replied
  "I've prepared a card… confirm it on the card" with no card; (2) sent an unreadable reply ("something went
  wrong formatting that"); (3) after #696, an EMPTY reply. The same turn run in-process locally on the same code
  and data came back with the card (as prose + a bare card object, which the parser recovers), and so did 4 of
  4 runs of the prompt alone. "Shorten" and "approve" then worked first time on staging. #696 adds the
  "no card came with this reply" note for that wording and keeps the raw text of unreadable replies;
  **an empty reply still leaves no trace** — next step.
- **The chat said "Cara Singh still has no email address"** beside an approve card that listed her address
  (the card is built from the row and was right). The prose came from the model, not the meeting row.
- ~~Connecting Outlook from the assistant's Connections tab returned to `integrations.html`~~ — not reproduced:
  a connect started on the tab carries the assistant through `state` and the page reopens the tab; this one was
  most likely started from the Integrations page.

**Run C findings (2026-11-17):**
- **The chat filed no meeting.** Pasted notes got "Here are the minutes…" as plain text with no minutes card (the
  model copies the text-only shape of its earlier replies). Fixed by #706: the Minute Taker asks again whenever a
  reply is prose or empty; proven in-process against staging (meeting 921 filed on the retry). #703 also keeps a
  card sent bare or under another key, and turns an empty reply into a message plus a hidden row with its stop reason.
- ~~The approve card says "including 4 action items for your task tracker" with no task tool switched on.~~
  Fixed: it names the tool that is on ("for Asana"), or says the items stay in the Inbox.

**Run D — #706 on the deployed chat (2026-11-17):** three fresh meetings pasted into the same long session
(104) where the chat had dropped cards — runs D1, D2, D3 → meetings 922, 923, 924 filed, and the add-email
and approve cards came back for each: **9 of 9 cards**, no dropped-card rows. Not approved (Gmail connected).
- A Gmail sign-in done outside the browser pane never reached staging (no row saved) — nothing to fix, but
  "connected" should be checked on staging, not taken from the sign-in screen.

**Timing-test finding (2026-11-17): a meeting with the same title overwrote the earlier one.** The three
timing runs all landed in ONE record (#925): records were matched on the title forever, so a later meeting
the model titled alike replaced the earlier one's summary, decisions and action items — even an approved
one. Fixed (`src/utils/hub-records.ts`): only a meeting still waiting for approval and written in the last
hour is refreshed; anything else is a new meeting, with the date and time added when the title is taken.

**Still open:**
- ~~Resend fallback (run C)~~ — **decided 2026-11-17: removed.** The owner does not want customers'
  email sent from a Be More Swan address: with no Gmail or Outlook connected, follow-ups are not sent.
  The action can't be switched on without a mailbox, and a meeting approved without one gets
  "Send the follow-up now" in the Inbox. Nothing to verify in Resend.
- **Before go-live (step 9):** production's Slack/Notion/Jira/Asana apps need the prod redirect URIs,
  public distribution (Atlassian "Sharing", Asana "Any workspace", Slack public distribution) and a
  privacy-policy link on each consent screen.
- Gmail connected for sending is separate from the Email Assistant's mailbox: connecting once should be
  enough (follow-up).
