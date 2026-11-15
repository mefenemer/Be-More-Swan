# Meeting Note Taker — what's left (feature request #38)

2026-11-15 · Audit only. **Nothing built in this pass.** No database was queried; SQL status below comes from memory notes and the files in `db/`.

The assistant is `meeting_note_taker`, shown to customers as **Minute Taker**. Earlier plans: `docs/meeting-note-taker-plan.md` (Phases 0–5) and `docs/meeting-note-taker-phase3-plan.md`.

## 1. Short answer

- **The text half is code-complete but never proven live.** You paste notes into chat and get a summary, decisions, risks, action items, attendees and a draft follow-up email. The Inbox lets you fix attendee emails and approve. Approving can post to Slack, make a Notion page, send the email (Gmail, else Resend) and file one Jira or Asana ticket per action item, with "5 of 8 synced" pills. All of this is Phases 1–3, finished 2026-07-08. None of it has been run against a real Slack, Notion, Jira or Asana account, and there are no automated tests for that path.
- **The headline feature is not started.** Uploading a recording (Phase 4a) and a bot that joins the call (Phase 4b) don't exist. There is no `transcripts` table, no transcription job, no upload screen and no consent step. Phase 5 (a proper meeting activity in HubSpot, plus Salesforce and Zoho) is missing too, and the HubSpot meeting recipe is `coming_soon`.
- **Customers can't use it yet.** The catalogue row is Coming soon on both databases (memory, 2026-11-04), so `hire-assistant.ts:87` refuses to hire it. Public copy is honest: it says "paste in", and its connections show as Coming soon (`connections.html:518`, `faq.html:290`).
- **How much is left.** About 9 small PRs, plus your own set-up, to launch the text version honestly (§4 A). Another 3–4 PRs for recording upload (§4 B). The bot is a separate project that needs decisions first (§4 C). Roughly 60% of the text product is done, and 0% of the audio product.

## 2. Capability table

| Capability | Planned in | Status | Evidence |
|---|---|---|---|
| Paste notes in chat → summary / decisions / risks / tasks | Ph 1 | works (chat only) | `netlify/functions/chat-orchestrator.ts:2577-2637` |
| Attendees + draft follow-up email extracted | Ph 2 | works | `chat-orchestrator.ts:2607-2627` |
| Saved as a meeting record (Inbox / Meeting Notes) | Ph 1 | works | `chat-orchestrator.ts:1005-1009` (`hubRecordsFromUiElement`) |
| Long transcripts | Ph 1 | partial: 4,000 characters per message, 20-message history, so the user has to paste it in chunks | `chat-orchestrator.ts:168,174,3156`; prompt `:2603` |
| Attach a transcript file (.txt/.docx/.pdf/.vtt) in chat | Ph 4a | missing: attachments are on for `website_assistant` only | `src/components/chat-session.js:39-42` |
| Start a meeting write-up from the GUI (no chat) | GUI/chat rule | missing: the primary button only opens chat. CSV import of past meetings exists | `src/components/assistant-dashboard-registry.js:1302,1325` |
| Inbox: edit attendee emails and the follow-up, then approve or reject | Ph 2 | works (GUI) | `assistants.js:3068-3145, 4238-4273` |
| Approve, edit or reject a meeting from chat | GUI/chat rule | missing: no meetings snapshot (`contentSnapshot: null`) and no action card | `src/config/chat-capabilities.generated.ts:123-130` |
| Chat sees its own past meetings | GUI/chat rule | missing | as above |
| Learns from a rejection note | — | works | `tests/records-rejection-learning.test.ts` (12 checks pass) |
| Chat card's "Post to Slack" / "Sync to Notion" button | Ph 1 | partial and wrong: it sends **unapproved** text, skipping the Inbox. A Jira or Asana choice also posts to Slack and says "direct Jira sync is coming" | `src/components/disruptive-ui-registry.js:4728-4866` |
| Prompt says "connections are not wired up yet" | — | out of date | `chat-orchestrator.ts:2590` |
| Approval → hand-off recipes (scenario engine) | baseline | works in code | `netlify/functions/assistant-records.ts:1048-1049`; `src/utils/scenario-engine.ts:174-272` |
| Slack summary recipe | baseline | untested with a real account | `db/seed-catalog.ts:518-523`; `netlify/functions/sync-action.ts:967` |
| Notion page recipe | Ph 2/3 | untested; needs `NOTION_CLIENT_*` | `seed-catalog.ts:561-566`; `oauth-integrations.ts:353,605` |
| Follow-up email to attendees | Ph 2 | partial: sends from Gmail or Resend, but **Outlook isn't used** even though `sendOutlookMessage` exists | `sync-action.ts:753-800`; `src/utils/outlook.ts:28` |
| Email recipe works with no connection | Ph 2 | works in code | `netlify/functions/integration-scenarios.ts:30,128` |
| `action_items` ledger written on approval | Ph 3 | works in code; table must exist | `assistant-records.ts:116-153`; `db/schema.ts:3490`; `db/action-items.sql` |
| Jira and Asana: one ticket per task | Ph 3 | untested with real accounts | `sync-action.ts:860-976`; `oauth-integrations.ts:409-416, 988-1063`; `src/utils/pm-tickets.ts` |
| "N of M synced" pills in the Inbox | Ph 3 | works (checked in a component harness only) | `assistant-records.ts:166-200`; `assistants.js:3030-3060` |
| Set-up questions (platform, format, destination) | — | works; Slack isn't offered as a destination | `src/public/assistant-onboarding-schemas.js:1044-1099` |
| Overview numbers, Calendar, ROI hours | — | works | registry `:1266-1295`; `src/utils/roi-activity.ts:68` |
| Recording upload → transcript → minutes | Ph 4a | missing (no `transcripts` table, no job, no UI). Scribe and whisper helpers exist but have an 8 s timeout | `src/lib/tts.ts:261-308` |
| Bot joins Zoom / Meet / Teams | Ph 4b | missing; the chat capability list says "cannot join a call" | `src/utils/assistant-chat-capabilities.ts:381-386` |
| Recording consent notice | Ph 4b | missing | — |
| HubSpot meeting activity, Salesforce, Zoho | Ph 5 | missing (`coming_soon`) | `seed-catalog.ts:510-515` |
| Task metering | — | chat costs no task, so nothing is charged today. Transcription would need `work-metering` | memory: background-work-metered |
| Automated tests for this pipeline | — | missing: no test covers follow-up email, `create_tasks`, materialise or the pills | `tests/` (grep) |

## 3. Blockers

**SQL and seed (you run these; I give SQL, not psql commands):**
1. `db/action-items.sql` on **both** databases. Memory says "apply manually" and never confirms it was done. ⚠️ The `schema_migrations` baseline can mark a file as applied without running it, so check the table itself: `SELECT to_regclass('public.action_items');`. A null means it isn't there. Without the table, approval still works but no tickets are filed and no pills show (the error is logged as non-fatal).
2. `npm run db:seed-catalog` on both databases. This registers the `email`, `jira` and `asana` providers and the `email_meeting_followup`, `jira_create_tasks`, `asana_create_tasks` and `notion_create_page` recipes. Check: `SELECT scenario_key, status FROM integration_scenarios WHERE scenario_type = 'meeting_handoff';`.
3. When audio lands, a new `db/z-meeting-transcripts.sql` goes on both databases before deploy.

**Netlify env vars (none are in local `.env`; prod is unconfirmed):** `SLACK_CLIENT_ID/_SECRET`, `NOTION_CLIENT_ID/_SECRET`, `JIRA_CLIENT_ID/_SECRET`, `ASANA_CLIENT_ID/_SECRET`, `RESEND_API_KEY`. For audio, `ELEVENLABS_API_KEY` with the Speech to Text permission (verified on staging 2026-11-12).

**Third-party set-up:** each Slack, Atlassian, Asana and Notion app must allow outside workspaces to connect (distribution or public settings), with our callback URLs. The bot path needs a vendor account (for example Recall.ai) and, for Meet auto-join, the Google Cloud project that is still waiting from feature #16 / booking plan C.

**Consent and legal:**
- **ElevenLabs is missing from the Trust page sub-processor list** (`trust.html:222` lists only OpenAI and others). It already transcribes voiceovers. Add it before any meeting audio goes through it.
- Recording upload needs a statement from the uploader: "everyone in this recording knew it was being recorded". A bot needs a visible name ("Minute Taker (recording)") and an opening notice in the meeting chat.
- Transcripts can contain special-category data. Set a retention period (delete the audio once transcribed; keep transcripts N days) and mention it in `privacy.html` and `dpa.html`.

## 4. Finish list (each step one PR)

**A. Launch the text version**
1. **Prove the database** (you). Done: both checks in §3 return rows on staging and prod. Proof: the two SELECTs.
2. **Pin the current behaviour with tests.** Add `tests/meeting-note-taker.test.ts`. It should cover: `hubRecordsFromUiElement` for meetings; `buildEmailPayload` and `buildTasksPayload` recipients and targets; `handleCreateTasks` with a stub `fetch` giving synced, failed and skipped results; and the materialise upsert, moved into a pure function. Done: it passes on main.
3. **One way to send.** Replace the chat card's direct Slack/Notion button with "Review in Inbox" plus "Approve", which uses the same `assistant-records` PATCH as the Inbox. Remove the "direct Jira sync is coming" line and the out-of-date "not wired up yet" sentence in the prompt. Done: nothing leaves the workspace before approval. Proof: a source-scan test that the card never calls `postSyncAction`.
4. **Long transcripts.** Turn on attachments for `meeting_note_taker` (.txt, .docx, .pdf, plus .vtt/.srt with timestamps stripped). Raise `maxTokens` to 4096. Done: a 60-minute transcript file makes one record. Proof: a fixture test on the parser and on the attachment acceptance list.
5. **GUI parity: "New meeting".** Move the prompt and parsing into `src/utils/meeting-minutes.ts`, used by chat and by a new `meeting-minutes.ts` endpoint. Add a paste-or-attach form on the Inbox / Meeting Notes tab. Done: a meeting can be written up without chat. Proof: a test that both paths call the same function.
6. **Chat parity: review.** Add a meetings snapshot to the chat prompt (recent meetings, waiting ones, attendees with no email) and a `meeting_action_proposal` card (approve, add attendee email, edit the follow-up, reject with a note), all through the same PATCH. Regenerate the chat capabilities manifest and its wording (FR#17 CI). Proof: a capabilities test plus a card test.
7. **Outlook follow-ups.** Try Gmail, then Outlook (`sendOutlookMessage`), then Resend. Done: an Outlook-only workspace sends from its own inbox. Proof: unit tests with each one stubbed.
8. **Real-account run on staging.** Connect Slack, Notion, Jira, Asana, Gmail and Outlook, approve one meeting, and record the results. Done: each produces its artefact. Only verified connections get marked Live.
9. **Go live.** Set the status to Live in Admin → Assistants (one status). Move the verified Minute Taker cards on `connections.html` to Live, update `faq.html:290` and `tests/homepage-faq-2026-11-03.test.ts`, and fix the seed comment. Proof: the public-copy tests pass, and none of the copy mentions recordings or bots.

**B. Recording upload (Phase 4a)**
10. **Legal first.** Add ElevenLabs to the Trust page, add the consent tick-box wording, and set a retention rule in the privacy notice and DPA. Done: the copy is merged before any audio code ships.
11. **Transcription job.** Add a `transcripts` table (SQL), upload audio to R2 via `storage-request-upload`, and add a `transcribe-meeting-background.ts` job. It uses Scribe with speaker labels and a long timeout or Scribe's async webhook, with `work-metering` asking first and recording afterwards. The audio is deleted after transcription and the result feeds step 5's function. Proof: a stubbed-fetch test (job → transcript → record) and a metering-order test.
12. **Audio in both places.** Add audio to the GUI form and to chat attachments, both starting the same job, plus a "transcribing…" state on the record. Proof: a parity test, and one real 30-minute file on staging.
13. **Copy.** Only after step 12 is verified, change the description to "paste notes or upload a recording".

**C. Later (needs decisions)**
14. Bot that joins calls (Phase 4b), using a vendor plus calendar auto-join and the consent notice.
15. HubSpot meeting activity, then Salesforce and Zoho (Phase 5), once the CRM recipes leave `coming_soon`.

## 5. Decisions for the owner

1. **Launch text-only first?** My recommendation is yes: §4 A, with recording upload as a follow-up. The alternative is to keep it Coming soon until audio works.
2. **Which connections launch Live:** only those that pass step 8, or hold them all until every one passes?
3. **Remove the chat card's instant Slack/Notion push** so that approval is the only way anything is sent (step 3)?
4. **Follow-up with no connected inbox:** keep sending from the Be More Swan domain via Resend, or require Gmail or Outlook?
5. **Transcription provider:** ElevenLabs Scribe (already in use, about $0.20 per hour of audio) or another?
6. **Charging:** how many tasks per uploaded hour of audio? Pasted text stays free as chat.
7. **Retention:** delete audio straight after transcription? How long to keep transcripts?
8. **Meeting bot:** build it (vendor cost per hour, consent duties, Google Cloud project), or stay upload-only for now?
9. **Name:** keep "Minute Taker" in the product (the feature request says "Meeting Note Taker")?
10. **Slack as an action-item destination:** add it to the set-up dropdown, or keep it as a summary-only recipe?
