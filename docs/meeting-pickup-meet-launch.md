# Google Meet pick-up: launch pack (2026-11-27)

The owner restarted pick-up on 27 Nov 2026. This file holds everything needed to take **Google Meet** pick-up from
"built, dark" to live: the last staging proof, the Google verification submission, the legal wording, and the go-live
order. Teams and Zoom have their own sessions. The plan is `docs/meeting-apps-pickup-plan.md`.

Nothing here is live. Every step that touches prod needs the owner's word.

## 1. What is already done

- Engine (#756) and the Meet source (#760) are merged and on main. Their SQL is on both databases. The flag
  `meeting_pickup` is OFF everywhere.
- Shown working on staging (19–21 Nov): connect, the 15-minute check (`staging-crons.yml` runs `run-meeting-pickup`
  every 15 minutes), a sound check skipped as `no_meeting` with no charge, and minutes from Google's transcript text.
- The Connections card already tells people to "start calls from the account you connect" and shows "Calls hosted by …"
  once connected. Only calls hosted by the connected account are listed (confirmed 21 Nov).
- **New in this PR: if the Note Taker's bot wrote minutes for the same call, pick-up skips it.** The call is matched on
  its join link and time (`botCover` in `src/utils/meeting-pickup.ts`). The skip reason is `bot_joined` and there's no
  charge. A bot that never got in, was withdrawn mid-call, or whose write-up was skipped or failed leaves the call to
  pick-up, so a call is never left without minutes. While the bot is still in the call or still writing, pick-up waits
  and looks again every 15 minutes, for up to 2 hours after the call. The bot's own behaviour is unchanged.
  Known edge: a bot write-up held for the task limit can outlast that 2-hour wait, and then both could be written.

## 2. Last staging proof (owner, about 20 minutes)

This is the one thing never shown working: **minutes and a 1-task charge from a real call with two people.**

1. Staging SQL (staging database only):
   ```sql
   UPDATE feature_flags SET allowed_workspace_ids = ARRAY[58] WHERE key = 'meeting_pickup';
   ```
2. Check `GOOGLE_MEET_CLIENT_ID` / `GOOGLE_MEET_CLIENT_SECRET` are still set on the staging deploy. They were set on
   19 Nov from the internal "BMS Meet test" project.
3. On staging, sign in to workspace 58 and open the Note Taker → Connections → Google Meet → **Connect** with
   **hello@bemoreswan.com** (it was disconnected on 22 Nov).
4. **Start the call from hello@bemoreswan.com** (not from another account), with a second person or a second device.
   Turn on **Transcripts** and talk for about 3 minutes like a real meeting: an agenda, one decision, two tasks with owners.
   (A call that's only a sound check gets skipped as "no meeting", which is correct, but proves nothing.)
5. End the call. Google takes a few minutes to finish the transcript. Within about 30 minutes, the minutes should be in
   the Note Taker's Inbox with "Picked up from Google Meet".
6. Claude reads back: the `meeting_imports` row is `written`, the record is filed, and `task_ledger` has 1
   `meeting_pickup` task with ref `meeting_import:<id>`.
7. Optional overlap check: in a second call hosted by hello@, also send the Note Taker bot. Expected: one set of minutes
   (the bot's), and the pick-up row `skipped` / `bot_joined`.
8. After the test: set the flag back (`allowed_workspace_ids = NULL`) or leave 58 on, whichever you prefer.

## 3. Google verification for `meetings.space.readonly`

`meetings.space.readonly` is a **Sensitive** scope. That means a demo video and a written justification, but no paid
security assessment (unlike Gmail's Restricted scopes).

**Which Google Cloud project — owner's choice.** Pick-up uses its own client (`GOOGLE_MEET_CLIENT_ID`), so it can live
in any of our projects:

| Option | For | Against |
| --- | --- | --- |
| **The YouTube project (218009229183), recommended** | Already verified (5 Nov), with branding, domain and privacy links approved, and no Restricted scope under review. A Sensitive-only re-review is usually the quickest. | YouTube and Meet in one project (customers never see that). |
| The Gmail project (609555613434) | Groups the Google mail and meeting features. | The Email Assistant's Restricted-scope CASA review is open there, and a combined review moves at the pace of the slowest part. |
| A new project | Clean separation. | Branding, domain checks and the full verification from scratch. |

Steps once chosen (owner, in Google Cloud Console):
1. Enable the **Google Meet REST API** in that project.
2. Create a **Web** OAuth client with this redirect URI: `https://bemoreswan.com/api/oauth/google_meet/callback`.
   Add the staging one too (`https://staging--bemoreswan.netlify.app/api/oauth/google_meet/callback`) if staging
   should use the same client.
3. Data Access → add `https://www.googleapis.com/auth/meetings.space.readonly` (plus `openid` and `email`, which are
   already non-sensitive).
4. Paste the client id and secret into Netlify as `GOOGLE_MEET_CLIENT_ID` / `GOOGLE_MEET_CLIENT_SECRET`
   (production context). Claude never types these.
5. Submit for verification with the text and video below.

**Scope justification (paste into the form):**

> Be More Swan's Note Taker writes meeting minutes for small businesses. When a business connects Google Meet, we read
> the transcript that Google Meet itself made for calls the connected account hosted (conferenceRecords, participants,
> transcripts and transcripts.entries). We use it once, to write the minutes: a summary, decisions and action items with
> owners. The minutes wait in the business's Inbox until a person approves them. We never join, record or change a
> meeting, and we do not read Drive. `meetings.space.readonly` is the narrowest scope that returns transcript entries.
> The Drive scopes that read the transcript Doc are broader and are not requested. The transcript is not stored after
> the minutes are written.

**Demo video shot list (about 3 minutes, unlisted on YouTube):**
1. The bemoreswan.com home page and privacy policy (with the pick-up paragraph from §4 published).
2. Sign in → Note Taker → Connections → Google Meet → **Connect**. Show the Google consent screen with the app name and
   the "See information about your Google Meet conferences" permission. Show the browser's address bar with the client id.
3. A Google Meet call hosted by the connected account, with Transcripts switched on and two people talking.
4. Back in Be More Swan after the check: the minutes in the Inbox with "Picked up from Google Meet". Open them: summary,
   decision, tasks. Approve.
5. Disconnect on the Connections tab (shows how a user revokes access), plus a mention of myaccount.google.com/permissions.

**Reviewer test account:** reviewers usually can't host a Meet call with transcripts, so the video is the evidence.
If Google asks for a login, use the existing env-gated reviewer login (`review-login.ts`), and switch it off afterwards.

## 4. Legal wording (drafts, publish at go-live L)

**Decision D5 change (owner to confirm):** D5 said "keep the transcript 30 days". The engine never stores it: it reads
the transcript, writes the minutes, and drops it (`meeting_imports` has no text column). I propose the policy matches
the code: **not kept**. That's less personal data and nothing to delete later. Google keeps its own copy in the
organiser's Drive under Google's terms.

**Terms 5.2 — add to the weighted-outputs list (version 2.6), announced ≥ 30 days before L:**

> a meeting the Note Taker picks up from Google Meet (or another meeting service you connect) counts as
> <span data-task-cost="meeting_pickup">1 task</span>; a call with no transcript, or one the Note Taker's bot already
> took notes in, counts as nothing

**Privacy policy — new item under the Note Taker one (`privacy.html#note-taker`):**

> **Meetings the Note Taker picks up.** When a business connects Google Meet (or, later, Microsoft Teams or Zoom), the
> Note Taker reads the transcript that the meeting service itself made, only for calls hosted by the connected account
> and only when the call was transcribed. We do not join, record or transcribe these calls ourselves. Each person's
> name comes from the meeting service. The transcript is used once to write the minutes and is not kept by us; the
> meeting service keeps its own copy under its terms. The minutes wait for a person at that business to approve them.
> The business can disconnect the meeting service at any time.

**Trust page:** no new sub-processor. Google is the customer's own service, which we read on their instruction, not a
processor of ours. Add one line under the Note Taker: "Reads the transcript Google Meet made (no bot, no recording),
when you connect it."

**Charge notice email (to owners, ≥ 30 days before L), short:**

> Subject: The Note Taker can pick up your Google Meet calls
> From ⟨date L⟩, if you connect Google Meet, the Note Taker can write up calls that already have a Google transcript,
> so there's nothing to paste. Each meeting it picks up will count as 1 task. Calls with no transcript count as nothing,
> and so do calls the Note Taker's bot already took notes in. Nothing changes unless you connect Google Meet.
> Updated Terms (clause 5.2): ⟨link⟩.

## 5. Go-live order

1. Staging proof §2 ✅.
2. The owner picks the Google project. The client, scope and keys are set; verification is submitted (§3).
3. The owner confirms D5 = not kept. The Terms 2.6 notice email goes out → **L = send date + 30 days at the earliest**.
4. Google approves.
5. At L: publish Terms 2.6, the privacy item and the Trust line; set the `/connections` Google Meet card to Live with
   "when your call has a transcript"; write a help article ("Start the call from the account you connect", "Business
   Standard or higher", "Turn on Transcripts"); add a What's New item.
6. The flag `meeting_pickup` goes on for everyone (prod SQL, owner runs):
   ```sql
   UPDATE feature_flags SET enabled = TRUE, rollout_percentage = 100 WHERE key = 'meeting_pickup';
   ```
