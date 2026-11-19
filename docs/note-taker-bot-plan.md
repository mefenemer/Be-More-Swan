# Note Taker joins the call — a bot for free Google Meet, Teams and Zoom (PLAN, nothing built)

**Status:** plan for the owner, 2026-11-19. Nothing built. All nine decisions in §8 agreed by the owner on 2026-11-19.

**Why:** owner, 2026-11-19: *most small businesses use free Meet, Teams and Zoom accounts. Those accounts make no transcript, so the transcript pick-up (`docs/meeting-apps-pickup-plan.md`) can't reach them. The Note Taker should be invited to the meeting and take the notes itself.*

This reverses finish-plan decision 8 (2026-11-15, "stay upload-only for now", `docs/meeting-note-taker-finish-plan.md`). The name stays **Note Taker**.

## 1. Short answer

- **We buy the bot, not build it.** A bot of our own means running a browser for each live call for up to two hours, which Netlify functions can't do. It also means fixing the bot every time Zoom, Meet or Teams changes their pages. A meeting-bot service does that for us. **Recall.ai** is the established one: about **$0.50 per hour** in the call, plus **$0.15 per hour** for its transcript (2026 pay-as-you-go prices).
- **What the customer does (v1):** paste a meeting link, or say "join my 2pm call" in chat, and press **Send Note Taker**. The bot joins as **"Note Taker for ⟨Business⟩"** and posts a recording notice in the meeting chat. It leaves when the call ends. A few minutes later the minutes wait in the Inbox for approval, exactly like today. **v2** joins automatically from the calendar.
- **Most of the engine already exists.** The pick-up engine from PR #756 (the `meeting_imports` ledger, the background writer, metering) and the shared minutes writer (`meeting-minutes-writer.ts`) take the bot's transcript like any other source. New code is the bot itself: send, track, and receive the transcript.
- **Size:** about 3 weeks of build after a short proof (Phase 0). Zoom adds a Zoom Marketplace review (§4), so **Meet and Teams launch first**.

## 2. What it costs us, and charging

| | Per hour in the call |
|---|---|
| Recall.ai bot | $0.50 |
| Recall.ai transcript | $0.15 |
| Writing the minutes (one model call) | about $0.05 |
| **Total** | **about $0.70 (about 55p)** |

Nothing is charged when the bot is never let in. Recall also bills nothing for that, beyond a few minutes of waiting. Recall keeps recordings 7 days free. We delete ours as soon as the transcript is saved (§6), so storage costs nothing.

**Charging (decision B3):** background work spends tasks. The finish plan valued a task at roughly 2.5p–5p across the plans. **1 task per started 5 minutes in the call** (12 tasks an hour, minimum 1) covers the cost on every plan where a task is worth 4.6p or more. On the cheapest plan it runs at a small loss. **1 per 3 minutes** (20 an hour) covers it everywhere. Either way it is a new cost key, `meeting_bot_per_5_min` (or `_3_min`), set in Admin → Money → Task costs and quoted with `data-task-cost`.

⚠️ A **new charge needs the Terms' 30-day notice** before the first customer can use it, as the pick-up charge already does.

## 3. How a bot gets into each kind of call

Checked 2026-11-19 against Recall's and Zoom's docs. ⚠️ Phase 0 proves each line on a real call.

| | Google Meet (free Gmail) | Microsoft Teams (free or business) | Zoom (free or paid) |
|---|---|---|---|
| **How it joins** | As a guest. **Someone in the call presses Admit.** | As an anonymous guest. Usually waits in the **lobby** until admitted. | Only with a **Zoom user in the call who has authorised our Zoom app** (Zoom's OBF rule, enforced since 2 March 2026). Anonymous bots are refused. |
| **What can block it** | Nobody in the call can admit it (only the organiser can, on personal accounts). | Business tenants that allow only signed-in users, or that show a CAPTCHA. A tenant admin can allow our bot's domain. | The customer hasn't connected Zoom, or isn't in the call. Our Zoom app must pass **Marketplace review** before other accounts can authorise it. |
| **Free-plan limits** | The bot counts as a person, so a free **1:1 becomes a group call with a 60-minute limit**. | Teams (free) limits group calls to 60 minutes. | Free meetings stop at 40 minutes either way. |
| **Later improvement** | A signed-in bot account skips the waiting room when its email is on the invite. | A signed-in bot in our own Microsoft tenant, with the customer's tenant allowing our domain. | Same OBF route; nothing better exists. |

The help article says each of these in plain words. The Note Taker's live status says which one stopped it: "Waiting to be let in", "Not let in after 10 minutes", "Connect Zoom and join the call first".

## 4. Design

**New:**

- **`meeting_bots` table** (`db/z-meeting-bots.sql`, both databases before deploy):
  - who and what: `id, organisation_id, assistant_id, requested_by_user_id, source ('link' | 'chat' | 'calendar'), platform ('google_meet' | 'teams' | 'zoom'), meeting_url, title, join_at`
  - the bot: `recall_bot_id, status, status_reason, joined_at, left_at, minutes_in_call`
  - links: `import_id → meeting_imports, calendar_event_ref, created_at, updated_at`
  - `status` ∈ scheduled | joining | waiting_room | in_call | done | not_admitted | cancelled | failed
  - Unique on `(organisation_id, meeting_url, join_at)`, so pressing Send twice sends one bot.
- **`src/utils/meeting-bot.ts`** (pure rules: link → platform, link checks, status words, charge from minutes) and **`meeting-bot-recall.ts`** (the only file that talks to Recall: create, cancel, leave, fetch transcript, delete media).
- **`send-meeting-bot.ts`**: one server action, used by the GUI and the chat card (the GUI-and-chat rule):
  1. check the link (https, a known Meet, Teams or Zoom host);
  2. check there is room in the task allowance for the length limit (decision B4);
  3. create the Recall bot with the name, the join message, the EU region, auto-leave rules and transcript on;
  4. save the row.
- **`recall-webhook.ts`**: checks the signature, then moves `status` through Recall's events. When the call ends and the transcript is ready, it adds a `meeting_imports` row (`via = 'bot'`, external id `recall:<bot id>`) and hands it to the existing background writer. Polling Recall's bot status every 15 minutes (the pick-up schedule) catches a missed webhook.
- **A bot `MeetingSource`** in the #756 engine. Its `fetchTranscript` reads Recall's transcript (speaker names come from the meeting platform, not guessed from audio) into `TranscriptLine[]`. Everything after that is #756 unchanged: dedupe, writer, Inbox, metering after success.
- **Auto-leave rules:**
  - waiting room longer than 10 minutes → leave as `not_admitted`;
  - alone in the call for 2 minutes → leave;
  - everyone else left → leave;
  - length limit reached (decision B4) → leave and say so on the record.

**Changed:**

- `meeting_imports` gains `via TEXT NOT NULL DEFAULT 'transcript'` (`'transcript' | 'bot'`). The Inbox pill says "Joined by Note Taker on Google Meet" instead of "From Google Meet".
- `assistant-chat-capabilities.ts` changes "cannot join a call" to "joins your Meet, Teams or Zoom call when you send it a link". Regenerate the chat capabilities manifest (FR#17).

**GUI** (Note Taker detail):

- An **Inbox** button, **Send Note Taker to a meeting**, opens a dialog: link, optional title, **Now** or **At ⟨time⟩**. It shows the cost ("about 12 tasks an hour") and one line about telling people.
- A **Live & upcoming** strip above the Inbox: each bot with platform badge · title · status words · **Remove from call** / **Cancel**.
- **Settings:** length limit. In v2, auto-join: *Off* (default) / *Meetings I organise* / *Every meeting with a link*.

**Chat:**

- "join https://meet.google.com/abc-defg-hij at 2pm" → a `meeting_bot_proposal` card (link, time, cost) with **Send** / **Cancel**. Sending happens only from the card, because it costs tasks and walks into someone's call.
- The chat sees live and upcoming bots, so it can answer "is the Note Taker in my call?" and "cancel the 2pm one".

**Calendar auto-join (v2):** read the existing **booking calendar connections** (`google_calendar` has `calendar.events`, `outlook_calendar` has `Calendars.ReadWrite`; both can read events). Every 15 minutes, schedule bots (Recall's `join_at`) for events in the next hour that carry a meeting link and match the auto-join setting. We don't use Recall's own calendar product, because that would mean giving our calendar sign-ins to another company. ⚠️ Google's verification described `calendar.events` for booking. Reading events to send a bot is a new use, so update the verification's justification before v2.

## 5. Build list (each step one PR)

0. **Proof (you, with me; 2–3 days).**
   - Recall.ai pay-as-you-go accounts: the US West workspace exists (2026-11-19). Owner chose to run the first tests on US West, then repeat on the **EU** account at `https://eu-central-1.recall.ai` (a separate account and key), since UK customers will run there. Keep the key in `.env`, never in chat. Send the bot into each test call with `scripts/probe-meeting-bots.mjs`.
   - From a throwaway script, send a bot to a free Meet call, a Teams (free) call and a business Teams call.
   - For Zoom, send a bot to a meeting on our own Zoom account. External meetings need the OBF route and review (step 4).
   - Write down: how admission looks for the host, how long until the transcript arrives, whether the speaker names are right, and the cost on Recall's bill.
   - Ask Recall in writing: their DPA and sub-processors, EU processing, deleting media on request, the Zoom OBF feature flag, and what the join message can say.

   Done when one real minutes record exists from each of Meet and Teams through the existing writer.

   **Results so far:**
   - **Run 1, 2026-11-19, free Google Meet, Recall US West (`us-west-2`):**
     - **Joining:** the bot was sent, asked to join, was admitted by the host, and was recording within 0.6 minutes. Its waiting-room step was too quick for the script's 30-second checks to see.
     - **The call:** about 1.1 minutes in the call, then the host ended it.
     - **Transcript:** ready **at once** when the bot finished. The streaming transcript needs no post-call wait. 94 words in 1 block, all under the host's Meet display name, with no unlabelled lines. The words read accurately, including three spoken tasks.
     - **Clean-up:** Recall's copy of the media was deleted (`delete_media` returned 2xx).
     - ⚠️ **One speaker label for what sounded like two voices.** Names come from Meet participants, so two people sharing one device show as one speaker. To check: a second person on a **separate** device should get their own name.
     - **Not yet checked:** the pinned chat notice (look in the call), and running this transcript through the minutes writer.
1. **Legal and copy first.**
   - Add Recall.ai to the Trust page sub-processors (with ElevenLabs, if it isn't added yet).
   - Update the privacy notice and DPA (what the bot records, retention), and add the Terms clause: *you must tell the people in your meeting that the Note Taker is there and recording*.
   - Write the new charge's 30-day notice and a short DPIA.

   Merged before any bot code ships.
2. **Bot engine:** the `meeting_bots` SQL, the `via` column, `meeting-bot.ts`, the Recall client, `send-meeting-bot`, `recall-webhook`, auto-leave, the bot source into #756, metering (check before, charge actual minutes after) and media deletion. Proof: stubbed tests (send → webhook events → import → minutes record), a duplicate-send test, a not-admitted-costs-nothing test and a metering-order test.
3. **GUI and chat:** dialog, Live & upcoming strip, statuses, settings, chat card, capabilities manifest. Proof: component harness at phone and desktop width; card and capabilities tests.
4. **Zoom:**
   - a Zoom General App with the Meeting SDK and `user:read:token`;
   - a **Connect Zoom** card;
   - the token endpoint Recall calls to get a fresh OBF token for each meeting;
   - help text: "you must be in the call".

   **Submit the Marketplace review at the start of this step** (7–10 business days at best).
5. **Calendar auto-join (v2):** the setting, the 15-minute scheduler over both calendar connections, and the Google justification update. Proof: stubbed calendar fixtures and one real calendar run.
6. **Go live, per platform:** a real-account run on staging. Then update the `/connections` cards to "joins your call and takes the notes" (a **"joins your call"** claim, so it moves only once real), the FAQ, the homepage mention and `tests/homepage-faq-2026-11-03.test.ts`.

## 6. Privacy, consent and retention

- **In the call:** the bot's name says what it is ("Note Taker for ⟨Business⟩"). On joining it posts: *"Hi, I'm ⟨Business⟩'s Be More Swan Note Taker. I'm making a transcript of this call to write the minutes. The host can remove me at any time."* Removing it from the call stops it straight away, and the record says "Removed from the call".
- **The customer's duty:** the Terms make the customer responsible for telling participants. The send dialog says it in one line. Some US states need every participant's consent, which the in-call notice supports but doesn't replace. The help article says so.
- **Data:** audio and video never reach Be More Swan. We read Recall's transcript, then **delete the recording at Recall straight away**. The transcript is kept **30 days** (pick-up plan D5), and the minutes until the user deletes them.
- **Where it is processed:** UK and EU workspaces in Recall's EU region (Frankfurt). Recall confirmed in writing (2026-11-19) that pay-as-you-go supports it, as a separate account with its own key. US workspaces in Recall's US region. That means two Recall accounts, chosen by the workspace's country.
- **US recording law:** some US states require every participant's consent to record. The bot's name, its pinned join notice, the Terms clause and the send dialog's reminder are how we meet that. The help article names the rule plainly for US customers.

## 7. What happens to the transcript pick-up plan

The #756 engine stays: the bot uses it. The per-platform transcript pick-up (pick-up plan Phases 2–4) mainly helps paid accounts, and they can use the bot too. **Pause Phases 2–4 until the bot is live** (decision B8). Then decide whether a cheaper, bot-free pick-up for paid accounts is worth its three provider reviews. Google Meet's API is already proven (pick-up plan Phase 0), so that work isn't lost.

**Where it stands (2026-11-19):** pick-up Phase 2, Google Meet, was already built and merged to staging (#760) before B8 was agreed. It is dark behind the `meeting_pickup` flag (OFF), with `GOOGLE_MEET_CLIENT_ID/SECRET` not yet set. Under B8 it **stays dark**, and Teams and Zoom pick-up (Phases 3–4) are not started. Switching Meet pick-up on for paid Workspace customers later is a separate owner decision, not part of this plan.

## 8. Decisions for the owner

- **B1. Vendor.** ✅ **Agreed 2026-11-19 (owner): Recall.ai, with no second vendor.** (Amended the same day: the owner first agreed Meeting BaaS as a tested fallback, then dropped it — there is no backup vendor.) Seven services compared on 2026-11-19 (§10). Recall is the only one that passes every must-have for **both the UK/EU and the US**:
  - Zoom's OBF rule;
  - speaker names from the meeting app;
  - a UK-ready DPA and an EU region;
  - SOC 2 Type II, ISO 27001 and US regions;
  - a well-funded company.

  It is not the cheapest: about $0.65/h all-in against MeetStream's $0.45. But its startup programme ($0.25/h for the first 10,000 hours) would make it the cheapest for our first year, if we qualify. If Recall ever fails us, §10 is the starting point for a replacement; the vendor sits behind one file (`meeting-bot-recall.ts`), so switching is contained. Building our own: no (§1).
- **B2. Transcript.** ✅ **Agreed 2026-11-19 (owner):** **Recall's own transcript** ($0.15/h). Speaker names come from the meeting platform, and no audio ever reaches us. The alternative, downloading the audio and sending it to ElevenLabs Scribe, guesses speakers from audio and brings audio handling back.
- **B3. Charging.** ✅ **Agreed 2026-11-19 (owner):** **1 task per started 5 minutes in the call**, minimum 1, nothing if never admitted. See §2 for the 3-minute alternative that covers cost on every plan.
- **B4. Length limit.** ✅ **Agreed 2026-11-19 (owner):** **2 hours by default**, changeable in settings up to 4. The allowance check before sending reserves the limit's tasks.
- **B5. Bot name and join message.** ✅ **Agreed 2026-11-19 (owner):** as in §6.
- **B6. How it is sent.** ✅ **Agreed 2026-11-19 (owner):** **v1 = link or chat card. v2 = calendar auto-join, off by default**, with *Meetings I organise* as the first choice.
- **B7. Zoom timing.** ✅ **Agreed 2026-11-19 (owner):** **launch Meet and Teams first.** Zoom follows when its Marketplace review passes; its card stays Coming soon until then.
- **B8. Transcript pick-up.** ✅ **Agreed 2026-11-19 (owner):** **pause pick-up Phases 2–4** and keep the #756 engine (§7).
- **B9. Plans.** ✅ **Agreed 2026-11-19 (owner):** **every plan**, limited by the task allowance like everything else.

## 9. Risks

- **Not let in:** the most common failure, especially on Meet when the organiser isn't in the call. The status words and a "Send again" button make this clear instead of silent.
- **Free-plan time limits** cut calls short (40 or 60 minutes). The minutes are written from what was heard, and the record says the call ended early.
- **Platform changes** can break bots. That is the vendor's job, but expect occasional bad days. The status page and the "failed" reason must say "the meeting service blocked the Note Taker", not leave nothing in the Inbox.
- **Zoom review** is outside our control (B7).
- **Customers forgetting to tell people:** the in-call notice and the Terms cover us. The send dialog's one line reminds them every time.

## 10. Bot services compared (2026-11-19)

Researched from each service's own pricing, docs, DPA and security pages; third-party facts are marked. "Not found" means the service doesn't publish it. Every line is to be confirmed in writing before signing (Phase 0).

**One fact applies to every service:** for Zoom meetings on other people's accounts, **we need our own Zoom app, approved by Zoom** (OBF tokens are minted from the customer's sign-in to *our* app). Meeting BaaS, Attendee and MeetStream say so outright. Recall's docs contradict each other on this, so ask them. Zoom's review is ours whichever service we choose.

| | **Recall.ai** | **Meeting BaaS** | **Attendee** | **MeetStream** | **Vexa** | **Nylas Notetaker** | **Skribby** |
|---|---|---|---|---|---|---|---|
| **1. Zoom OBF** | ✅ token URL (up to 50 tokens) | ✅ 4 ways, own Zoom app | ✅ own Zoom app | ✅ own Zoom app | ❌ web client only; on roadmap | ❌ not documented; Zoom bots reported stuck (forum) | ❌ ZAK only, "does not accept OBF" |
| **2. Meet / Teams** | Guest + signed-in on all 3; personal Teams documented | Guest + signed-in (Workspace / M365) | Guest + signed-in on all 3 | Guest + signed-in; personal Teams (guest) | Guest; signed-in Meet; personal Teams | Guest only | Guest + signed-in (incl. personal Gmail) |
| **3. UK / EU data** | DPA with UK Addendum. EU region (Frankfurt) is a separate account; pay-as-you-go can use it (Recall, 2026-11-19). Retention per recording, delete endpoint | DPA with UK Addendum (as read by our researcher; confirm). All data in Paris (Scaleway). Retention 3–30 days by plan, delete endpoint | Hosted: no DPA, region or retention published. Self-host anywhere | DPA in trust centre. EU residency listed. Retention adjustable, delete endpoint | US only. DPA links broken. No retention controls | DPA on request. London EU region, not confirmed for Notetaker. 14-day default retention | EU by default. DPA covers UK GDPR. Audio kept 1 week |
| **4. US data** | ✅ US regions, **SOC 2 Type II**, ISO 27001, BAA (Enterprise) | No US region, no own SOC 2 report, no BAA | Not found | US + EU. SOC 2 *in progress*, ISO 27001, BAA | US-hosted. No audit | US region. SOC 2 Type II, ISO 27001 | No US region. No SOC 2 |
| **Chat notice on join** | ✅ send and pin | ✅ | ✅ | ✅ | ❌ | ✅ customisable | ✅ |
| **5. Speaker names** | ✅ from the meeting app | ✅ from the meeting app (Teams 1–2 s lag) | ✅ from the meeting app | ✅ from the meeting app | Platform indicators, 4–7% unlabelled | ❌ audio guessing (AssemblyAI) | Audio guessing matched to the participant list |
| **6. Price per hour, bot + transcript** | $0.50 + $0.15 = **$0.65**; startup $0.25 for 10k h; 5 h free | $0.50→0.35 + ~$0.10 = **~$0.45–0.60**; 8 h free | $0.50→0.35 + captions $0 or own engine | $0.35 + $0.10 = **$0.45**; $0.25 at volume | $0.30 + $0.20 = **$0.50** | $15–49/month, then $0.65–0.80 (transcript and calendar included) | $0.35 + $0.04–1.01 (Nova-3: $0.67) |
| **7. Maturity** | Series B, $51M raised (third-party); claims Zoom Preferred Partner | Small French company (SAS SPOKE). 2 incidents in Nov 2026, one rejecting up to 90% of Meet bots | Small. Very active releases. ELv2 licence | Launched Jul 2025. $125k pre-seed (third-party). About 11 people | 0.x release. 808 open issues | Large company; Notetaker is a small part of it | Bought by Alianza (Sep 2026); to be folded into Crux in Q1 2027 |
| **8. Lock-in** | REST + signed webhooks. Proprietary | REST + signed webhooks. Self-host (BSL) | REST + signed webhooks. Self-host | REST + signed webhooks. OpenAPI | REST. Webhooks unfinished | Calendar ties us to Nylas grants | REST + signed webhooks |

**Ruled out:**
- **Vexa, Nylas Notetaker and Skribby**: no working Zoom OBF route, so no Zoom on other people's meetings. Vexa also has no DPA or audit. Nylas guesses speakers from audio. Skribby's future is uncertain after its sale.
- **MeetStream**: the cheapest with good tech, but a tiny, very new company without a SOC 2 report yet. Too thin to hold customers' meeting data.
- **Attendee**: good tech, but publishes nothing on hosted data terms, and self-hosting brings back the servers §1 avoids.

**Left:** Recall.ai (UK, EU and US). Meeting BaaS (EU only) was the runner-up; the owner chose no backup vendor (2026-11-19).

**Questions put to Recall (answers 2026-11-19):**
1. ✅ **Pay-as-you-go can use the EU region:** sign up separately at `https://eu-central-1.recall.ai`. Regions have separate accounts, credentials and resources.
2. ✅ **External Zoom meetings need our own Zoom Marketplace app, reviewed and approved by Zoom.** Development credentials only work for meetings hosted by the app-owning user or organisation (plan step 4).
3. ⏳ **Sub-processor list:** not yet received. Recall's reply linked their bots FAQ and sub-codes pages, not the list. Ask again, or read `https://security.recall.ai/subprocessors`, before step 1 (Trust page). The sub-codes (`https://docs.recall.ai/docs/sub-codes`) are what the status words in §3 map from.
4. ⏳ **Startup price ($0.25/h):** not yet answered.
5. ⏳ **Chat-notice limits on Teams:** not yet answered.

**US customers.** Recall's US region keeps US customers' meeting data in the US, with a SOC 2 Type II report and a BAA available later if we ever serve health businesses. No service handles US "all-party consent" states (such as California, Florida, Illinois, Maryland, Massachusetts, Pennsylvania and Washington) for us. That is covered by the bot's name, the pinned chat notice on joining, the Terms clause and the send dialog's reminder (§6).

## Sources

- Recall.ai pricing (pay-as-you-go $0.50/h; transcript $0.15/h; 7 days free storage): https://www.recall.ai/pricing and https://www.recall.ai/blog/new-recall-ai-pricing-for-2026
- Zoom Meeting SDK authorisation (OBF, from 2 March 2026; anonymous external joins refused): https://developers.zoom.us/docs/meeting-sdk/obf-faq/ and https://developers.zoom.us/docs/meeting-sdk/
- Recall.ai on Zoom OBF (token endpoint, feature flag): https://docs.recall.ai/docs/zoom-obf and https://www.recall.ai/blog/zoom-obf
- Recall.ai Google Meet admission and signed-in bots: https://docs.recall.ai/docs/google-meet-faq and https://docs.recall.ai/docs/google-meet-login-getting-started
- Recall.ai Teams (anonymous guest, lobby, CAPTCHA, signed-in bots): https://docs.recall.ai/docs/setting-up-signed-in-bots-for-microsoft-teams
- Cost comparison of bot services (secondary source): https://apicostcalc.com/recall-ai-vs-meetingbaas-vs-vexa-cost-calculator.html
- Recall.ai: bot create (zoom.obf_token_url) https://docs.recall.ai/reference/bot_create.md · regions https://docs.recall.ai/docs/regions · DPA https://www.recall.ai/data-processing-agreement · speaker names https://docs.recall.ai/docs/diarization.md · chat messages https://docs.recall.ai/docs/sending-chat-messages.md · funding (third-party) https://siliconangle.com/2025/09/05/recall-ai-lands-38m-unlock-spoken-data-scale/
- Meeting BaaS: docs https://docs.meetingbaas.com/llms/all · DPA https://www.meetingbaas.com/en/legal/data-processing-agreement · pricing https://www.meetingbaas.com/en/pricing · status https://status.meetingbaas.com · licence https://www.meetingbaas.com/en/legal/license
- Attendee: Zoom OAuth https://github.com/attendee-labs/attendee/blob/main/docs/zoom_oauth.md · pricing https://attendee.dev/pricing · licence https://github.com/attendee-labs/attendee/blob/main/LICENSE
- MeetStream: Zoom authenticated bots https://docs.meetstream.ai/guides/app-integrations/zoom-authenticated-bots.md · pricing https://meetstream.ai/pricing · security https://meetstream.ai/security · funding (third-party) https://www.caplight.com/company/meetstream
- Vexa: Zoom https://docs.vexa.ai/platforms/zoom · status https://docs.vexa.ai/roadmap/status.md · security https://vexa.ai/security · pricing https://vexa.ai/pricing
- Nylas Notetaker: Zoom guide https://developer.nylas.com/docs/cookbook/notetaker/transcribe-zoom-meeting.md · forum report https://forums.nylas.com/t/nylas-notetaker-doesnt-join-in-zoom-bot-never-appears-in-the-meeting-or-waiting-room/1213 · pricing https://www.nylas.com/pricing/
- Skribby: authentication https://skribby.io/docs/guides/bot-authentication · regions https://skribby.io/docs/guides/regions · pricing https://skribby.io/pricing · acquisition (third-party) https://www.channeldive.com/news/alianza-buys-skribby-aims-telco-ai-at-meetings-that-msps-manage/830140/
