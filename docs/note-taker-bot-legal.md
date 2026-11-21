# Note Taker bot — legal and copy (Phase 1 drafts)

2026-11-19 · Step 1 of `docs/note-taker-bot-plan.md`. **Drafts only: nothing here is live.** Each piece is published on the date in §1, so customers get the notice the Terms and DPA promise.

**Updated 2026-11-21** after Recall's reply of 20 November (§10): Recall's transcription is run by AssemblyAI, and Recall staff in the US can reach customer data for support. §2, §3, §4, §7.1 and §8 now say so.

**Owner decisions, 2026-11-19:**
- **One DPA 1.2 covers both** the Note Taker bot and the Email Assistant (whose 1.2 text was agreed on 12 November, `docs/email-assistant-phase0.md` §5), so customers accept once.
- **Terms 2.5 is drafted now and published at launch**, not bumped now, so users re-accept once, when the bot exists.

## 1. What goes out when (launch day = L)

| When | What | Who | Why this date |
|---|---|---|---|
| **L − 30 days or earlier** | Announce the new charge: Admin → Money → Task costs, change for `meeting_bot_per_5_min` from 0 to 1, starting L, with the customer "Why" text in §7.2 | Owner (announcing sends email + in-app) | Terms 5.2: weights change on at least 30 days' notice. The key is created at 0 in plan step 2, as `ai_presenter` was |
| **L − 14 days or earlier** | Sub-processor notice email to every workspace owner (§7.1) | Owner | DPA clause 5 and the Trust page: at least 14 days before adding a sub-processor that handles personal data |
| **L − 14 days** | Trust and privacy pages: add the Recall.ai row (§2) with "from ⟨L⟩" in the Purpose cell; update "Last updated" | Me (PR) | The list customers are told to check |
| **L** | DPA 1.2 live (§4); Terms 2.5 live (§5); privacy §5 and §9 additions (§3); help article; Pricing page row | Me (PR), owner merges | The bot switches on the same day |
| **L** | The bot works only for workspaces whose owner has accepted DPA 1.2 (gate in plan step 2) | Code | Clause 13's meeting exception (§4) only applies once accepted |

If the Email Assistant launches first, DPA 1.2 goes live then (it covers both). The bot's paragraphs describe a feature "when you send it", so they are true before the bot exists.

## 2. Sub-processor row (Trust page and privacy §7, kept identical)

Insert after the fal.ai row:

| Sub-Processor | Purpose | Location | DPA / Security |
|---|---|---|---|
| Recall.ai | Meeting bot for the Note Taker: joins the Google Meet, Microsoft Teams or Zoom calls you send it to, makes the transcript (using its own sub-processor AssemblyAI, which deletes the audio once it has been turned into text), and deletes the recording once we have saved the transcript | Recordings and transcripts: EU (Frankfurt) for UK and EU workspaces; US for US workspaces. Recall support staff in the US may access data when needed | `recall.ai/data-processing-agreement` (UK Addendum included) |

AssemblyAI goes in Recall's row, not a row of its own: we contract with Recall, and Recall's DPA covers its sub-processors (their list is linked from Recall's trust centre). We name AssemblyAI anyway, because it hears the meeting audio.

✅ **Done 2026-11-20:** Recall's sub-processor list and DPA are saved in `docs/vendor-records/`. The DPA is self-executing (it applied when the owner accepted Recall's terms), so there is nothing to sign, and it includes the SCCs and UK Addendum that cover US support access. The owner is subscribed to Recall's sub-processor change notices (10 days' notice).

## 3. Privacy policy additions

**§5 AI processing**, add a bullet after "Media generation":

> **Meetings the Note Taker joins.** When you send the Note Taker to an online meeting, a bot from our provider Recall.ai joins the call under the name "Note Taker for ⟨your business⟩" and posts a notice in the meeting chat. It records the call only to make a transcript, with each person's display name taken from the meeting service. Recall.ai's transcription provider, AssemblyAI, turns the audio into text and then deletes the audio. As soon as the transcript is saved in your workspace, the recording is deleted at Recall.ai. The transcript is then written up into minutes, which wait for a person to approve them. Anyone in the meeting can see the bot, and the host can remove it at any time. Your business decides which meetings to send it to, and is responsible for telling the people in them.

**§6 If you are a contact, lead or prospect**, add a paragraph:

> **If a Note Taker joined a meeting you were in.** The business that sent it is the controller of the transcript and minutes, and we process them for that business. Ask that business first. You can also contact us at privacy@bemoreswan.com and we will pass your request on.

**§9 retention table**, add rows:

| Data | Retention |
|---|---|
| Meeting recordings made by the Note Taker | Deleted at our provider as soon as the transcript is saved; at most 24 hours if making the transcript fails. The transcription provider deletes the audio once it has been processed |
| Meeting transcripts | 30 days, then deleted automatically. You can delete one sooner |
| Meeting minutes (summary, decisions, tasks, follow-up email) | Until you delete the meeting or your account |

**§8 transfers**: no change needed. "Some sub-processors process data outside the UK, chiefly in the United States" already covers US workspaces, and also covers Recall support staff in the US reaching UK and EU data when they need to (Recall's DPA has the SCCs and UK Addendum for that). UK and EU workspaces' recordings and transcripts stay in the EU, which has UK adequacy.

## 4. DPA 1.2 (both features), changes from 1.1

Code: `CURRENT_DPA_VERSION = '1.2'` in `accept-dpa.ts`; new `DPA_1_2_HTML` and `DPA_EFFECTIVE_DATES['1.2']` in `get-dpa-content.ts`; 1.0 and 1.1 stay readable. The Email Assistant parts are copied **unchanged** from `docs/email-assistant-phase0.md` §5. The Note Taker parts are new.

**Annex 1, Nature and purpose:** after "reading data from the accounts you connect;" add:
> *(Email Assistant)* reading, sorting, summarising and drafting replies to the emails in mailboxes you or your users connect to the Email Assistant, and moving, labelling or sending them when you approve it;
> *(Note Taker)* sending a meeting bot, when you ask, into online meetings to record them only long enough to make a transcript, and writing minutes from that transcript;

**Annex 1, Categories of data subjects:** add:
> *(Email Assistant)* people who email you or your users at a mailbox connected to the Email Assistant, and people named in those emails;
> *(Note Taker)* people taking part in meetings you send the Note Taker to, and people named in them;

**Annex 1, Types of personal data:** add:
> *(Email Assistant)* email headers (sender, recipients, subject, date) and the content of emails in connected mailboxes, which is read but not stored; summaries and categories we derive from them;
> *(Note Taker)* meeting audio and video, kept only until the transcript is saved; transcripts of what was said, with each speaker's display name; meeting titles, times and participant display names;

**Annex 1, Special category data:** replace "none intended — see clause 13." with:
> none intended, except as incidentally contained in emails read by the Email Assistant or in meetings the Note Taker joins — see clause 13.

**Clause 13:** add two paragraphs after the first:
> *(Email Assistant, agreed 12 November)* **Connected mailboxes.** Emails in a mailbox you connect to the Email Assistant may contain special category or criminal offence data that you did not choose to send us. Clause 13's first paragraph does not apply to that data. We process it only to sort the email, summarise it and draft the reply you ask for; we do not store email bodies; we instruct our assistants never to infer, record or label a special category; and senders you mark as private are never sent to an AI model. You remain responsible for having a lawful basis, and a condition under Article 9 where one is needed, for processing the emails you receive.
>
> **Meetings the Note Taker joins.** What people say in a meeting you send the Note Taker to may include special category or criminal offence data. Clause 13's first paragraph does not apply to that data. We process it only to make the transcript and write the minutes you asked for; the recording is deleted as soon as the transcript is saved; the transcript is deleted after 30 days; and we instruct our assistants never to infer, record or label a special category in the minutes. Do not send the Note Taker to meetings whose purpose is to discuss special category data (for example a medical consultation or a disciplinary hearing) unless you have a lawful basis and an Article 9 condition for it. You are responsible for telling the people in the meeting that it is being recorded and transcribed.

**Annex 2, Security measures:** add:
> *(Email Assistant)* Mailbox access tokens encrypted with a separate key per mailbox; email bodies and attachments not stored; email text excluded from logs; mailbox data deleted at once when a mailbox is disconnected.
> *(Note Taker)* Meeting recordings deleted at our provider as soon as the transcript is saved; transcripts deleted after 30 days; meeting text excluded from logs; UK and EU workspaces' meetings recorded, transcribed and stored in the EU; our provider's support access from outside the EU is limited to staff who need it, with multi-factor sign-in, under standard contractual clauses.

## 5. Terms 2.5 (drafted; published at L)

Header: `Version 2.5 · Last updated: ⟨L⟩ (clause 5.2: Note Taker in a meeting; clause 9.3: meetings)`. Then `CURRENT_TOS_VERSION = '2.5'` and the workspace modal's "What changed" list and "(v2.5)" label (memory: Terms bump checklist).

**Clause 5.2**, insert after the AI presenter sentence:
> the Note Taker joining an online meeting as 1 task for each started 5 minutes it is in the call (a 1-hour meeting is 12 tasks; nothing if it is never let in),

Use plain text, not a `data-task-cost` span, until the cost is live, as was done for the AI presenter.

**New clause 9.3** (Acceptable use):
> **9.3 — Meetings.** When you send the Note Taker to a meeting, you must tell the people in it that it is there and is recording and transcribing the meeting, and get any consent the law requires. In some places, including several US states, every participant must agree before a conversation is recorded. You must not use it to record a meeting secretly, to record people who have asked not to be recorded, or to record a meeting you are not entitled to attend. The Note Taker announces itself in the meeting chat and can be removed by the host, but that does not replace your duty to tell people.

**Clause 13.4** (disclosure to recipients): no change. The follow-up email already carries the AI footer.

## 6. Help, Pricing and the in-app reminder (published at L)

- **Help article** "The Note Taker joining your calls": how to send it, the admit step on each platform, the Zoom "connect Zoom and be in the call" rule (when Zoom ships), "everyone in one room shares one name", the cost, the retention rules, and "tell people, and in some US states get everyone's consent".
- **Pricing page** weights list: add the Note Taker row next to the AI presenter.
- **Send dialog line** (plan §4): "Tell everyone in the meeting that the Note Taker is recording. In some places you need their consent."

## 7. Notices for the owner to send

### 7.1 Sub-processor notice (email to every workspace owner, at least 14 days before L)

> **Subject:** A new sub-processor for the Note Taker: Recall.ai
>
> We're telling you, as our Data Processing Agreement promises, that from ⟨L⟩ we will use a new sub-processor: **Recall.ai**.
>
> **What it does:** when you send your Note Taker to a Google Meet, Microsoft Teams or Zoom call, Recall.ai's bot joins the call, makes the transcript and then deletes the recording. Recall.ai uses AssemblyAI to turn the audio into text; AssemblyAI deletes the audio once that is done. It is only used when you choose to send the Note Taker to a meeting.
>
> **Where:** recordings and transcripts for UK and EU workspaces are made and stored in the EU (Frankfurt); for US workspaces, in the US. Recall.ai's support staff in the US may access data when they need to, to support or fix the service. Recall.ai's data processing agreement includes the standard contractual clauses and the UK Addendum that cover this.
>
> **Your choice:** if you object, reply to this email before ⟨L⟩. If we can't resolve it, you can stop using the Note Taker's meeting feature or end your subscription without an early-termination charge (DPA clause 5).
>
> The full list is on our Trust page: bemoreswan.com/trust.html#sub-processors

### 7.2 Charge announcement "Why" text (Admin → Task costs, at least 30 days before L)

> The Note Taker can now join your Google Meet and Microsoft Teams calls and take the notes itself, even on free accounts. Each meeting it joins uses 1 task for each started 5 minutes it is in the call (a 1-hour meeting is 12 tasks). Nothing is charged if it isn't let in. Pasting notes or a transcript stays free.

## 8. Data protection impact assessment (short)

**Why one is needed:** recording conversations is high-risk processing (ICO screening: new technology, people who may not expect it, possible special category data in what is said).

| | |
|---|---|
| **Processing** | A bot joins a meeting the customer chooses, records audio only to make a transcript, deletes the recording, keeps the transcript 30 days, and writes minutes that a person approves |
| **Roles** | Customer = controller. Be More Swan = processor. Recall.ai = sub-processor. AssemblyAI = Recall's sub-processor for the transcription (sees the audio). Anthropic = sub-processor for the minutes (existing) |
| **People affected** | Meeting participants, including people outside the customer's business who never signed up to Be More Swan |
| **Necessity and proportionality** | Only meetings the user sends it to (v1 has no automatic joining; calendar auto-join is off by default in v2). Audio is never stored by us. Transcript kept 30 days, the shortest that still allows "redo the minutes". Minutes are the purpose, and the customer controls them |

**Risks and measures:**

| Risk | Likelihood / impact | Measures | Left over |
|---|---|---|---|
| People recorded without knowing | Medium / high | Bot's name says what it is; chat notice on joining (proven in Phase 0 on Meet and Teams); host must admit it and can remove it; Terms 9.3; reminder in the send dialog | Low |
| All-party consent laws (US states) broken | Medium / high | Terms 9.3 puts the duty on the customer; help article names it; the in-call notice supports consent | Medium (customer's duty) |
| Special category data in what is said | Medium / medium | DPA 13 exception limits use to transcript and minutes; prompt never infers or labels a category; meetings for medical or disciplinary purposes excluded; transcript deleted at 30 days | Low |
| Recording kept longer than needed | Low / high | `delete_media` straight after the transcript is saved (proven in Phase 0); failed jobs deleted within 24 hours | Low |
| Transfer to the US | Medium / medium | UK and EU workspaces on Recall's EU region, where recordings, transcripts and backups stay and AssemblyAI transcribes in the EU; US workspaces stay in the US. Recall support staff in the US may access data when needed (least privilege, multi-factor sign-in), covered by the SCCs and UK Addendum in Recall's DPA. Recall's logs and webhooks can hold meeting links, join times and participant names, never audio or video | Low |
| Transcription provider keeps meeting audio or text | Low / medium | AssemblyAI deletes the audio once processed; billing and log details may remain. Whether it keeps transcripts without Zero Data Retention is open (§10) | Low, pending §10 |
| Bot joins the wrong meeting | Low / medium | Sent only by a person pasting a link or approving a chat card; duplicate-send guard; Remove from call / Cancel | Low |
| Vendor breach | Low / high | Recall SOC 2 Type II and ISO 27001; recordings deleted at once, so little is held | Low |

**Outcome:** acceptable with the measures above. No prior consultation with the ICO needed. Review at L + 3 months, or when calendar auto-join (v2) or Zoom ships.

## 9. Also to check in plan step 2 (code)

- **Special category rule in prompts.** Master assistant prompts get `SPECIAL_CATEGORY_CLAUSE` through `withSpecialCategoryClause(prompt, roleKey, …)` (admin-api.ts, about line 2311), which already swaps in a role's own clause; the Email Assistant uses `EMAIL_SPECIAL_CATEGORY_CLAUSE` (`src/utils/email-sort.ts`). A meeting transcript mentioning someone's illness must not produce a refusal as the minutes. The minutes writer builds its own prompt (`meeting-minutes-writer.ts`). Confirm the general clause never reaches it, and add a `meeting_note_taker` clause in line with DPA 13 ("use it only as needed for the minutes; never infer, record or label a category").
- **DPA 1.2 gate:** `send-meeting-bot` refuses until the workspace has accepted 1.2, with a link to accept.

## 10. Recall's answers (20 November 2026) and what is still open

Recall support replied on 20 November 2026 to our questions about transcription and where data goes:

- Recall's own transcription (`recallai_streaming`, our choice B2) **is run by AssemblyAI**, listed as "optional" on Recall's sub-processor list. AssemblyAI therefore always handles our meetings. Work from the EU region is processed in the EU.
- Without Zero Data Retention, AssemblyAI deletes the audio after processing; limited billing and logging details may remain.
- **With** Zero Data Retention **and** `prioritize_low_latency` mode, AssemblyAI keeps no audio or transcript. Our code uses `prioritize_accuracy` with `language_code: 'auto'` (`src/utils/meeting-bot.ts`), so that promise does not apply to us today.
- EU workspace: recordings, transcripts, personal data from meetings and backups stay in the region where the meeting was captured. Logs and request metadata (resource IDs, meeting links, join times, custom metadata, participant identifiers) go to Recall's logging and webhook sub-processors, never audio or video.
- Recall staff in the US may access customer data to support, debug or maintain the service (least privilege, multi-factor sign-in).

**Still to ask Recall (before the Trust row goes up at L − 14):**
1. Does AssemblyAI keep transcripts when Zero Data Retention is off, and for how long?
2. Can Zero Data Retention be switched on for a pay-as-you-go account, and at what price?
3. Does `prioritize_low_latency` support automatic language detection, or only some languages? (Decides whether switching to it is worth it.)
4. How does the DPA's "primary processing in the United States" fit the EU region? (The reply covered storage, not this sentence.)

If Zero Data Retention with `prioritize_low_latency` turns out to be available and good enough, switching the bot to it is a one-line code change, and the "Transcription provider keeps" row in §8 drops to Low.
