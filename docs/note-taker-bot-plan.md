# Note Taker joins the call — a bot for free Google Meet, Teams and Zoom (PLAN, nothing built)

**Status:** plan for the owner, 2026-11-19. Nothing built. Decisions in §8 are open.

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
   - Open a Recall.ai pay-as-you-go account on the **EU region**. Keep the key in `.env`, never in chat.
   - From a throwaway script, send a bot to a free Meet call, a Teams (free) call and a business Teams call.
   - For Zoom, send a bot to a meeting on our own Zoom account. External meetings need the OBF route and review (step 4).
   - Write down: how admission looks for the host, how long until the transcript arrives, whether the speaker names are right, and the cost on Recall's bill.
   - Ask Recall in writing: their DPA and sub-processors, EU processing, deleting media on request, the Zoom OBF feature flag, and what the join message can say.

   Done when one real minutes record exists from each of Meet and Teams through the existing writer.
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
- **Data:** audio and video never reach Be More Swan. We read Recall's transcript, then **delete the recording at Recall straight away**. The transcript is kept **30 days** (pick-up plan D5), and the minutes until the user deletes them. Processing is in Recall's EU region if Phase 0 confirms it.

## 7. What happens to the transcript pick-up plan

The #756 engine stays: the bot uses it. The per-platform transcript pick-up (pick-up plan Phases 2–4) mainly helps paid accounts, and they can use the bot too. **Pause Phases 2–4 until the bot is live** (decision B8). Then decide whether a cheaper, bot-free pick-up for paid accounts is worth its three provider reviews. Google Meet's API is already proven (pick-up plan Phase 0), so that work isn't lost.

## 8. Decisions for the owner

- **B1. Vendor.** *Recommended:* **Recall.ai**. It is the most used and documented, and covers Zoom's OBF route, signed-in bots and an EU region. Cheaper options exist (Meeting BaaS about $0.35–0.50/h, Vexa about $0.30/h) but are smaller. Building our own: no (§1).
- **B2. Transcript.** *Recommended:* **Recall's own transcript** ($0.15/h). Speaker names come from the meeting platform, and no audio ever reaches us. The alternative, downloading the audio and sending it to ElevenLabs Scribe, guesses speakers from audio and brings audio handling back.
- **B3. Charging.** *Recommended:* **1 task per started 5 minutes in the call**, minimum 1, nothing if never admitted. See §2 for the 3-minute alternative that covers cost on every plan.
- **B4. Length limit.** *Recommended:* **2 hours by default**, changeable in settings up to 4. The allowance check before sending reserves the limit's tasks.
- **B5. Bot name and join message.** *Recommended:* as in §6.
- **B6. How it is sent.** *Recommended:* **v1 = link or chat card. v2 = calendar auto-join, off by default**, with *Meetings I organise* as the first choice.
- **B7. Zoom timing.** *Recommended:* **launch Meet and Teams first.** Zoom follows when its Marketplace review passes; its card stays Coming soon until then.
- **B8. Transcript pick-up.** *Recommended:* **pause pick-up Phases 2–4** and keep the #756 engine (§7).
- **B9. Plans.** *Recommended:* **every plan**, limited by the task allowance like everything else.

## 9. Risks

- **Not let in:** the most common failure, especially on Meet when the organiser isn't in the call. The status words and a "Send again" button make this clear instead of silent.
- **Free-plan time limits** cut calls short (40 or 60 minutes). The minutes are written from what was heard, and the record says the call ended early.
- **Platform changes** can break bots. That is the vendor's job, but expect occasional bad days. The status page and the "failed" reason must say "the meeting service blocked the Note Taker", not leave nothing in the Inbox.
- **Zoom review** is outside our control (B7).
- **Customers forgetting to tell people:** the in-call notice and the Terms cover us. The send dialog's one line reminds them every time.

## Sources

- Recall.ai pricing (pay-as-you-go $0.50/h; transcript $0.15/h; 7 days free storage): https://www.recall.ai/pricing and https://www.recall.ai/blog/new-recall-ai-pricing-for-2026
- Zoom Meeting SDK authorisation (OBF, from 2 March 2026; anonymous external joins refused): https://developers.zoom.us/docs/meeting-sdk/obf-faq/ and https://developers.zoom.us/docs/meeting-sdk/
- Recall.ai on Zoom OBF (token endpoint, feature flag): https://docs.recall.ai/docs/zoom-obf and https://www.recall.ai/blog/zoom-obf
- Recall.ai Google Meet admission and signed-in bots: https://docs.recall.ai/docs/google-meet-faq and https://docs.recall.ai/docs/google-meet-login-getting-started
- Recall.ai Teams (anonymous guest, lobby, CAPTCHA, signed-in bots): https://docs.recall.ai/docs/setting-up-signed-in-bots-for-microsoft-teams
- Cost comparison of bot services (secondary source): https://apicostcalc.com/recall-ai-vs-meetingbaas-vs-vexa-cost-calculator.html
