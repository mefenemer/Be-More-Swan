# Meeting Note Taker — Prioritised Build Plan

Gap-closure plan to take the live `meeting_note_taker` role from a text-paste chat
summariser to the "Action Extraction & Routing Engine" described in the brief.

**Baseline (already built, reused throughout):**
- Role live via shared `chat-orchestrator.ts` (`meeting_note_taker`, `action_item_assignment` card).
- Approval staging = `assistant_records.approvalStatus` (`pending_approval → approved → scheduled → rejected`).
- Approval → outbound trigger seam wired: meeting record → `MEETING_BOOKED` → scenario engine
  (`enqueueHandoffOnApproval`, `assistant-records.ts`).
- Recipes live: `hubspot_meeting_handoff`, `slack_meeting_summary`, `universal_webhook_meeting`.
- Background-function + webhook infra exists and is reusable (`*-background.ts`, `webhook-intake.ts`).

**Sequencing philosophy:** ship value on the existing *text* path first (cheap, no new infra),
then run the audio-ingestion megaproject as a parallel track. Phases 1–3 need no new
infrastructure; Phase 4 is the heavy lift.

---

## Phase 0 — Decision gates (before coding)

1. **Ingestion approach.** Recommended: **upload-first MVP** (user uploads audio/`.txt`/`.vtt`),
   meeting-bot auto-join (Recall.ai/Zoom) as a fast-follow. Rationale: bot integration is a
   quarter of work on its own (OAuth, consent/recording law, per-platform bots); upload proves
   the transcription+extraction pipeline with ~10% of the effort.
2. **Data model.** Recommended: **keep the `assistant_records` JSON blob** for the record +
   approval, add a **normalized `action_items` child table only** (needed for per-task PM sync
   status + "5 of 8 synced"). Full 4-table normalization (Meetings/Transcripts/Insights/Actions)
   is not justified yet — `transcripts` is the one extra table worth adding when Phase 4 lands.
3. **"Review Queue" naming.** Brief forbids heavy terminology. Decide: global rename vs.
   per-role label override. Recommended: per-role label ("Inbox") to avoid churning every
   other assistant's UI.

---

## Phase 1 — Complete the extraction schema  *(P0 · S · no new infra)*

Highest value-to-effort: makes the LLM output match the brief's four-part contract. Pure
prompt + card + record-mapping change on the existing text path.

- **Prompt** (`chat-orchestrator.ts` `meeting_note_taker.buildRolePrompt`): force four
  separated fields — `executiveSummary`, `decisionsMade[]`, `identifiedRisks[]`, `tasks[]`.
  Keep attribution rules for `tasks`.
- **Card renderer** (`disruptive-ui-registry.js`, `ActionItemAssignmentCard`): render Decisions
  and Risks sections; keep them collapsible so short meetings stay clean.
- **Record mapping** (`chat-orchestrator.ts` `toHubRecords`): persist the new fields into
  `assistant_records.data`.
- **Handoff mapping** (`enqueueHandoffOnApproval`): expose `decisionsMade` + `identifiedRisks`
  in the scenario `fields` payload so downstream recipes can consume them.

**Exit:** a pasted transcript yields Summary / Decisions / Risks / Action Items, all staged.

---

## Phase 2 — Draft follow-up email + frictionless inbox  *(P1 · M · reuses email + approval)*

Delivers the brief's "draft follow-up emails placed in a staging state" and the
Automated Follow-Up scenario.

- **Capture attendees.** Add `attendees[{name,email}]` extraction to the prompt + card
  (editable in the staging card — emails are rarely in a transcript verbatim).
- **Generate a draft email** alongside the card (summary + next steps), stored on the record;
  surface an editable draft in the inbox with Approve / Edit.
- **New recipe:** `email_meeting_followup` (scenarioType `meeting_handoff`) — on approval, send
  to all attendees. Reuse `send-outbound-email.ts` (Gmail/Microsoft from the user's inbox);
  add generic SMTP/SendGrid as the no-connection fallback.
- **Inbox polish:** apply the Phase 0.3 naming decision.

**Exit:** approving a meeting emails a reviewed summary to attendees from the user's inbox.

---

## Phase 3 — Project-management task push  *(P1 · M/L · new providers + per-task table)*

Closes the biggest routing gap (`action_items` → real tickets).

- **Providers** (`seed-catalog.ts` `PROVIDERS` + `IntegrationProvider` union): add `jira`,
  `asana` (OAuth2). Wire auth via existing `oauth-integrations.ts` / `authorize-integration.ts`.
- **Normalized `action_items` table** (Phase 0.2) with per-task `syncStatus` +
  `externalTicketId`, so partial syncs and idempotency work.
- **Recipes:** `jira_create_tasks`, `asana_create_tasks` — one ticket per approved action item,
  owner/deadline mapped. Execute in `process-scenario-jobs.ts` via a new
  `create_tasks` actionType.
- Keep `custom_webhook` as the DIY escape hatch (already works).

**Exit:** approving a meeting creates one Jira/Asana ticket per action item, with sync state.

---

## Phase 4 — Audio ingestion pipeline  *(P2 · XL · the headline feature, parallel track)*

The megaproject. Build on the existing background-function + webhook pattern.

**4a. Upload path (MVP):**
- Reuse the R2 upload flow (`storage-request-upload.ts` / `content-upload-url.ts`) for
  audio + `.txt`/`.vtt`.
- New `transcripts` table (raw text + provider + status + `meetingRecordId`).
- `transcribe-meeting-background.ts` (background function, 15-min ceiling): pushes audio to
  **AssemblyAI or Whisper**, receives the transcript. For long audio use the provider's async
  webhook → `webhook-intake.ts` → resume, rather than blocking the function.
- On transcript ready, run the Phase 1 extraction and land the staged record — same inbox,
  no new UI.

**4b. Meeting-bot path (fast-follow):**
- Integrate Recall.ai (or native Zoom/Meet bots) to auto-join and produce recordings.
- Consent/recording-law handling + per-platform OAuth. Feeds the same `transcripts` → extract flow.

**Exit:** upload an audio file (or a bot auto-joins) → transcript → staged 4-part insights.

---

## Phase 5 — CRM depth & polish  *(P2 · M)*

- Upgrade `hubspot_meeting_handoff` from contact-property write to a logged **Meeting Activity
  engagement attached to a Contact/Deal**; include `identifiedRisks`.
- Add Salesforce/Zoho meeting recipes (providers already listed).
- `status_report_generator` cross-sell hook (out of scope here).

---

## Priority summary

| Phase | What | Priority | Effort | New infra? |
|---|---|---|---|---|
| 1 | 4-part extraction schema | **P0** | S | No |
| 2 | Draft email + attendee follow-up | P1 | M | No |
| 3 | Jira/Asana task push | P1 | M/L | Providers + 1 table |
| 4 | Audio → transcript ingestion | P2 | XL | Transcription provider, bots |
| 5 | CRM engagement depth | P2 | M | No |

**Recommended cut for a first shippable increment:** Phases 1 + 2 (both on the existing text
path, no new infra) turn the role into a genuine summary→decisions→risks→actions→email engine.
Phase 4 is the differentiator but should not block that value.

**Migration note:** new `db/*.sql` (action_items, transcripts) must be applied manually + via
`db:seed-catalog`, per project convention.
