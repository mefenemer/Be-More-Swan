# Note Taker — pick up Google Meet, Teams and Zoom meetings automatically (PLAN, nothing built)

> **2026-11-19, owner:** most small businesses use free accounts, which make no transcript, so the Note Taker will **join the call itself** (`docs/note-taker-bot-plan.md`). That plan reuses this one's engine (#756) and pauses Phases 2–4 below until the bot is live (its decision B8, agreed by the owner 2026-11-19). The #756 engine stays.

> **2026-11-27, owner: pick-up RESTARTED** for Meet, Teams and Zoom (it was skipped 22 Nov). Meet's launch steps,
> legal drafts and Google verification pack are in `docs/meeting-pickup-meet-launch.md`. Pick-up now skips a call the
> Note Taker's bot was in (`botCover`, skip reason `bot_joined`), so a call is never written up or charged twice.
> Proposed D5 change: the transcript is **not kept** (the engine never stores it), instead of 30 days.

**Status:** plan for the owner, 2026-11-18. Nothing built. The three cards on `/connections` say Coming soon (#729).
**Goal:** after a call on Google Meet, Microsoft Teams or Zoom ends, its minutes appear in the Note Taker's Inbox
without anyone pasting a transcript. They wait for approval exactly like pasted notes. Nothing is sent anywhere until a
person approves.

## 1. Short answer

- **All three work the same way. None of them records anything for us.** We read the **transcript the platform made
  itself**. This avoids a "bot that joins your call" and fits the go-live rule that no copy promises recordings or bots.
- **That means a transcript has to exist.** Each platform needs **a paid plan** and **transcription switched on for the
  meeting** (by someone in the call, or by an organisation setting). The cards must say so honestly. "Picks up the
  meeting automatically" holds only for meetings that have a transcript.
- **What we already have:**
  - the transcript reader handles Zoom, Teams and Meet caption files (`src/utils/meeting-transcript.ts`);
  - the minutes are written by one shared function (`meeting-minutes.ts`, about 10–14 s for 60 minutes);
  - Microsoft and Google sign-ins already exist (Outlook mail, the Outlook calendar for booking Teams links, and Google Calendar).
- **Order I recommend:** Google Meet, then Teams, then Zoom. Zoom's Marketplace review takes the longest, so submit it
  early and in parallel.
- **Size:** the shared engine is about 1 week. Each platform is 3–5 days of build, plus its review on the platform's side.

## 2. The shared engine (built once, used by all three)

1. **A `meeting_imports` table (SQL).** One row per platform meeting: workspace, assistant, platform, the platform's
   meeting/transcript id, status (found → fetched → written → skipped/failed), the meeting record it made, and the times.
   Its unique key (platform + external id) means a meeting is **never written up twice**, however many times it is seen.
2. **Finding finished meetings: poll first, push later.** A scheduled job (`run-meeting-imports`, every 15 minutes, in
   staging-crons) asks each connected platform for meetings that ended since the last check. Push notifications (Google's
   Events API, Microsoft's change notifications, Zoom's webhooks) can come later to cut the delay. Polling also catches
   anything a push missed. Zoom's transcript webhook is widely reported as unreliable, so polling stays either way.
3. **Writing it up in the background.** Fetching a transcript plus one model call can pass the 26 s limit, so it runs as
   a `-background` function (15 minutes). It reads the transcript into the existing parser, runs the same minutes function
   as "New meeting", and files the meeting with the same record writer (`hub-records.ts`: a meeting is never overwritten).
4. **What the user sees.** In the Inbox, a pill on the meeting saying where it came from ("From Google Meet") with a link
   to the call. In the chat, the meetings block names the platform. Nothing is sent until it is approved, as today.
5. **Cost.** This is background work, so it spends tasks ([background-work-metered]): "check before, record after". The
   amount comes from Admin → Money → Task costs: 1 task per meeting (**D3, decided**).
6. **Connections tab.** Under "Meeting apps", a Connect button per platform. Its action is "Pick up my meetings
   automatically", with the platform's requirements in plain words (paid plan, transcription on).

## 3. Platform by platform

| | Google Meet | Microsoft Teams | Zoom |
|---|---|---|---|
| **Customer needs** | Google Workspace **Business Standard or higher**. Not Business Starter, free Gmail or personal accounts. | A Microsoft 365 **work or school** account. **Personal accounts (Hotmail/Outlook.com) are not supported.** | A **paid** Zoom plan with **cloud recording** and **audio transcript** switched on. |
| **Per meeting** | Someone turns on **Transcripts** (or the organisation's auto setting). The transcript saves to the organiser's Drive. | Someone starts **transcription** (or the organisation's auto policy). | The meeting is **cloud-recorded** (manually or by auto-record), and Zoom makes the transcript afterwards. |
| **How we read it** | Meet REST API: `conferenceRecords` → `transcripts` → `transcripts.entries` (speaker + text, paged, 100 at a time). **No Drive access needed.** | Graph: find the meeting from the calendar event's join link (`/me/onlineMeetings?$filter=JoinWebUrl eq '…'`), then `/me/onlineMeetings/{id}/transcripts/{id}/content` (a .vtt file). | Zoom API: list the user's cloud recordings, then fetch the transcript file (.vtt). |
| **Scopes** | `meetings.space.readonly`: **Sensitive** (Google verification with a demo video, like `calendar.events`; no paid security assessment). | `OnlineMeetingTranscript.Read.All` and `OnlineMeetings.Read` (delegated). Likely **admin consent** in the customer's organisation (to confirm in Phase 0). Teams also has a new tenant setting for transcript API access. | User-level granular scopes (confirmed in Zoom's scope reference 2026-11-27): `cloud_recording:read:list_user_recordings` (GET /users/me/recordings, max 1 month per call), `cloud_recording:read:list_recording_files` (GET /meetings/{uuid}/recordings), `cloud_recording:read:meeting_transcript` (GET /meetings/{uuid}/transcript), `user:read:user` (account label). The .vtt also downloads from the TRANSCRIPT file's `download_url` with the same token. A published app also needs a **deauthorization endpoint**. |
| **Review on their side** | Add the scope to our existing Google project and **re-verify** (a demo video). | **Microsoft publisher verification** (still pending; the Outlook note already warns that work tenants may refuse consent until it is done). | **Zoom Marketplace review**: metadata and usability, then a security review. Forum reports say 7–10 business days at best, and longer with feedback. |
| **Push option (later)** | Workspace Events API: `transcript.v2.fileGenerated` through Google Pub/Sub (needs a Pub/Sub topic). | Graph change notifications (the "all transcripts" route is application-only, so polling with delegated access comes first). | `recording.transcript_completed` webhook (reported unreliable, so keep polling). |
| **Which meetings** | Meetings the user organised or was invited to (Meet REST lists the user's conference records). | **Only meetings the user organised** (the delegated transcript route). | The user's own cloud recordings. |

## 4. Phases

0. **Prove it on real accounts (1–2 days, mostly you).** Do you, or a friendly customer, have Workspace Business
   Standard, Microsoft 365 Business and a paid Zoom plan? Hold one short call on each with transcription on, and read
   the transcript through each API with a test script. Confirm the Teams admin-consent and tenant-setting question, and
   the exact Zoom scope names. **Nothing is built before this works by hand.**

   **Google Meet: ✅ proven 2026-11-19.**
   - **Account:** Be More Swan's own Workspace has transcription. It worked although the Admin console's Meet video
     settings showed no "Transcripts" row.
   - **Set-up:** a separate Google Cloud project "BMS Meet test", with the sign-in screen set to **Internal** (only
     bemoreswan.com accounts, no Google review), the Google Meet REST API on, and a Desktop OAuth client. The
     verified YouTube project was not touched. The test script signs in with PKCE on a local address and asks only for
     `meetings.space.readonly`.
   - **What the API returns:**
     - `conferenceRecords` lists the call once it has ended, with start and end times and the space.
     - `participants` gives each person's display name from their Google account.
     - `transcripts` shows state `FILE_GENERATED` and a link to the Doc.
     - `transcripts.entries` holds `participant`, `text`, `languageCode`, `startTime` and `endTime`, in chunks of
       about 15–30 seconds per speaker.
   - **Minutes:** Google's transcript text went through the existing Note Taker (`meeting-minutes`) on staging, with
     its header, time stamp and "Transcription ended after …" footer left in. The minutes were correct in 7.1 s:
     attendees, both tasks with their owners, no false decisions, one risk, and a follow-up email.
   - **Finding:**
     - The API returns Google's **original** transcription only. Text someone types into the transcript Doc afterwards
       is not in the entries.
     - Reading the edited Doc would need a Drive scope, which Google rates **Restricted** (security assessment), so we
       read the entries.
     - People correct the minutes in the Inbox, as they do for pasted meetings.
   - **Not yet seen:** a 2-person call read through the API. Later test calls never appeared in `conferenceRecords`,
     probably because another account hosted them. To confirm with one more call hosted by the connected account. If
     the list really only returns calls that account hosted, the help text must say "start the call from the connected
     account".
1. **Shared engine (about 1 week):** the table, the scheduled job, the background writer, dedupe, metering, the Inbox
   pill, the chat line, tests with stubbed platforms.
2. **Google Meet (3–4 days plus Google re-verification):** add the scope to the Google project, poll
   `conferenceRecords`, fetch the transcript entries, and turn them into "Speaker: words". Submit the re-verification at
   the start of this phase.
3. **Teams (4–5 days plus publisher verification):** a new Microsoft scope consent, calendar → join link → meeting id →
   transcript .vtt, organiser-only. Help text for the admin-consent step.
4. **Zoom (restarted 2026-11-27, own session):** Phase 0 script ready (scratchpad `zoom-phase0.mjs`, copy in the
   session notes folder); review answers drafted in `docs/zoom-marketplace-review-pack.md`, which also proposes ONE Zoom
   app for pick-up AND the bot's OBF (`user:read:token` + Meeting SDK), one review. Original plan:
   **Zoom (4–5 days plus Marketplace review):** a new Zoom app (General app, user-managed OAuth), the scopes, listing
   recordings and transcripts, and the Marketplace listing with a test plan. **Start the Zoom app and the review in
   Phase 1** so the wait overlaps.
5. **Go-live per platform:** a real-account run like runs A–D, then that card moves to Live on `/connections`, with
   wording that says what it needs ("when the meeting has a transcript").

## 5. Legal and copy

- A transcript is personal data of everyone in the call. **Before any code ships:** name Google, Microsoft and Zoom as
  sources on the Trust page and in the privacy notice, and set a retention rule for the raw transcript (**D5**). All three
  platforms already show participants a banner while transcription is on, so consent in the call is the platform's. We
  only read what the organiser's account can read.
- Copy: no "records your meetings" and no "joins your call". The cards and help say "when your meeting has a
  transcript, the Note Taker picks it up and writes the minutes for you to approve".
- This is separate from **Phase 4a, recording upload** (ElevenLabs transcribes audio the user uploads). The two can
  share the legal step.

## 6. Decisions for the owner

- **D1. Order:** ✅ **Decided 2026-11-18 (owner): Meet → Teams → Zoom.** Start the Zoom Marketplace review early,
  as soon as a working build exists, because its review time is outside our control.
- **D2. Which meetings:** ✅ **Decided 2026-11-18 (owner): every meeting with a transcript.** No title word or tick.
- **D3. Cost:** ✅ **Decided 2026-11-18 (owner): 1 task per picked-up meeting**, as a new `meeting_pickup` key in Admin →
  Money → Task costs (in line with other 1-task background work). Polling itself costs nothing, and a meeting with no
  transcript costs nothing. Note: a *pasted* meeting stays free (counted like chat). Pick-up is background work, so it
  spends a task ([background-work-metered]).
- **D4. Plan:** ✅ **Decided 2026-11-18 (owner): every plan**, like the rest of the Note Taker.
- **D5. Keep the transcript?** ✅ **Decided 2026-11-18 (owner): keep it 30 days** so the minutes can be re-done, then
  delete it. Say so in the Privacy Policy before launch.
- **D6. Wait for push, or launch on polling?** ✅ **Decided 2026-11-18 (owner): launch on 15-minute polling.** Push is
  a later speed-up.
- **D7. Card wording now:** ✅ **Decided 2026-11-18 (owner): yes.** The three Coming-soon cards say "A … with a
  transcript ends → picks up the transcript and writes the minutes for you to approve" (PR #740).

## 7. Risks

- **Many small businesses won't qualify:** Business Starter on Google, personal Microsoft accounts, free Zoom. The cards
  and help must say what is needed, and a clear message has to explain why nothing was picked up.
- **Teams admin consent** can block a small business with no IT person. The help needs a step-by-step guide.
- **Zoom review time** is outside our control, which is why it starts early.
- **Transcription is off by default** on many accounts. Expect "connected, but no meetings appeared" support questions.
  The Connections tab should show "last checked … · 0 meetings with a transcript found".

## Sources

- Google Meet REST API: transcripts and entries — https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries/list
- Meet API scopes (meetings.space.readonly is Sensitive; Drive scopes are Restricted) — https://developers.google.com/workspace/meet/api/guides/authenticate-authorize
- Google Meet transcripts: supported editions, saved to the organiser's Drive — https://support.google.com/meet/answer/12849897
- Workspace Events API for Meet (transcript.v2.fileGenerated, conference.v2.ended) — https://developers.google.com/workspace/events/guides/events-meet
- Microsoft Graph: list transcripts / get transcript content (delegated, work or school only) — https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts and https://learn.microsoft.com/en-us/graph/api/calltranscript-get
- Graph getAllTranscripts (organiser's meetings, application-only) — https://learn.microsoft.com/en-us/graph/api/onlinemeeting-getalltranscripts
- Teams transcript API overview and tenant control — https://learn.microsoft.com/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts
- Zoom app review process — https://developers.zoom.us/docs/distribute/app-review-process/
- Zoom transcript webhook and scopes (developer forum reports, to confirm in Phase 0) — https://devforum.zoom.us/t/using-server-to-server-app-and-scopes-to-get-transcripts/144122
