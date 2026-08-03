# Phase 5 — The Strategy Agent (design)

Detailed build plan for `docs/lead-generator-revenue-engine-plan.md` §7. Mockup:
`docs/mockups/strategy-agent-mockup.html`.

The epic specifies the loop, the `strategy_proposals` schema, the reject vocabulary and the change
envelope. All of that stands. This document exists because building against §7 as written surfaces
three things it does not account for — one of which makes the agent unbuildable today, and one of
which is **time-sensitive**: the data it needs can only be captured at write time and cannot be
reconstructed later.

---

## 0. What is actually on the ground

Verified by grep against the working tree, 2026-08-03. This is the part worth reading before
estimating anything.

| §7 dependency | Reality |
|---|---|
| `revenue_events` ledger | ✅ live on staging + prod, 274 rows on staging |
| `icpSnapshot` (attribution) | ✅ populated at discovery + scoring emits |
| `blueprintVersion` (attribution) | ✅ **BUILT 2026-08-03** — populated at all 12 emit sites (§0.2) |
| Terminal outcomes (`deal_won`/`deal_lost`/`deal_disqualified`) | ✅ **BUILT 2026-08-03** — Phase 4.5 manual capture (§2) |
| `template_feedback` (§2.6 ⭐ evidence) | ✅ **BUILT 2026-08-03** — writer + closed `edit_reason` vocabulary (§3.3) |
| `deal_guardrails` (the §7.3 "never touch" list) | ❌ does not exist — Phase 4 unbuilt |
| `strategy_proposals` | ❌ not built (expected — this is the phase) |
| Upstream supply | 135 leads discovered, **1** ever decided, **0** outreach sent, **0** sequence enrolments |

> **Status, 2026-08-03.** The two blocking findings below are now **fixed** — §0.2 (attribution) and
> §2 (outcome capture) are built, tested and code-complete, with **no DDL on either environment**.
> The sections are kept as written because they are the *reasoning* for what was built; §8 records
> what is done and what remains. Phase 5 is no longer blocked on an unbuilt, externally-gated
> Phase 4 — it is blocked only on humans marking enough deals for `MIN_SAMPLE` to be met.

### 0.1 The blocking finding

**The Strategy Agent's core aggregate has no input and no way to acquire one.**

§7.1's loop is `aggregate revenue_events → per-segment win rate → propose`. Win rate is computed
over rows where `outcome IS NOT NULL`, which is exactly the three terminal events. Nothing in the
codebase emits a terminal event. Not "there are none yet" — there is no code path that could ever
produce one.

§9 lists Phase 5 as blocked by "Phases 0 + 4". Phase 4 (Closing Agent) is the only planned producer
of terminal outcomes, is estimated at ~3 weeks, and is itself blocked on **Stripe Connect and legal
review** — both outside this codebase. Even once it ships, `MIN_SAMPLE` (20 per segment) means the
agent stays silent until ~20 deals have *closed*. On current throughput — one lead ever decided —
that is not a near-term date.

So: building §7 exactly as written produces a weekly cron that correctly, permanently, does nothing.

**Recommendation: insert Phase 4.5 — manual outcome capture — and build it first.** A human marks a
record Won / Lost / Disqualified with a loss reason from the existing closed vocabulary. It is a
status control and one `recordEvent` call. No Stripe, no legal review, no LLM. It is the only thing
that converts the ledger from a funnel counter into a learning substrate, and it is worth building
even if Phase 5 is never started, because "why are we losing?" is answerable from it directly.

Scoped in §2 below.

### 0.2 The time-sensitive finding

`blueprintVersion` is never set. §7.2 calls it *"the attribution join key. Without these you can
measure that win rate moved but not which strategy version moved it, and the loop degenerates into
correlating noise."*

The fix is one field per `recordEvent` call site. The reason it is urgent rather than routine:
**attribution can only be captured at write time.** A `deal_won` row written today with a NULL
blueprint version is permanently unattributable — there is no later query that can recover which
blueprint was live when that outreach went out. Every event written between now and the fix is
sample the Strategy Agent must discard.

It costs ~an hour and it should land **before** outcome capture starts producing rows, not as part
of Phase 5.

### 0.3 The evidence source that already works

`template_feedback` is §2.6's ⭐ mechanism: a human edits a drafted message, picks a reason, the edit
ships for that prospect and the *reason* is banked. After N similar edits the Strategy Agent
proposes the template change with a real sample behind it.

That path **needs no closed deals at all** — its sample unit is a human edit at the review gate, not
a won deal. It is reachable far sooner than win/loss analysis. The table exists and has no writers,
so the §2.6 review actions were specified but never wired.

⚠️ `edit_reason` is `text` with no CHECK constraint. It is the GROUP BY key for the entire proposer —
free text is unclusterable for exactly the reason `LOSS_REASONS` is closed. The table has zero rows,
so constraining it now is free; after it has rows it is a migration with a cleanup step.

---

## 1. The shape this suggests: split Phase 5 in two

The expensive half of Phase 5 is not the analyser. It is the proposal store, the review surface, the
apply path, the rollback, the blueprint recompile and the audit trail. That half is **source-agnostic** —
it does not care whether a proposal came from win/loss segments or from clustered human edits.

So:

| | **Phase 5a — proposal infrastructure + edit-pattern proposer** | **Phase 5b — the win/loss analyser** |
|---|---|---|
| Builds | `strategy_proposals`, review UI, apply, rollback, recompile, audit, expiry | one more proposer function |
| Evidence | `template_feedback` clusters (human edits) | `revenue_events` terminal outcomes |
| Blocked by | §2.6 review actions being wired (Phase 2 surface, exists) | **Phase 4.5** + ~20 closed deals |
| Est. | ~1.5 wks | ~3–4 days |

5b is cheap *because* 5a exists. This is not phase-splitting for its own sake: it moves the
externally-blocked dependency off the critical path for 90% of the work, and the review screen —
the thing a user actually sees — ships on evidence that is reachable this quarter.

**This requires one addition to §7's schema: a `source` column.** §7's `strategy_proposals` assumes a
single producer. With two, `MIN_SAMPLE` means different things (20 terminal outcomes vs. N edits),
the evidence blob has a different shape, and the UI must label which is which — a user should never
be shown "34 outcomes" when the number is edits.

---

## 2. Phase 4.5 — outcome capture ✅ BUILT 2026-08-03

Not part of Phase 5; listed here because Phase 5b is undeliverable without it.

**Shipped:** `set_outcome` in `netlify/functions/lead-generation.ts`, a "Record outcome" control in
the Data Hub's expanded lead row (`src/components/assistant-data-hub.js`),
`haltEnrolmentsForRecord()` in `src/utils/outreach-sequences.ts`, the outcome vocabulary + labels in
`src/config/revenue-events.ts` mirrored to the browser via `scripts/gen-client-constants.ts`
(`window.RevenueConstants`), and `tests/lead-outcomes.test.ts` (16 checks).
**No DDL** — `revenue_events` already accepts the three terminal types, and its `outcome` /
`loss_reason` CHECKs already permit every value written. There is no `event_type` CHECK.

Decisions worth knowing, beyond the scope below:

- **A loss reason is required on `disqualified` too**, not just `lost`. "We ruled them out" is only
  useful to the analyser if it says why, and `not_icp` vs `wrong_contact` is exactly the targeting
  signal Phase 5 pivots on. It is refused on `won` — `recordEvent()` stores `lossReason` on *any*
  terminal event, so a won deal carrying one would be counted by every loss aggregate.
- **A deal value is accepted on `won` only.** Allowing it on a loss would quietly merge revenue
  earned with revenue missed into one "mean deal value".
- ⚠️ **Correcting an outcome appends a second terminal row** — the ledger is append-only. Two things
  keep that safe: the action returns **409** unless the caller passes `confirmChange: true`, so a
  mis-click cannot produce a lead that is both won and lost; and the corrective row carries
  `payload.supersedes` + `payload.isCorrection`. **Every reader must take the LATEST terminal event
  per `assistant_record_id`.** A naive `count(*) WHERE outcome='won'` double-counts corrections.
- **Recording an outcome halts any running cadence** (`haltEnrolmentsForRecord`). Nothing else in
  the pipeline learns this — the sequence worker's guards key off thread state and approval status,
  and a won deal changes neither, so a signed customer would keep receiving "just following up!".
  This is the first caller of `halt_reason = 'manual'`, which has been in the vocabulary and the
  CHECK constraint since Phase 2b with no caller.
- **`cycleDays` is NULL when nothing was ever sent**, rather than measured from record creation —
  that would report how long a lead sat in a list, not how long a deal took. First touch is the
  earliest `outreach_sent` ledger row, falling back to `data.outreachSentAt` for leads contacted
  before the ledger existed.

Per §3.2, deal outcome is a **separate axis** from `approval_status` — do not overload that column,
five other assistant roles read it. Outcome lives on the mirrored record's `data` and is
denormalised into `revenue_events`.

- A Won / Lost / Disqualified control on the lead record in the Data Hub and the Conversations tab.
- Lost requires a `LOSS_REASONS` value. Won takes optional `valueGbp`.
- `cycleDays` computed with the existing `cycleDaysBetween()` from first touch (`lead_threads
  .first_outbound_at`, else the earliest `outreach_sent` event) to now. Do not guess it — leave NULL
  if there was no first touch, exactly as the Phase 0 backfill does.
- One `recordEvent(db, 'deal_won'|'deal_lost'|'deal_disqualified', …)` with `actor: 'user'`,
  `actorUserId`, `icpSnapshot`, and — once §0.2 lands — `blueprintVersion`.
- No new table. No DDL beyond nothing at all: `revenue_events` already accepts these three types and
  the CHECK constraint already permits the outcomes.

**Exit criteria:** marking a lead Lost with reason `price` produces exactly one `revenue_events` row
with `outcome='lost'`, `loss_reason='price'`, non-NULL `icp_snapshot` and non-NULL
`blueprint_version`. Verify with the parity query in [[revenue-engine-phase0]] — note the trap
recorded there: the invariant query returns 0 on an empty table too, so count rows, don't just check
the constraint.

---

## 3. Schema

### 3.1 `strategy_proposals`

§7's definition, plus four changes. `db/strategy-proposals.sql` — **manual apply**, see
`docs/db-migrations.md`; mirror into `db/schema.ts` including the `check()`s or a later
`drizzle-kit push` reverts them.

```ts
export const strategyProposals = pgTable("strategy_proposals", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),

  // ── ADDED vs §7 ──────────────────────────────────────────────────────────
  // Which proposer produced this. MIN_SAMPLE, the evidence blob shape and the UI's
  // sample-size wording all differ per source; without this the screen cannot honestly
  // label what "34" counts.
  source: text("source").notNull(),                 // 'win_loss' | 'edit_pattern'

  targetField: text("target_field").notNull(),      // must be on the §7.3 allow-list
  previousValue: jsonb("previous_value"),           // makes Apply reversible
  proposedValue: jsonb("proposed_value").notNull(),
  evidence: jsonb("evidence").notNull(),            // { sampleSize, segments[], metrics{}, eventIds[] }
  status: text("status").notNull().default("pending"),

  rejectReason: text("reject_reason"),              // CLOSED vocabulary — an input, not a record
  rejectNote: text("reject_note"),                  // free text, for humans not the model
  decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),

  // ── ADDED vs §7 ──────────────────────────────────────────────────────────
  // Set on apply. Rollback restores previousValue and stamps rolledBackAt; the row stays
  // 'applied' so history shows it happened. A separate status would make "was this ever
  // applied?" a two-value question.
  appliedAt: timestamp("applied_at"),
  rolledBackAt: timestamp("rolled_back_at"),

  expiresAt: timestamp("expires_at").notNull(),     // never auto-applies; lapses instead
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("strategy_proposals_org_status_idx").on(t.organisationId, t.status, t.createdAt),
  // ── ADDED vs §7 — see §3.2. Without this a weekly cron stacks proposals for one field.
  uniqueIndex("strategy_proposals_pending_field_uidx")
    .on(t.organisationId, t.targetField)
    .where(sql`status = 'pending'`),
  check("strategy_proposals_status_check", sql`${t.status} IN ('pending','applied','rejected','expired')`),
  check("strategy_proposals_source_check", sql`${t.source} IN ('win_loss','edit_pattern')`),
]);
```

### 3.2 Why the partial unique index is load-bearing

§7 says "one change per run". It does not say one *pending* proposal per field, and the run is
weekly. Nothing in §7.1 checks for an existing pending proposal before persisting a new one.

Left alone, a field the agent is confident about accumulates a pending proposal every week. After a
month the user has four pending proposals for `targetPersona`, each computed against a different
window, each with a `previousValue` snapshotted at a different time. Applying them in any order
gives a different final state, and applying the oldest last silently reverts the other three —
because its `previousValue`/`proposedValue` pair was computed against a world that no longer exists.

The partial unique index makes that unrepresentable. The proposer must catch the conflict and skip
rather than error — a run that dies on a duplicate stops proposing for every *other* org in the
batch.

### 3.3 `template_feedback` — close the vocabulary ✅ BUILT 2026-08-03

**Shipped as its own migration, ahead of 5a:** `db/template-feedback-vocab.sql` (manual apply, with a
pre-flight guard that refuses to run if any row already violates the list), `src/config/template-feedback.ts`
(`EDIT_REASONS`, labels, `EDIT_REASONS_FED_TO_MODEL`, `MIN_EDIT_SAMPLE`),
`src/utils/template-feedback.ts` (the single writer, never-throws), `record_edit_feedback` in
`lead-generation.ts`, the reason strip in the Review Queue card, and `tests/template-feedback.test.ts`
(18 checks, incl. the three-way TS/schema/SQL sync).

⚠️ **Apply the SQL before deploying the code.** The writer validates against the same vocabulary, so
a code-first deploy cannot write a rejected value — but it leaves a window where the guarantee rests
on the application alone.

Two things this surfaced that the plan had not accounted for:

- **The agent's original draft was being destroyed on edit.** `saveEmail` overwrote `outreachDraft`
  in place, and `send_outreach` then recorded `generatedBody = bodyText` — the *human's* text,
  labelled as the agent's. §2.6 had no before/after to read and `lead_messages.generated_body` was
  quietly wrong for every edited message. Fixed: the first edit stashes `data.draftOriginal`, and the
  send path prefers it.
- **`diff_summary` is computed, not LLM-summarised** (the plan said LLM). The clustering key is
  `edit_reason` — already closed — so this field is context for a human reading the evidence. An LLM
  call per draft edit would spend task budget paraphrasing a diff we can measure exactly, and would
  fail on precisely the runs where the budget is already exhausted. It reports retention against the
  original ("kept 12% of the wording"), which is what separates a rewrite from a trim.

The original DDL sketch below is kept for reference; the shipped file adds the guard.

`db/strategy-proposals.sql` also adds the missing CHECK, since the table has no rows:

```sql
ALTER TABLE template_feedback ADD CONSTRAINT template_feedback_edit_reason_check
  CHECK (edit_reason IS NULL OR edit_reason IN (
    'too_formal','too_casual','wrong_value_prop','wrong_pain_point',
    'too_long','factually_wrong','bad_subject','personalisation_missing','other'));
```

`EDIT_REASONS` lives in `src/config/strategy-proposals.ts` alongside `REJECT_REASONS`, and
`tests/strategy-proposals.test.ts` parses config + SQL + `schema.ts` and asserts all three agree —
the same three-way sync test `tests/revenue-ledger.test.ts` already does, for the same reason
(a value added in one place only becomes a constraint violation inside a module that swallows
errors, i.e. invisible).

---

## 4. The proposers

Two functions, one shared persist path (`src/utils/strategy-proposals.ts` — the single writer, same
discipline as `recordEvent` and `lead-threads.ts`).

### 4.1 `edit_pattern` (Phase 5a)

```
weekly cron
  → for each org with ≥ MIN_EDIT_SAMPLE (default 5) template_feedback rows
      in the trailing window, GROUP BY edit_reason
  → take the modal reason; skip if it does not clear the threshold on its own
  → skip if a pending proposal already exists for the target field (§3.2)
  → LLM: given N edits all reasoned "<reason>" and their diff_summaries,
      rewrite <playbook section>. Output {targetField, proposedValue} ONLY.
  → validate against the change envelope
  → persist status='pending', source='edit_pattern', evidence={sampleSize, editReason, feedbackIds[]}
```

Sample unit is a human edit. `applied_to_template` on the feedback rows is set when the proposal is
applied, so the same edits cannot fund a second proposal.

### 4.2 `win_loss` (Phase 5b)

§7.1 unchanged: aggregate terminal outcomes over the trailing window grouped by `icpSnapshot`
dimensions and `payload->>'contactRole'`, compute win rate / mean `cycleDays` / mean `valueGbp` /
top `lossReason` per segment, require `MIN_SAMPLE` (20) terminal outcomes per segment, else skip.

Rows with NULL `blueprintVersion` are **excluded from attribution, not counted as a version** —
§3.3 of the epic requires the analyser tolerate NULL there. Backfilled and pre-§0.2 rows are
unattributable; treating NULL as its own cohort would create a phantom "no strategy" segment that
outperforms everything because it contains all the history.

### 4.3 Shared: the run skeleton

Structurally cloned from `autonomous-goal-optimizer.ts` — `withLambda`, `isGlobalAiDisabled()` early
exit, `BATCH` cap, per-org tier re-check via `tierAllows` + `getActiveTierKeyByOrg` cached in a Map
(eligibility lapses after a downgrade), `gatewayGenerate` + `parseModelJson`.

**Clone the structure, not the ending.** `autonomous-goal-optimizer.ts:111-125` writes, then audits,
then notifies. Phase 5 stops at persist. The blast radius argument is in §7.1 and §2.4 and it is the
whole point of the phase: a content-tone change affects the org's own output; an ICP pivot redirects
cold outreach at real strangers.

The same run does the **expiry sweep** — it is already iterating orgs, so `UPDATE … SET
status='expired' WHERE status='pending' AND expires_at < now()` costs one statement and avoids a
second cron. Do not compute expiry on read: the review UI, the notification and the aggregate would
each need the same predicate, and one of them will forget it.

---

## 5. Safety

### 5.1 The envelope, enforced in code not in the prompt

§7.3's allow-list becomes `STRATEGY_TUNABLE_FIELDS` in `src/config/strategy-proposals.ts`, keyed
exactly like `AUTONOMOUS_TUNABLE_FIELDS`:

- **Allowed:** campaign `targetPersona`, discovery query themes, outreach playbook sections,
  objection playbook responses, lead score weightings.
- **Never:** `deal_guardrails` (floor price, concessions, non-negotiables), autonomy level,
  suppression lists, spend guardrails. *An agent must never widen its own financial or safety
  envelope.*

`targetField` is **never accepted as a free string from the model.** The optimizer's precedent is
already right here — `if (!AUTONOMOUS_TUNABLE_FIELDS[field] …) continue;` — and the same guard is
what makes the "Never" list real. A prompt instruction not to touch guardrails is a suggestion; a
key lookup against a frozen map is a rule.

Note that `deal_guardrails` **does not exist yet**. The allow-list must still name it, so that Phase
4 cannot ship a table the agent is silently permitted to write.

### 5.2 Untrusted text reaches this prompt, and unlike memory-query this function writes

`template_feedback.diff_summary` describes edits to messages, and the win/loss payload carries
objections raised by prospects. Both trace back to email written by third parties arriving through a
public webhook. Phase 3 §5.5 established the rule for this and leaned on a strong mitigation: the
memory-query handler has no writes, no sends, no tools, so a successful injection inherits nothing.

**That mitigation does not transfer.** This function writes a row. So the guarantee has to come from
the shape of what it can write:

1. The model's output is parsed to `{targetField, proposedValue}` and **nothing else** is read from
   it — no free-form fields, no evidence, no sample sizes. Evidence is computed in SQL and attached
   by the persist path, never taken from the model. A model that invents "sampleSize: 400" must not
   be able to launder it into the UI.
2. `targetField` is validated against the frozen allow-list (§5.1) — reject, don't clamp.
3. The row is **inert**. `status='pending'` changes no behaviour anywhere. The only thing that makes
   a proposal take effect is a human clicking Apply, having read the diff.
4. No sends, no tools, no writes outside `strategy_proposals` and its audit row.

A test asserts `sendGmailMessage`, `sendOutlookMessage` and any `db.update`/`db.delete` against
tables other than `strategy_proposals` do not appear in the proposer source, matching the
memory-query precedent.

### 5.3 Rollback must check before it restores

`previousValue` makes Apply reversible — but a naive rollback writes `previousValue` back
unconditionally. If the user hand-edited the field after applying, that silently destroys their
edit.

Rollback reads the current value first. If it no longer equals `proposedValue`, it does not write —
it surfaces "this field has changed since the proposal was applied" and offers the diff. Same guard
class as the `next_send_at` trap in [[revenue-engine-phase5-backlog]]: the restore is not the risky
part, the assumption about intervening state is.

### 5.4 Apply is one mechanism, shared with the human

§2.6: *"A human 'save as default' and an agent strategy pivot are the same operation. Same store,
same audit row, same `previousValue` rollback, same blueprint recompile. Do not build two
mechanisms."*

So `applyStrategyChange()` in `src/utils/strategy-proposals.ts` is the single writer, and §2.6's
"Save as the new default" action calls it with a synthetic `source='human'` proposal rather than
writing the field directly. That is the difference between honouring §2.6 and merely citing it.

*(This adds `'human'` to the `source` CHECK when §2.6's middle action is wired — noted here so the
constraint is written with it from the start rather than migrated later.)*

---

## 6. Surface

A **Strategy** tab on the Lead Generator detail page, after Conversations. `defaultMainTab` stays
`'signals'` — the Signal Inbox is still the top of the funnel and the Strategy tab will be empty for
months (§7).

| File | Change |
|---|---|
| `db/strategy-proposals.sql` | **new** — DDL + `template_feedback` CHECK (manual apply) |
| `db/schema.ts` | + `strategyProposals`, incl. `check()`s and the partial unique index |
| `src/config/strategy-proposals.ts` | **new** — `STRATEGY_TUNABLE_FIELDS`, `REJECT_REASONS`, `EDIT_REASONS`, `MIN_SAMPLE` |
| `src/utils/strategy-proposals.ts` | **new** — single writer: `proposeChange`, `applyStrategyChange`, `rejectProposal`, `rollbackProposal` |
| `netlify/functions/autonomous-strategy-agent.ts` | **new** — weekly cron; both proposers + expiry sweep |
| `netlify/functions/strategy-proposals.ts` | **new** — read + decide (apply/reject/rollback) for the UI |
| `src/components/assistant-strategy.js` | **new** — the tab; IIFE `window.AssistantStrategy` module |
| `src/components/assistant-dashboard-registry.js` | + `strategyTab: { label: 'Strategy' }` on `lead_qualifier` |
| `assistants.js` | tab button + `_activateMainTab('strategy')` branch |
| `src/utils/notification-templates-catalog.ts` | + `strategy_proposal_pending` |
| `src/utils/notification-actions.ts` | + `strategy_proposal_pending: 'action_required'` |
| `netlify.toml` | `[functions.autonomous-strategy-agent] schedule = "0 5 * * 1"` |
| `.github/workflows/staging-strategy-cron.yml` | **new** — branch deploys never fire native crons |
| `tests/strategy-proposals.test.ts` | **new** — 3-way vocabulary sync, envelope, no-write assertions |

Notes on the surface:

- Frontend is **vanilla** — an IIFE assigning `window.AssistantStrategy` with `init()`/`activate()`,
  matching `assistant-lead-threads.js`. Not a React component.
- If the tab gets a pending-count badge, it must pin `style.display` and not rely on the `hidden`
  class — `hidden` loses to `inline-flex`, which is what produced the empty amber dot on the Review
  Queue tab. Reuse the `_setDetailRqTabBadge` pattern rather than reinventing the toggle.
- Prefer already-compiled Tailwind classes; grep with `grep -F` before adding one. A `style.css`
  rebuild churns unrelated selectors.
- `emerald-*` renders neon pink (`input.css` remap). The mockup's diff view uses `green-*`.

---

## 7. The empty state is the default state

For months, every real Strategy tab will show no proposals. `MIN_SAMPLE` will not be met. That is
correct behaviour — §7.1's "no pivot on noise" is the entire safety argument — but a screen that
renders a blank card for a quarter reads as broken and gets support tickets.

So the empty state is a first-class screen, not a fallback, and it is **diagnostic**: it says which
input is missing and how far off it is.

> **Not enough evidence yet.** The Strategy Agent needs 20 closed deals per segment before it will
> propose anything. You have **0** — nothing has been marked won or lost yet.
> *Why: acting on a small sample produces oscillation, not learning.*

with per-source progress (edits banked toward the edit-pattern threshold; outcomes toward win/loss),
and the last run's timestamp and skip reason, so "is this thing even running?" is answerable without
the logs. The mockup leads with this state for that reason.

The existing sketch in `docs/mockups/revenue-engine-mockup.html#s-strategy` shows only the populated
happy path — accurate as a design intent, misleading as a build target.

---

## 8. Sequencing

| Step | Scope | Est. | Status |
|---|---|---|---|
| **0.2** | Populate `blueprintVersion` at every `recordEvent` site | ~1 hr | ✅ **done 2026-08-03** — all 12 sites |
| **4.5** | Manual outcome capture (Won/Lost/Disqualified + loss reason) | 2–3 d | ✅ **done 2026-08-03** — no DDL |
| §2.6 | Wire the review save actions → `template_feedback` writes | 2–3 d | ✅ **done 2026-08-03** — ⭐ path; see below |
| **5a** | Proposal store, review UI, apply/reject/rollback, expiry, edit-pattern proposer | ~1.5 wks | ⬜ next — evidence now accumulates |
| **5b** | Win/loss segment analyser | 3–4 d | ⬜ needs ~20 marked deals |

**§2.6 shipped two of its three save actions.** "Use this version" (class A) and "Use this version +
flag the pattern" ⭐ (class A + evidence) are live. **"Save as the new default" (class C) is
deliberately not built**, because §5.4 of this document forbids it: *"A human 'save as default' and an
agent strategy pivot are the same operation. Do not build two mechanisms."* That operation is
`applyStrategyChange()`, which lands with 5a. Wiring a direct blueprint write now would create exactly
the second mechanism, and 5a would have to remove it.

That is not a gap in the review surface. §2.6 itself calls the middle option *"a trap taken alone"* —
it generalises from n = 1 — and names ⭐ the recommended default. The strip's copy carries the
promise ("repeated edits like this become a suggested template change"), which 5a then honours.

Steps 0.2, 4.5 and §2.6 are each independently useful and none of them needs an LLM. They are what
makes the ledger answer "why are we losing?", which is the question the whole epic is built around.

**What changed by doing 0.2 and 4.5:** Phase 5b's blocker is no longer an unbuilt, externally-gated
Phase 4 (Stripe Connect, legal review). It is now just *usage* — humans marking deals until a
segment reaches `MIN_SAMPLE`. That is a materially different kind of blocker: it needs no
engineering, and progress toward it is visible in the ledger from the first click.

⚠️ **The clock on attribution has started.** Every event written from now on carries a
`blueprintVersion`; everything written before 2026-08-03 does not, and cannot be repaired. The
analyser must exclude NULLs rather than treat them as a cohort — otherwise all of history becomes a
phantom "no strategy" segment that outperforms everything, because it contains every event ever
written (§4.2).

---

## 9. Open decisions

1. **`MIN_SAMPLE` = 20 per segment** is §7's figure and it is a guess. At current throughput it may
   never be met. Options: lower it and widen the confidence interval shown in the evidence card, or
   keep it and accept that small orgs never get a win/loss proposal (the edit-pattern proposer still
   serves them). Recommend keeping 20 and leaning on 5a — a wrong pivot from n=8 is worse than no
   pivot.
2. **Expiry window.** §7 says "N days". Recommend 14 — long enough that a fortnight's holiday does
   not lose a proposal, short enough that `previousValue` is still current when it is applied.
3. **Tier gate.** `tierAllows('autonomous', …)` is the goal optimizer's gate. Reusing it means the
   Strategy Agent lights up for every org already on the autonomous tier the moment it deploys.
   Confirm that is wanted, or add a distinct feature key.
4. **Notification cadence.** One notification per proposal (§7.1) is right at one proposal a week.
   If both proposers fire for the same org in one run, that is two. Cap at one digest per run.

---

## 10. Migration notes

- `db/strategy-proposals.sql` is a **manual apply** — `scripts/db-migrate.mjs`, not `drizzle-kit
  push`; `psql` is not installed here. The runner defaults to **staging**; prod needs `--url-var`
  with a variable NAME.
- Verify the CHECK constraints by INSERTing inside a `sql.begin()` that throws to roll back — proves
  good values are accepted *and* bogus ones rejected, leaving no test rows.
- Apply the SQL **before** the code deploys. A pending proposal written against a missing constraint
  is the failure mode from the reject→regeneration build.
- Prod deploys from `main`, dev runs on `staging` — diff `staging..main` before promoting.
