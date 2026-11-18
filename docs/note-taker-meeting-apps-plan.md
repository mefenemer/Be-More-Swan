# Note Taker — pick up meetings from Google Meet, Teams and Zoom (PLAN)

2026-11-18 · Plan only, nothing built. **All six decisions in §5 agreed by the owner the same day.** Follows `docs/meeting-note-taker-finish-plan.md` (§4 C, step 14).

**Owner decision, 2026-11-18:** keep the name **Note Taker**. Connect by **fetching the transcript after the call**. No bot joins the call. A bot stays a later option (finish plan decision 8).

The `/connections` cards already say this (branch `feat/note-taker-meeting-apps-soon`, on staging): Google Meet, Microsoft Teams and Zoom are Coming soon. Each says "When a … call ends / It picks up the meeting automatically, so there is nothing to paste". No card mentions recordings. This plan builds what those cards say.

## 1. Short answer

- After a call ends, the meeting app's own transcript is fetched and goes through **the same minutes function the paste form uses** (`src/utils/meeting-minutes.ts`). It lands in the Inbox **waiting for approval**, like every other meeting. Nothing is sent before approval.
- **No audio is handled and no new sub-processor is added.** We read text the meeting app has already made. Each app shows its own "transcription has started" notice in the call, so we add no consent step of our own.
- **The main limit:** this works only when the meeting app made a transcript. That means a meeting the connected user **hosted** (or organised), on a **paid plan**, with **transcription switched on**. Personal Microsoft accounts and free Zoom and Gmail accounts are not covered. The connect screen and the help article must say this plainly.
- **About 7 PRs, plus your set-up with each provider.** Provider approval is the slow part: Zoom Marketplace review, Google's scope verification, and Microsoft admin consent. Start all three on day one.

## 2. How each provider works

Checked 2026-11-18 against the providers' docs and developer forums. ⚠️ Step 0 re-checks every item with a real test account before any code depends on it.

| | Zoom | Microsoft Teams | Google Meet |
|---|---|---|---|
| Where the transcript comes from | Cloud recording's audio transcript (.vtt) | Graph `onlineMeeting` → `transcripts` → content (.vtt) | Meet REST API v2 `conferenceRecords` → `transcripts` → `entries` |
| How we learn a meeting ended | Webhook `recording.transcript_completed` (forum reports say it is sometimes late or missing, so also poll the recordings list once a day as a fallback) | **Polling.** Push subscriptions to transcripts need application permissions, which we refuse (as we do for Outlook mail). Every 15 min, read the calendar for online meetings that ended, then ask each one for transcripts | Polling `conferenceRecords` that ended (Workspace Events push is a later improvement) |
| Permission (delegated, as the signed-in user) | User-managed app: `cloud_recording:read:recording`, `cloud_recording:read:meeting_transcript`, `user:read:user` | `OnlineMeetingTranscript.Read.All`, `OnlineMeetings.Read`, `Calendars.Read`, `User.Read`, `offline_access`. Work or school accounts only | `meetings.space.readonly`, `openid email` |
| Customer needs | Pro plan or above, cloud recording **and** "audio transcript" switched on | Microsoft 365 business plan, transcription on (manually or "auto-transcribe") | A Workspace edition that has Meet transcripts (Business Standard or above, to confirm in step 0), transcription on |
| Our approval | Zoom Marketplace app review before other accounts can connect | `…Read.All` delegated is expected to need **tenant admin consent**. A sole trader is their own admin, but in a bigger firm IT must approve. Azure app publisher verification | Google OAuth verification for the Meet scope (confirm in step 0 whether it is "sensitive" or "restricted": restricted means a CASA assessment, which must be priced first, as with Gmail) |
| Existing code to reuse | none, new provider | Same Azure app as `outlook` / `outlook_calendar` (`src/utils/calendar-microsoft.ts`) | Booking calendar's Google Cloud project (`src/utils/calendar-google.ts`); decision 4 |

Each meeting app connects as **its own new provider**: `zoom_meetings`, `teams_meetings`, `google_meet`. They are not extra scopes on the booking calendar connections. Widening `outlook_calendar` or `google_calendar` would send every booking user back through a new consent screen and drag the booking app into a new review. A separate connection keeps each one's disconnect and failure separate.

## 3. Design

**One shape for all three** (`src/utils/meeting-sources/`, one file per provider plus `index.ts`):

```
listEndedMeetings(orgId, since) → [{ externalId, title, startedAt, endedAt, hostEmail }]
fetchTranscript(orgId, externalId) → { text, participants[] } | { notReady } | { none, reason }
```

The provider's .vtt goes through the existing `stripCaptionTimestamps` (`src/utils/meeting-transcript.ts`). Meet entries are joined into the same "Speaker: words" lines. Transcripts longer than `TRANSCRIPT_MAX_CHARS` follow the existing long-transcript rule.

**One ledger table, `meeting_imports`** (SQL `db/z-meeting-imports.sql`, both databases before deploy):
`id, org_id, assistant_id, provider, external_id, title, started_at, ended_at, status (found | written_up | skipped | no_transcript | failed), reason, record_id, transcript_text, transcript_expires_at, created_at`. Unique on `(org_id, provider, external_id)`, so a webhook and a poll that both see the same meeting write it up once.

- `transcript_text` is kept **90 days**, then cleared by the existing retention cron. The minutes stay until the user deletes them (finish plan decision 7).
- `no_transcript` carries the reason in words: "Transcription was off for this call", or "Only the host's account can read this transcript".

**The flow:**
1. **Find.** `meeting-sources-poll` (scheduled, every 15 min) and `zoom-webhook` (signature-checked) add a `found` row for each ended meeting of each connected account.
2. **Write up.** Done automatically or when the user chooses, per decision 1. A background job fetches the transcript, runs the shared minutes function (the same prompt, rules, moderation and model as the paste form) and files the meeting record in the Inbox. It sets `record_id` and `written_up`. Metering asks before and records after (`work-metering`, decision 2).
3. **Approve.** Unchanged: Inbox or chat Approve, then Slack, Notion, Jira or Asana, and the follow-up email from their own Gmail or Outlook.

**GUI** (Note Taker detail):
- **Connections tab:** Zoom, Teams and Google Meet cards, using the existing connect and disconnect pattern. Each states what it needs ("Zoom Pro with cloud recording and audio transcript on") and its last result ("Last meeting picked up 10:42").
- **Inbox tab:** a **"From your meeting apps"** list above the records. Each row shows app badge · title · time · status, with **Write up** / **Skip** for `found` rows and the reason for `no_transcript` rows. A setting (decision 1): *Write up every meeting automatically* / *Let me choose*.

**Chat** (same server actions, GUI-and-chat rule):
- The meetings snapshot gains the found meetings, so "write up my 10am Teams call" works through a `meeting_import_action` card (Write up / Skip).
- The chat can switch the auto setting.
- Regenerate the chat capabilities manifest (FR#17). Correct "cannot join a call" in `assistant-chat-capabilities.ts` to "doesn't join calls; picks up the transcript afterwards from a connected Zoom, Teams or Google Meet".

## 4. Build list (each step one PR)

0. **Set-up and proof (you, with me).** Register the Zoom user-managed app (dev). Add the Graph permissions to the Azure app. Enable the Meet REST API on the chosen Google project. On one real paid account per app, hold a meeting with transcription on and fetch its transcript with a throwaway script. **Write down every surprise in this file.** Submit the three reviews the same day. Done: three real transcripts fetched; the scope class for Meet and the admin-consent behaviour for Teams confirmed.
1. **Spine.** `meeting_imports` SQL, the source interface, the write-up job into the shared minutes function, retention, the cost key, and tests with every provider stubbed. Nothing visible changes. Proof: a stubbed test (found → written up → Inbox record), a duplicate-delivery test, and a metering-order test.
2. **Zoom.** OAuth connect and refresh, `zoom-webhook` (Zoom URL validation plus signature check), the daily fallback poll, and download with retry while the file is not ready. Proof: fixture tests on real (anonymised) payloads, and one real meeting on staging.
3. **Teams.** `teams_meetings` OAuth on the Azure app, a calendar-driven poll (join URL → `onlineMeeting` id → transcripts), and a clear message when admin consent is needed. Proof: as step 2.
4. **Google Meet.** `google_meet` OAuth, a `conferenceRecords` poll, and entries → lines. Proof: as step 2.
5. **GUI.** Connection cards, the "From your meeting apps" list, Write up / Skip, the auto setting, and the help article ("What your meeting app must have switched on"). Proof: component harness at phone and desktop width.
6. **Chat parity.** Snapshot, the `meeting_import_action` card, the settings switch, and the capabilities manifest. Proof: capabilities test plus card test.
7. **Go live, per app** (decision 3). Real-account run on staging, then flip that app's `/connections` card to Live, update the FAQ, the homepage mention, `tests/homepage-faq-2026-11-03.test.ts` and the privacy page ("we read the transcript your meeting app made; we never receive audio").

Steps 2–4 depend on step 1 and do not touch each other's files, so they can run in parallel once step 1 is merged.

## 5. Decisions for the owner

All six answered 2026-11-18: the owner agreed every recommendation below.

1. **Write up every meeting, or let the user choose?** ✅ **Agreed:** **let them choose by default, with an "every meeting" switch.** Many meetings are 1:1s, interviews or personal calls the business won't want summarised. An automatic write-up still waits in the Inbox, so nothing is sent either way.
2. **Charging.** Today pasted text and attached files cost no task. A picked-up meeting is background work, so it spends tasks (memory: background work metered). ✅ **Agreed:** **1 task per meeting written up** (new cost key `meeting_import`, set in Admin → Task costs, quoted with `data-task-cost`). Finding meetings and skipping them is free. Our cost is one minutes call of about 2p–5p, so 1 task covers it on every plan.
3. **Go live together or one at a time?** The finish plan held every connection until all passed. Here the three reviews will finish weeks apart. ✅ **Agreed:** **each app goes Live when it passes its own real-account run.** The other cards stay Coming soon.
4. **Google project.** Use the booking calendar's Google Cloud project (one consent screen and brand; its review history counts) or a new one (a Meet review can't hold up booking). ✅ **Agreed:** **a new project**, as we did for Gmail and the booking calendar, so neither review can block the other.
5. **Teams admin consent.** If step 0 confirms the transcript permission needs a tenant admin, then in firms with IT the user must ask them. ✅ **Agreed:** accept it, show an "Ask your IT admin to approve Be More Swan" message with the admin-consent link, and say so in the help article. The alternative is a bot, which this plan avoids.
6. **Order of work.** ✅ **Agreed:** **Zoom first.** It is the most common app among small businesses, its push is simplest, and its review is mostly paperwork. Then Teams (the Azure app already exists), then Meet (the longest review).

## 6. Not in this plan

- A bot that joins calls (finish plan decision 8; revisit once usage of this is known).
- Meetings the user only attended. The host's account owns the transcript on all three apps.
- Uploading recordings or audio (finish plan §4 B, separate).
- Pulling Zoom or Teams **recordings** to transcribe ourselves when the app made no transcript. That adds audio, ElevenLabs and the consent duties back in.
