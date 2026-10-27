# Lead Generator: one Outreach tab, in stages, with an editable Follow-up plan

Raised by the owner 2026-10-27. Status:
- **Phase 1 — BUILT 2026-10-27, not committed.**
  - `src/config/lead-outreach-phase.ts`, mirrored to the browser as `window.LeadOutreachPhase`
  - `lead-threads.ts` action `board`
  - `tests/lead-outreach-phase.test.ts`
  - Nothing on screen uses it yet.
  - `board` has not yet been called against a real database.
- **Phase 2 — BUILT 2026-10-27, not committed.** Details:
  - **Stage strip:** `src/components/assistant-lead-outreach.js`.
  - **Conversations list:** reads `board`, shows one stage at a time, and opens hand-sent leads to their notes and outcome.
  - **Tab retired:** the Conversations tab button and panel are removed. `'conversations'` is now an alias for the Outreach tab.
  - **Registry:** `reviewQueue.staged`, and `resultsTabAfter: 'review-queue'`.
  - **Copy:** the chat prompt and the reply notification now name the stages. The help copy is in `db/help-articles-2026-12zzzzzzzzzz-outreach-stages.sql`, which has **not been applied** to either database.
  - **Tests:** `tests/lead-outreach-stages.test.ts`.
  - **Checked in a component test page** (`component-harness-outreach-stages`, port 4533): the real components on the real Outreach markup against a fake API. The `assistants.js` wiring is covered by tests only, not by a logged-in session.
  - **Two bugs found and fixed in that check:**
    - A conversation opened while the list was redrawn stayed on "Loading…" for good.
    - The table's hidden "Open" label widened the whole page on a phone. That one was already true of the old Conversations tab.
- **Phase 3 — BUILT 2026-10-27, not committed.** Details:
  - **Rules:** `src/config/follow-up-plan.ts` (limits, no reordering, numbers never reused, the last-email rule).
  - **Writer:** `saveSequenceSteps`, `loadFollowUpPlan` and `haltActiveEnrolmentsForAssistant` in `outreach-sequences.ts`.
  - **Actions:** `get_follow_up_plan` / `save_follow_up_plan`, in **`lead-generation.ts`** rather than `lead-threads.ts`. That's where the other setup answers (`set_outreach_provider`, `set_outreach_offer`) are merged.
  - **Panel:** `src/components/assistant-follow-up-plan.js`, opened from the stage strip.
  - **Chat card:** `follow_up_plan` (`src/utils/chat-follow-up-plan.ts`).
  - **Copy:** the To approve note quotes the saved plan, and the fixed "3 days, a week" wording is gone from the code. Help copy is in `db/help-articles-2026-12zzzzzzzzzzz-follow-up-plan.sql` (**not applied**).
  - **Tests:** `tests/follow-up-plan.test.ts`.
- **Found while building Phase 3: the worker used step NUMBERS** for "the first follow-up" (where the offer link goes), the 5-email cap, and "follow-up number N". Once a plan is edited, numbers have gaps, so all three now use the step's position in the plan. Switching chasing off still affects only NEW approvals unless the owner ticks "also stop the ones running".
- **Phase 4 — BUILT 2026-10-27, not committed.** Details:
  - **Drafter:** `previewFollowUp` in `process-sequence-sends.ts` calls the worker's own `draftFollowUp`. It mints no tracked link, sends nothing and writes nothing.
  - **Action:** `preview_follow_up` in `lead-generation.ts`. It checks the lead belongs to this workspace and assistant and is still being followed up, then meters the call as a fair-use **helper** (not a task) before drafting.
  - **Panel:** "Preview with [lead]" and a **Preview this one** button on each step, using the wording on screen even if unsaved.
  - **Conversation row:** **Preview the next one** under Following up.
  - **Chat:** a `follow_up_preview` card. The model never writes the follow-up itself.
  - **Help:** `db/help-articles-2026-12zzzzzzzzzzzz-follow-up-preview.sql` (**not applied**).
  - **Checked** in the component test page against a fake API. Not yet checked against the real model.

Two refinements made during the build:
- **Finished** gained an **Opted out** group, for a reply opt-out, suppression or do-not-contact.
- A halted plan flagged *needs attention* stays in **Following up** rather than being filed as over.

The request, in the owner's words: fold Conversations into Outreach, lay Outreach out left-to-right
as the steps a lead actually goes through, and give the user a follow-up plan they can see and edit.
Follow-ups stay a Lead Generator job; they do **not** move to Email Flows (reasons at the end).

## Why

Today one sent lead can show up in **three** places:

| Where | Why it's there |
|---|---|
| Outreach ▸ Approved | the Approved column asks for `approved,scheduled` (`assistants.js` `_detailRqRefreshRecordCounts`), on purpose, so a send doesn't make the lead vanish |
| Outreach ▸ Awaiting reply | `scheduled` = the chase reminder (registry `columnLabels`) |
| Conversations | the `lead_threads` row the send opened (`assistant-lead-threads.js`) |

The Outreach columns are the **shared** review queue (`_DETAIL_RQ_COLUMNS`, `assistant-detail.html`
~L923). Social, blog and email roles use the same columns, and the lead role reaches them through
label overrides. That is why "Posted" and "Needs attention" have post meanings, and why the lead
lifecycle has been patched onto it one override at a time.

Separately, the follow-up plan can't be seen or changed. `ensureDefaultSequence` creates the same
3-step plan for every assistant (`src/config/outreach-sequences.ts` `DEFAULT_SEQUENCE_STEPS`). The
tables already support per-assistant steps (`sequence_steps.delay_days`, `body_prompt`,
`is_enabled`), and the worker reads them **live on every send** (`process-sequence-sends.ts`
`loadSteps`). So what's missing is a screen, not the engine underneath it.

## The new Outreach tab

The lead role gets its own Outreach body, a new `src/components/assistant-lead-outreach.js`. It
replaces the shared columns for this role only, the same way blog and newsletter queues already
branch in `_detailRqRenderGroups`. Other roles are untouched.

```
Outreach   [Follow-up plan ⚙]
 1 To approve (4) │ 2 Following up (12) │ 3 Replied (2●) │ 4 Finished (31) │ Archived
```

| Stage | What's in it | Built from | Row actions |
|---|---|---|---|
| **1 To approve** | Drafted first emails waiting for sign-off. A second group, **"Approved — send it yourself"**, holds approved leads with no inbox or in one-email-only mode (`outreachDraftedAt`, not sent) | today's Review cards (`_detailRqRenderRecords('review')`, bulk Approve & send unchanged) + approved-not-sent records | Approve & send, Edit draft, Reject · Send email now, Mark as sent |
| **2 Following up** | Sent, no reply, not finished. Key column **Next**: "Chaser 2 of 3 · due Thu 3 Nov" / "No follow-ups (one email only)". Group **"Contacted outside the app"** = `outreachSentVia: 'manual'` (no thread, so no automatic chasers; shows the chase-reminder date) | thread `open` + enrolment, or manual-sent record | expand thread · Send the next one now · Stop follow-ups · Note · Record outcome |
| **3 Replied** | They wrote back and no outcome has been recorded yet. **The amber pill lives here.** Recording an outcome clears it, which answers the "a permanent badge is a broken badge" objection in `assistant-lead-threads.js` `updateTab()` | thread `replied`, no `dealOutcome` | expand + reply composer · Record outcome · Note |
| **4 Finished** | Grouped **Won / Lost / Disqualified / No reply**. "No reply" = the full plan ran (`completed`/`max_steps`) or the plan was stopped with no reply | `dealOutcome` set, or enrolment terminal + thread not replied | expand · change outcome · Note |
| **Archived** | Rejected before sending (retention rules unchanged) | `approval_status = rejected` | unchanged |

**Needs attention is a flag, not a stage.** A red chip shows on the row in whatever stage it's in,
plus a filter chip "Needs attention (n)". It covers enrolments halted on `not_connected` /
`send_failed`, and a mailbox that has disconnected. The fix happens on the row (Reconnect), so
there's no column to go and find it in.

**What happens next** after each stage is said on screen, in one line under the strip:
- **Replied:** record the outcome.
- **Won:** joins the Audience (owner decision 2026-10-11).
- **No reply:** the lead stays on the normal 30-day clock and is never added to a marketing list.

### One function decides the stage

`leadOutreachPhase({ record, thread, enrolment })` → `to_approve | following_up | replied | finished |
archived` plus `needsAttention: boolean`. It goes in **`src/config/lead-outreach-phase.ts`** and
reaches the browser through `gen-client-constants.ts` (like `window.LeadOutreach`). The tab, its
counts, the chat's "YOUR LEADS RIGHT NOW" block and the Results figures all call this one function,
so they can't disagree.

⚠️ Name it *phase*, not *stage*: `data.outreachStage` already exists and means the human Triage ↔
Review override (`assistant-records.ts` ~L456).

Order of precedence, written down so edge cases have one answer:
1. `rejected` → archived
2. `dealOutcome` set → finished. This covers a deal won by phone while chasers were still running.
   `set_outcome` already calls `haltEnrolmentsForRecord` (`lead-generation.ts` ~L1062), so the
   chasers stop as well.
3. thread `replied` → replied
4. sent (`outreachSentAt`) and the plan isn't over → following_up
5. plan terminal, no reply → finished ("No reply")
6. otherwise → to_approve

### Data

Stage 1 keeps its current source (`assistant-records`, `deliverable=1`). Stages 2–4 come from one
new **`lead-threads.ts` action `board`**. It returns sent lead records LEFT JOINed to their thread
and enrolment, so the manual-sent leads, which have no thread, still appear. It reuses `list`'s rules:
never selects `reply_token`, drains to `MAX_THREADS`, and returns `dealOutcome` through
`dealOutcomeOf()`. The existing Conversations list, row-expand, thread view, composer, erasure and
cadence actions are **reused as-is** inside stages 2–4. The work is to mount the component per stage
with a fixed phase filter, not to rewrite it.

### Retiring the Conversations tab

- Registry: remove `conversationsTab`, and change `resultsTabAfter: 'conversations'` →
  `'review-queue'`.
- `_activateMainTab('conversations')` becomes an **alias** that opens Outreach on the thread's stage.
  Anything that deep-links there still lands correctly: the data-hub "Open Conversations" button
  (`assistant-data-hub.js` ~L1300), `assistants.js` ~L3407, the reply notification's
  `_assistantDetailFocusThreadId`, and old bookmarks or `?tab=` links.
- Chat: rewrite the Outreach and Conversations lines in `leadGeneratorSurfaces()` and the tab names
  in `leadActionsPrompt()` (`chat-orchestrator.ts` L486–507). It should still recognise "the
  Conversations tab" as an **old name**, the way it already does for All leads.
- Help Centre: a **new dated** `db/help-articles-2026-11-*.sql`. The old seed is retired and must
  never be re-run (see memory `help-articles-quoting-and-renames`).

## The Follow-up plan

A **"Follow-up plan"** button in the Outreach header opens a panel built with `/dialogs.js`, styled
like the Email Flows step editor. The engine stays separate.

```
Follow-up plan                                   [● On]  Chase leads who don't reply
 First email ── 3 days ──► Follow-up 1  "Short nudge… one new proof point…"     [Edit] [Remove]
             ── 7 days ──► Follow-up 2  "Lighter… offer a 15-min call…"         [Edit] [Remove]
             ── 7 days ──► Follow-up 3  "Last email — say so…"                  [Edit] [Remove]
 [+ Add a follow-up]  (up to 5)                       [Reset to default]  [Save]
 Changes apply to leads you're already chasing, from their next follow-up.
```

Rules, each taken from the engine as it stands:

- **On/off writes the onboarding answer `outreachFollowUps`.** That's the switch users already know,
  and the one `followUpsEnabled` reads. `outreach_sequences.is_enabled` stays the operator's kill
  switch and is not exposed.
  ⚠️ Write it with a merge (like `set_outreach_provider`), never `update-assistant-context`, which
  replaces the whole context.
- **Step numbers never change.** The worker picks the next step as `stepNumber > lastStepSent`.
  Renumbering would make a lead already being chased skip a step or get one twice. So:
  - edit = update in place
  - remove = `is_enabled = false`
  - add = `max(step_number) + 1`
  - **no drag-to-reorder in v1**
- **Limits:** 1–5 steps (`MAX_STEPS_PER_ENROLMENT`), wait of 1–30 days, guidance of 10–600
  characters. Server-side validation is the real check; the panel only mirrors it.
- **The last email always says it's the last.** The onboarding copy promises this. The worker adds
  that instruction itself to whichever enabled step comes last, so a user who deletes the sign-off
  step can't break the promise.
- **Single writer:** add `saveSequenceSteps()` to `src/utils/outreach-sequences.ts`. It provisions
  the default first if the assistant has no plan, and is the only code that writes `sequence_steps`.
  Expose it as two actions on `lead-threads.ts`: `get_follow_up_plan` (built on `previewFollowUps`)
  and `save_follow_up_plan`.
- **Chat parity** (memory `assistant-gui-chat-parity`):
  - The chat **sees** the plan in its settings block.
  - It can **propose** changes with a `follow_up_plan_proposal` card that the server rebuilds from
    the stored plan plus the requested change.
  - The click saves the change through the same action.
  - The chat never saves on its own.
- **Remove hardcoded "3 days, a week, then a sign-off" copy.** It appears in the Outreach subtitle
  (registry ~L855), the onboarding option description and the help articles. Each should read the
  plan or describe it generally. The send-confirm card already reads it live (`previewFollowUps`).
- **No DDL needed.** Every column it uses already exists on both databases.

**Optional later step: "Preview with a lead".** It would draft what follow-up N would say to a
chosen lead, without sending it. That costs a model call, so it would be charged the same way as
blog resize. Leave it out of v1.

## Phases

| # | Ships | Changes what users see? |
|---|---|---|
| 1 | `leadOutreachPhase` + generated client constant + `board` action + tests | No |
| 2 | Outreach stage strip; Conversations folded in with alias deep links; chat prompt + help SQL; Results moves next to Outreach | Yes |
| 3 | Follow-up plan panel + `saveSequenceSteps` + chat card + copy de-hardcoding | Yes |
| 4 | (optional) Preview with a lead | Yes |

Phases 1→2 run in order. Phase 3 only touches the follow-up plan and the sequence code, so it can be
built alongside Phase 2.

## Things known to break

- `tests/lead-prompt-surfaces.test.ts` fails until `leadGeneratorSurfaces()` names every registry
  surface.
- `tests/lead-outreach-lifecycle.test.ts` reads `label:` / `columnLabels` by character offset from
  `reviewQueue: {`. Update that test along with the registry block.
- `tests/lead-threads.test.ts` checks the single-writer rule and that `reply_token` is never
  selected. The new `board` and plan actions must satisfy both.
- Also check: `tests/lead-panel-actions.test.ts` and `tests/blog-batch-and-bubbles.test.ts`, which
  both mention Conversations or "Awaiting reply".
- `_RQ_COLUMN_LABELS` reset loop: the shared columns must still reset correctly when switching from
  a lead assistant to a social one, now that the lead role no longer uses them.
- Phone width: the stage strip has to scroll inside itself, never the page (memory
  `ui-harness-workspace-phone`).
- Verify in a component harness that runs the shipped source, as with the earlier outreach
  harnesses in `.claude/launch.json`.

## Small fix found while planning

`set_outcome` stops the chasers through `haltEnrolmentsForRecord`. Check which halt reason that
writes. If it's `record_closed`, the thread banner will say "The lead was rejected or deleted" on a
**won** deal. Fixing that needs either a new `outcome_recorded` reason (DDL: drop and re-add the
CHECK constraint, with a guard so it can be re-run safely; see memory
`migration-drop-then-add-constraint-trap`) or a different banner when `dealOutcome` is set. The
banner change needs no DDL.

## Why not Email Flows

Email Flows are built for the opposite job:

- **Consent:** they re-check subscription before every send (`checkAudienceConsentBulk`), which
  blocks every cold prospect.
- **Stopping:** they stop on unsubscribe or bounce, not when the person replies.
- **Content:** they send one template to everyone, where follow-ups are drafted per conversation.
- **Sending route:** they can send through Resend, where cold email must come from the user's own
  mailbox.

The two meet at **Won**: the customer joins the Audience, and Email Marketing's flows take over
from there.
