# Lead Generator → Autonomous Revenue Engine (design)

Target architecture for evolving the shipped **Lead Generator** (`roleKey: lead_qualifier`) from
workflow automation into an outcome-owning revenue engine: signal capture → discovery → sequenced
engagement → autonomous close → strategy pivot.

Companion to `docs/lead-generator-discovery-plan.md` (the discovery layer, already built and live on
staging). That doc describes the *acquisition* half. This one describes everything downstream of a
qualified lead, plus the feedback loop that makes the system self-optimising.

**Prime directive: Be More Swan is the system of record. External CRMs are a sync target, never a
dependency.** Every phase below must work end-to-end with no HubSpot/Salesforce connection present.

---

## 0. Correcting the brief

The originating brief describes a current state that is optimistic in two places and pessimistic in
one. The plan is shaped by the corrections, so they are recorded here.

| Brief claims | Reality in code |
|---|---|
| "Social Media Assistant captures comments, DMs, mentions and identifies intent signals" | **Not built.** `social-auto-responder.ts` only *generates* Meta auto-reply copy into `configuration.autoResponderDraft`. No ingestion of comments/DMs/mentions exists anywhere. `ingest-facebook-insights.ts` / `ingest-instagram-insights.ts` are metrics only. |
| "Lead Gen takes the raw handoff from the Social agent" | **Not built.** `fireOrchestrations` fires only on `drafts_a_post \| publishes_a_post \| completes_a_task`, and every handoff enqueues a `content_generation_job` — it structurally cannot carry a lead. |
| "orchestrating automated follow-ups" | **Not built.** A chase *reminder* lands on the Calendar at +3 business days (`chaseDate()` in `lead-generation.ts:42`). No sequence engine, and **no inbound reply detection at all**. |
| "syncs the data to a traditional CRM" | Partial. `sync-action.ts` has `hubspot_update_record` + `salesforce_update_record`, but they are one-shot, chat-card-driven pushes for `crm_enricher` — not a lead-gen sync, not scheduled, not bidirectional. |
| "This is good workflow automation" (implying little foundation) | **Understated.** `ai_blueprints` is already a versioned, hashed, sectioned playbook store. `autonomous-goal-optimizer.ts` is already a working autonomy loop (off_track goal → LLM rewrites an allow-listed brief field → audit → notify → tier gate). pgvector + Voyage embeddings are already in production use (`kb_chunks`, `inspo_chunks`). |

**The one true blocker:** a lead's terminal state today is `approved` / `rejected` / `scheduled`.
Nothing records **won**, **lost**, or **why**. Deliverable 3 (autonomous ICP pivoting) is
unbuildable without outcome labels — which is why Phase 0 exists and everything else waits on it.

### Conflicts to resolve deliberately, not silently

1. **"Zero-touch close" vs. `approval_status`.** Human-in-the-loop is *structural* — every AI record
   enters `pending_approval` and the Review Queue is shared UI across all assistant roles. Zero-touch
   is not a feature flag; it needs an explicit **autonomy level** (§6.2) or you fork the record
   lifecycle for one role and break the shared template.
2. **"Anti-CRM" vs. the four-tab template.** Everything renders through
   Overview / Data Hub / Review Queue / Calendar. **Decision: build the memory layer as the new
   source of truth and keep the tables as a projection over it.** Same disruptive capability,
   zero regression, and the conversational surface ships as an *addition* (§5.5).
3. **Autonomous negotiation + payment collection is regulated.** An AI agreeing commercial terms and
   taking payment needs the guardrail table (§6.1) designed in from day one, plus an immutable
   decision log. Not a blocker; must not be retrofitted.
4. **Runtime ceiling.** Netlify functions have ~10s (sync) / 26s (background) wall clock. Every new
   stage is a **cursor-resumable queue** modelled on `discovery_jobs`. No long-running agent loops,
   ever. See `process-discovery-jobs.ts` for the canonical drain.

---

## 1. Guiding decisions (why this shape)

1. **Extend the existing autonomy loop, don't write a new Strategy Agent.**
   `autonomous-goal-optimizer.ts` already has the exact skeleton required: daily cron, batch, tier
   re-check per run, field allow-list, single change per run for auditability, audit log row,
   notification. Phase 5 changes its *input* (win/loss instead of goal status) and its *output target*
   (campaign ICP + blueprint playbook sections instead of brand-voice fields). Reusing it inherits
   the guardrails for free.

2. **`revenue_events` is append-only and is the keystone.** Every other phase writes to it; the
   Strategy Agent reads only from it. Append-only means the strategy loop can be re-run over history
   after a prompt change without corrupting state — essential for evaluating a pivot before shipping
   it.

3. **Account graph lives in Postgres, not Neo4j.** An `account_edges` table with a recursive CTE
   covers the traversal depth this product needs (account → contacts → threads → events, 3-4 hops).
   Adding a second datastore doubles the ops burden, the GDPR erasure surface, and the staging
   provisioning cost — for a graph that will hold thousands of nodes, not billions. Revisit only if a
   query genuinely needs unbounded-depth traversal.

4. **Reuse pgvector, don't add a vector vendor.** `kb_chunks` / `inspo_chunks` already run
   `vector(1024)` + HNSW cosine against Voyage `voyage-3.5-lite` (`src/utils/kb-embeddings.ts`).
   Account memory uses the identical model and dimensions so one embed path serves everything.
   **Mandatory:** every chunk written must insert a `vector_embeddings` row first (`schema.ts:2126`) —
   that table is the GDPR erasure map and the erasure paths already query it.

5. **The Closing Agent never invents a price.** It selects from a guardrail-bounded set. An LLM
   generating a discount percentage free-hand is an unbounded financial liability; an LLM choosing
   between pre-approved concessions is a classifier. This is the same inversion that fixed lead
   fabrication in discovery (LLM emits *queries*, not companies).

6. **No feature may require two assistants to be useful.** Assistants are hired individually and
   priced individually, so any capability that only works when a *second* assistant is also active is
   a capability most orgs will never see. Cross-assistant orchestration is therefore always an
   **enhancement of a standalone feature, never its precondition**. Applied here: the Signal Inbox
   works fully on saved searches with only the Lead Generator hired (§4.1a); the social feed adds a
   second source to a surface that already works. The same test applies to every later phase.

7. **Promote, don't replace.** Exactly as discovery does today: new tables own the typed pipeline,
   and rows are *mirrored* into `assistant_records` so the shared Data Hub / Review Queue / Calendar
   UI renders them with no rebuild. Adding a `deal` record type is cheaper than a parallel UI.

8. **Gate on consequence, not on step.** The approval gate is currently placed uniformly at every
   step, which makes it simultaneously too heavy where actions are reversible and absent where they
   are not. Approval fatigue is a safety problem, not just a UX one — habituation trained on fifty
   low-stakes prompts fires on the one that mattered. **§2 sets this out in full and governs every
   phase below.**

---

## 2. Human-in-the-loop placement (governing rule)

**Read this before any phase.** It determines where every approval gate in the system goes, and
several phases below are shaped by it rather than the other way round.

### 2.1 Where the gate sits today

| Moment | Mechanism | Character |
|---|---|---|
| An assistant produces any record | `approval_status='pending_approval'` → Review Queue | Uniform, per-item |
| Sending to a scraped personal inbox | `send_outreach` refuses without `confirmPersonal` (`lead-generation.ts:282`) | Conditional, consequence-triggered |
| A discovery run | `discovery_guardrails.requireHumanApproval` (default true) | Per-campaign policy |
| A brief rewrite | **none** — `autonomous-goal-optimizer.ts:110-125` writes the change, *then* audits, *then* notifies | Apply-then-tell |

### 2.2 The failure this creates

The gate is placed **by step, uniformly**, but consequence is distributed **very unevenly**. That
produces the worst of both outcomes simultaneously.

**Too heavy where it doesn't matter.** `maxLeadsPerRun` defaults to 50. A user clicking Approve fifty
times is not exercising judgment — they are clearing a queue. Each item is individually reversible
and low-stakes (one cold email). This is precisely the volume at which habituation sets in, and
habituation does not stay local: it trains the reflex that then fires on the approval that *did*
matter. **Approval fatigue does not merely waste attention, it actively degrades the gates you care
about.**

**Too light where it matters most.** Nothing gates a strategy pivot. One ICP rewrite silently changes
every subsequent search, every outreach, and every objection response — thousands of downstream
actions authorised by a single unreviewed decision.

### 2.3 The rule

> **Gate on consequence and reversibility, not on step.**

Every AI action falls into one of three classes, and conflating them is the design error:

| Class | Examples | Gate design |
|---|---|---|
| **A · Reversible, high-volume** | signal → lead promotion, sequence steps | **Batch + sample.** Auto-approve above a confidence threshold; gate anomalies only. Never one prompt per item. |
| **B · Irreversible, outward-facing** | first send to a stranger, concession, payment link, contract terms | **Hard gate, per instance, always.** You cannot unsend an email or un-form a contract. Not removable by autonomy level without explicit informed opt-in. |
| **C · Policy-setting, low-volume, high-leverage** | ICP pivot, playbook rewrite, guardrail change, autonomy level | **Hard gate with evidence and rollback.** One decision governs thousands of downstream actions. |

The best-designed gate already in the codebase works exactly this way: the personal-inbox check fires
*only* when the address is both scraped **and** belongs to a named individual, and it is enforced
server-side so it holds for any caller. It does not ask fifty times; it asks once, when it matters.
That is the pattern to generalise.

### 2.4 The single crucial moment

**Switching on autonomy** — `deal_guardrails.autonomy_level = 'autonomous'`. It is the one human
action that removes every other gate in the system. Everything else is a decision *within* the
system; this is the decision *about* the system.

It must not ship as a dropdown with a tier check. Required ceremony:

1. floor price, non-negotiables and allowed concessions all populated and explicitly confirmed
2. a **dry-run report** showing what the agent *would* have sent across the last N closed deals
3. a scope limit — value ceiling, or a named subset of campaigns
4. a review date, surfaced as a notification when it arrives
5. an audit row capturing who enabled it, when, and against which guardrail snapshot

The runner-up, and the one that will be hit far sooner: **applying a strategy pivot** (§7.1). If it
inherits the goal optimizer's apply-then-notify precedent it ships fully autonomous by default. For a
content-tone change that is defensible. For an ICP rewrite that redirects cold outreach at real
strangers it is not — the blast radius is external and the error mode is systematic rather than
one-off.

### 2.5 Gate placement per phase

| Moment | Class | Gate |
|---|---|---|
| Signal → lead promotion | A | Batch approve; auto-approve above confidence threshold; gate anomalies |
| Lead → **first** outbound touch per account | B | Hard gate (keeps today's behaviour) |
| Subsequent sequence steps | A | **No gate** — the human already approved this relationship |
| Reply → objection response | A | No gate within guardrails |
| Any concession | B | Hard gate until explicit opt-out with guardrails populated |
| Payment link issuance | B | Hard gate, always |
| Strategy pivot applied | C | Hard gate with evidence + rollback — **never** apply-then-notify |
| Autonomy level change | C | Ceremony (§2.4) |
| Guardrail / suppression / spend change | C | Human-only — the agent may never write these (§7.3) |

**Net effect: fewer total interruptions than today**, concentrated where a human decision actually
changes the outcome. If a phase adds a gate not in this table, it needs a justification in the phase
section — the default is no new gate.

### 2.6 Editing at review time — the three scopes

A gate that only offers Approve / Reject wastes the most valuable thing about a human review: the
human usually knows *what would make it right*. When they open a drafted message they have one of two
quite different intentions, and collapsing them is a design error in exactly the way §2.3 describes.

> **"This wording is wrong for this prospect"** → one-off, reversible → **class A**
> **"This wording is wrong for everyone"** → governs every future message → **class C**

So the review surface offers three save actions, not one:

| Action | Scope | Class | Writes to |
|---|---|---|---|
| **Use this version** | This message only | A | the `lead_messages` row; template untouched |
| **Save as the new default** | Every future prospect | **C** | outreach playbook section → `ai_blueprints` recompile |
| **Use this version + flag the pattern** ⭐ | This message now; evidence for later | A (+ signal) | message row **and** a `template_feedback` row |

**⭐ is the recommended default.** Here is why the middle option is a trap taken alone: "save as
default" generalises from **n = 1**. The Strategy Agent is forbidden from pivoting without
`MIN_SAMPLE` terminal outcomes (§7.1) precisely because one data point is noise — yet a human clicking
"save for all" after one edit does exactly that, with no evidence gate at all. That is the user's call
to make and must not be blocked; but it should be **labelled honestly as a policy change, audited, and
reversible**, not presented as an innocuous checkbox.

The third option resolves the tension. The edit ships immediately for this prospect, and the *reason
for the edit* is captured as evidence. After N similar edits the Strategy Agent proposes the template
change through the normal §7.1 proposal flow — with a sample size behind it. Human edits become
training signal instead of being thrown away.

**A human "save as default" and an agent strategy pivot are the same operation.** Same store, same
audit row, same `previousValue` rollback, same blueprint recompile — one is human-initiated, the other
agent-proposed. Do not build two mechanisms.

**Which messages get reviewed.** Per §2.5, the **first outbound touch per account** is gated, so a
human always sees the opening message before it reaches a stranger. Sequence steps 2+ are ungated at
*instance* level — but their templates are reviewed once at enrolment. The principle: **review the
policy once, not each execution of it.**

> ⚠️ **Scope note — DMs.** Reviewing outbound *email* is specified above and rests on the existing
> `send_outreach` path. Sending a **DM to a specific prospect is not currently a capability** anywhere
> in the codebase: `social-auto-responder.ts` configures platform-level auto-replies, not per-prospect
> outbound messages, and no `sync-action.ts` handler sends one. Outbound DM is a new capability with
> its own platform permissions and rate limits — scope it explicitly if wanted; it is not implied by
> Phase 1b, which only *ingests* social messages.

---

## 3. Phase 0 — The outcome ledger (keystone)

**Nothing else in this document works without this. Build it first.**

### 3.1 `revenue_events` — append-only fact stream

```ts
export const revenueEvents = pgTable("revenue_events", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  // Subject of the event. One of these is set; leadId is the common case.
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "cascade" }),
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  accountId: integer("account_id"),                       // FK added in Phase 3 (account_nodes)

  eventType: text("event_type").notNull(),
  // Who caused it — critical for attributing autonomous vs. human outcomes.
  actor: text("actor").notNull().default("system"),       // 'system' | 'agent' | 'user'
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),

  // Structured outcome fields. NULL except on terminal events.
  outcome: text("outcome"),                               // 'won' | 'lost' | 'disqualified' | null
  lossReason: text("loss_reason"),                        // controlled vocabulary, see LOSS_REASONS
  valueGbp: decimal("value_gbp", { precision: 12, scale: 2 }),
  cycleDays: integer("cycle_days"),                       // first-touch → terminal, denormalised for the analyser

  // The ICP/playbook that was live when this happened. THE join key for the strategy loop:
  // it lets the analyser attribute an outcome to the strategy that produced it.
  icpSnapshot: jsonb("icp_snapshot"),
  blueprintVersion: text("blueprint_version"),            // ai_blueprints.blueprintVersion

  payload: jsonb("payload").notNull().default('{}'),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => [
  index("revenue_events_org_type_idx").on(t.organisationId, t.eventType, t.occurredAt),
  index("revenue_events_lead_idx").on(t.discoveredLeadId, t.occurredAt),
  // The strategy analyser's hot path: terminal outcomes for one org in a window.
  index("revenue_events_outcome_idx").on(t.organisationId, t.outcome, t.occurredAt)
    .where(sql`outcome IS NOT NULL`),
  check("revenue_events_actor_check", sql`${t.actor} IN ('system','agent','user')`),
  check("revenue_events_outcome_check", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('won','lost','disqualified')`),
]);
```

**`eventType` vocabulary** (`src/config/revenue-events.ts`, single source of truth, imported by every
writer — same pattern as `src/config/post-status.ts`):

```
signal_captured      lead_discovered     lead_enriched      lead_scored
lead_approved        lead_rejected       outreach_sent      outreach_bounced
reply_received       reply_classified    objection_raised   objection_handled
meeting_booked       quote_sent          negotiation_opened negotiation_conceded
payment_link_sent    deal_won            deal_lost          deal_disqualified
```

**`LOSS_REASONS`** must be a closed vocabulary — free-text loss reasons are unclusterable and the
Strategy Agent would be reduced to summarising prose:
`price` · `timing` · `no_budget` · `competitor` · `no_response` · `wrong_contact` ·
`not_icp` · `feature_gap` · `went_silent` · `other`

### 3.2 Terminal outcomes on the record lifecycle

`assistant_records.approval_status` stays exactly as-is (it is the *approval* gate). Deal outcome is a
separate axis, stored on the mirrored record's `data` and denormalised into `revenue_events`. Do not
overload `approval_status` with `won`/`lost` — five other assistant roles read that column.

### 3.3 Backfill

`db/revenue-events.sql` (manual apply — see `docs/db-migrations.md`) creates the table and backfills
from existing history so the Strategy Agent has data on day one:

- every `discovered_leads` row → `lead_discovered` at `created_at`
- `contact_email IS NOT NULL` → `lead_enriched`
- `score IS NOT NULL` → `lead_scored` with the score in `payload`
- `assistant_records.approval_status` `approved`/`rejected` → `lead_approved`/`lead_rejected`
- `data->>'outreachSentAt'` → `outreach_sent`

Backfilled rows get `actor='system'` and a NULL `blueprintVersion` — the analyser must tolerate NULL
there and treat those as unattributable (they predate strategy versioning).

### 3.4 Files

| File | Change |
|---|---|
| `db/schema.ts` | + `revenueEvents` |
| `db/revenue-events.sql` | **new** — DDL + backfill (manual apply) |
| `src/config/revenue-events.ts` | **new** — `EVENT_TYPES`, `LOSS_REASONS`, `isTerminal()` |
| `src/utils/revenue-ledger.ts` | **new** — `recordEvent()`; the single write path (mirrors `notify.ts`) |
| `netlify/functions/lead-generation.ts` | emit on `score_lead`, `send_outreach` |
| `netlify/functions/process-discovery-jobs.ts` | emit on discover / enrich / score / promote |
| `netlify/functions/assistant-records.ts` | emit on approve / reject |

**Exit criteria:** every existing lead lifecycle transition produces a `revenue_events` row, backfill
verified by count parity against `discovered_leads`, and `recordEvent()` is the *only* writer.

---

## 4. Phase 1 — The Signal Inbox

The Signal Inbox is **one surface with two independent feeds**. This is the load-bearing decision of
the phase:

| Feed | Source | Requires | Category shown |
|---|---|---|---|
| **1a · Saved searches** | `discovery_campaigns` → `discovered_leads` | Lead Generator only | `<Assistant name> Search` |
| **1b · Social signals** | `signals` (webhook ingest) | Lead Generator **+** Social Media Assistant | `Instagram · DM`, `Facebook · comment`, … |

**A user with only a Lead Generator must get a fully populated Signal Inbox.** The social feed is
additive. If 1b is absent the inbox is not empty and does not nag — it shows saved-search signals and
offers the social feed as an optional upgrade.

> **Sequencing consequence: build 1a first.** It has *no external dependency* — the discovery engine
> is already live. 1b is gated on Meta app review, which is dashboard state we do not control. Do not
> let the blocked half hold up the unblocked half.

### 4.0 What already exists (do not rebuild)

The "describe what you want your assistant to search for, saved as a search" flow **is built and live
on staging**:

- `discovery_campaigns.idea` — the free-text description ("Who to find" textarea in
  `assistant-discovery-campaigns.js`, placeholder *"Boutique hotels in Southern Europe that don't
  have a modern online booking app"*)
- cadence (`one_off | daily | weekly`) via `discovery_schedules`, dispatched by
  `dispatch-discovery-runs.ts` — no per-campaign cron
- guardrails: max leads/run, max spend/run, exclusions, human-approval toggle
- full CRUD in `discovery-campaigns.ts`: `create · list · run_now · list_leads · pause · resume ·
  archive · edit · cancel_run`

**The gap is surfacing, not capability.** Discovery output goes straight to the Leads tab / Review
Queue. Nothing presents it as an *inbound signal*, and the ~42% of candidates the domain filter drops
are invisible to the user entirely.

### 4.1a Saved searches → Signal Inbox

Two small schema changes; the engine is untouched.

```ts
// discovery_campaigns — ADD. Campaigns are currently identified only by their idea text,
// which is a paragraph. The inbox needs a short label for the per-search sub-filter.
name: text("name"),   // nullable; UI falls back to a truncated `idea` when unset
```

```ts
// discovery_jobs — ADD. Drives the "search completed → inbox updated" notification
// and stops a redelivered/resumed job notifying twice.
signalsPublishedAt: timestamp("signals_published_at"),
```

**Category label — resolve at read time, never store it.** The category is
`` `${assistant.name} Search` `` derived from `ai_assistants.name` on every read. Denormalising the
string means renaming an assistant leaves historical signals labelled with the old name — and this
codebase already has a documented role-label-vs-instance-name trap. The correct read is the existing
`coalesce(master_assistants.name, jobRole)` pattern.

**What counts as a saved-search signal.** `discovered_leads` already carries the exact lifecycle
(`discovered → qualified → promoted → discarded`), so the inbox is a *view over rows that already
exist* — including the filtered-out ones. Default filter shows `qualified` + `promoted`; a
**"Show filtered (42)"** toggle reveals what the domain filter and scorer rejected, with the reason.
That toggle is a genuine product win: it makes the funnel legible and gives the user a way to catch a
filter that is over-rejecting, which is currently only discoverable by reading the database.

### 4.2a Read model — projection, not duplication

`netlify/functions/signal-inbox.ts` returns one normalised wire shape from both feeds:

```ts
interface Signal {
  id: string;                 // 'social:412' | 'search:1188' — feed-prefixed, never a bare int
  sourceKind: 'social' | 'saved_search';
  sourceLabel: string;        // 'Instagram · DM' | 'Nadia Search'  ← resolved at read time
  savedSearchId?: number;     // discovery_campaigns.id, for the sub-filter
  title: string;              // handle / company name
  excerpt: string;            // comment text / matched snippet
  intent: 'buying' | 'question' | 'support' | 'noise' | null;   // social only
  rating: 'hot' | 'warm' | 'cold' | null;                        // saved search only
  confidence: number | null;
  handoffStatus: 'none' | 'queued' | 'promoted' | 'ignored' | 'filtered';
  occurredAt: string;
}
```

> **Deliberately NOT writing a `signals` row per discovered lead.** A dual-write would need the two
> stores kept in sync on every status change, and this codebase has repeatedly been bitten by exactly
> that shape — the Threads/YouTube dual-store bridge and the two asset tables that get confused. The
> `signals` table owns social engagements *because nothing else stores them*; saved-search signals are
> projected from `discovered_leads`, which stays their single source of truth.
>
> Cost of this choice: pagination across a union needs a composite cursor `(occurredAt, id)` rather
> than an offset. That is a contained, one-time cost in one function. Accepted.

`src/config/signal-sources.ts` is the single definition of the `Signal` shape, the `sourceKind`
vocabulary and `resolveSourceLabel()` — imported by the function and mirrored in the component, the
same way `PlatformConstants` is generated for the client. Never hand-copy the label format.

### 4.3a Completion → inbox update

When `process-discovery-jobs.ts` finishes a run (`status='completed'`), it:

1. stamps `signalsPublishedAt` (idempotency — a resumed or redelivered job must not re-notify)
2. writes `revenue_events` rows: `signal_captured` per qualified lead
3. raises one grouped notification via `notify.ts` (the single write path):
   *"Nadia's search 'Boutique hotels…' found 14 new signals"* → deep-links to the Signal Inbox
   filtered to that search

One notification per run, never per lead — a 50-lead run must not produce 50 notifications.

### 4.4a Conditional UI

The source filter renders only the feeds the org actually has. Detect the social feed with an active
`ai_assistants` row joined to `master_assistants.roleKey = 'social_media_manager'`:

- **Lead Generator only** → chips: `All · <Name> Search · Filtered`. A dismissible one-line footer
  offers social capture as an upgrade. No empty state, no nag.
- **Both active** → chips: `All · <Name> Search · Instagram · Facebook · …`, plus the intent filters.

> ⚠️ Use `SOCIAL_PLATFORMS` for the platform chips. A hardcoded list is exactly how Threads and
> YouTube got silently dropped elsewhere.

---

### 4.1b `signals` — social engagement capture *(requires the Social Media Assistant)*

Named `signals`, not `social_engagements`: the table is the inbox's own store and a later feed
(inbound email, web form, partner referral) should not need a rename. **Nothing here is built yet, so
generalising now is free** — doing it after Phase 1 ships would be a migration.

```ts
export const signals = pgTable("signals", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  // Discriminator. Only 'social' is stored here today — saved-search signals are PROJECTED from
  // discovered_leads (§4.2a) and never written as rows. The column exists so a future non-social,
  // non-projectable feed (web form, partner referral) needs no migration.
  sourceKind: text("source_kind").notNull().default("social"),
  platform: text("platform").notNull(),                   // use SOCIAL_PLATFORMS, never a literal list
  kind: text("kind").notNull(),                           // 'comment' | 'dm' | 'mention' | 'reaction'
  // Platform-native ids — the dedupe key. Webhooks redeliver; this makes ingest idempotent.
  externalId: text("external_id").notNull(),
  externalThreadId: text("external_thread_id"),
  authorHandle: text("author_handle"),
  authorExternalId: text("author_external_id"),
  content: text("content"),
  scheduledPostId: integer("scheduled_post_id").references(() => scheduledPosts.id, { onDelete: "set null" }),

  // Intent classification (Phase 1b).
  intent: text("intent"),                                 // 'buying' | 'question' | 'support' | 'noise'
  intentConfidence: integer("intent_confidence"),         // 0-100
  classifiedAt: timestamp("classified_at"),

  // Handoff state — the join to the Lead Generator.
  handoffStatus: text("handoff_status").notNull().default("none"), // none | queued | promoted | ignored
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "set null" }),

  occurredAt: timestamp("occurred_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("signals_platform_ext_uidx").on(t.platform, t.externalId),
  // The inbox's hot path is a time-ordered page for one org across feeds — the composite cursor
  // in §4.2a sorts on (occurredAt, id), so the index must match or every page becomes a sort.
  index("signals_org_occurred_idx").on(t.organisationId, t.occurredAt, t.id),
  index("signals_intent_idx").on(t.organisationId, t.intent, t.handoffStatus),
  check("signals_kind_check", sql`${t.kind} IN ('comment','dm','mention','reaction')`),
  check("signals_handoff_check", sql`${t.handoffStatus} IN ('none','queued','promoted','ignored')`),
]);
```

> ⚠️ **Do not hardcode the platform list.** Use `SOCIAL_PLATFORMS` — stale 4-platform literals are
> exactly how Threads and YouTube got silently dropped elsewhere in the codebase.

### 4.2b Ingestion

`netlify/functions/social-engagement-webhook.ts` — public endpoint, Meta-style
`hub.challenge` verification + `X-Hub-Signature-256` HMAC validation. Reuse the shape of
`process-webhook-events.ts`. Writes raw rows only; **classification never runs in the webhook**
(webhook handlers must return fast, and Meta retries on slow responses).

`netlify/functions/classify-engagement-jobs.ts` — cursor-resumable drain, cloned from
`process-discovery-jobs.ts`. Batch-classifies unclassified rows with Haiku into the four intent
buckets. Buying intent above a confidence threshold → `handoffStatus='queued'`.

> Meta permissions are a real dependency here, not a code problem — see the existing
> "Meta app Live blockers" constraints. LinkedIn cannot supply comment webhooks under the currently
> approved products, so **LinkedIn is polling-only or out of scope for Phase 1**. Ship Instagram +
> Facebook first.

### 4.3b Extending the handoff runtime

`src/utils/orchestration.ts` currently hardcodes a content-generation payload. Two changes:

```ts
// BEFORE
export type OrchestrationEvent = 'drafts_a_post' | 'publishes_a_post' | 'completes_a_task';

// AFTER
export type OrchestrationEvent =
  | 'drafts_a_post' | 'publishes_a_post' | 'completes_a_task'
  | 'identifies_intent';        // NEW — social → lead gen
```

and a **payload discriminator** so a handoff can enqueue something other than a
`content_generation_job`. Today `fireOrchestrations` unconditionally inserts into
`contentGenerationJobs`; it needs a branch on target role: `lead_qualifier` → create a
`discovered_leads` row (source `social_signal`) + mirror to `assistant_records`.

Preserve all three existing safety properties: the per-org daily cap, `UNIQUE(link_id, source_post_id)`
idempotency (extend to `source_engagement_id`), and **never throw to the caller**.

### 4.4 Files

**Phase 1a — saved searches (no external dependency, ship first)**

| File | Change |
|---|---|
| `db/schema.ts`, `db/signal-inbox-1a.sql` | + `discovery_campaigns.name`, + `discovery_jobs.signals_published_at` (manual apply) |
| `src/config/signal-sources.ts` | **new** — `Signal` shape, `sourceKind` vocabulary, `resolveSourceLabel()` |
| `netlify/functions/signal-inbox.ts` | **new** — union read + composite cursor + source counts |
| `netlify/functions/process-discovery-jobs.ts` | on completion: stamp `signalsPublishedAt`, emit `signal_captured`, one grouped notification |
| `netlify/functions/discovery-campaigns.ts` | `create`/`edit` accept `name`; `list` returns it |
| `src/components/assistant-discovery-campaigns.js` | + "Name this search" field; reframe as **Saved searches** |
| `src/components/assistant-signal-inbox.js` | **new** — inbox tab, source chips, "Show filtered" toggle |
| `assistant-detail.html`, `assistants.js` | + Signal Inbox tab, registry entry (`lead_qualifier`) |

**Phase 1b — social feed (gated on Meta app review)**

| File | Change |
|---|---|
| `db/schema.ts`, `db/signals.sql` | + `signals` (manual apply) |
| `netlify/functions/social-engagement-webhook.ts` | **new** — signed ingest |
| `netlify/functions/classify-engagement-jobs.ts` | **new** — intent classifier drain |
| `netlify/functions/signal-inbox.ts` | + social feed in the union (shape already defined in 1a) |
| `src/utils/orchestration.ts` | + `identifies_intent`, + target-role payload branch |
| `src/lib/intent-classify.ts` | **new** — prompt + normaliser |
| `netlify.toml` | + classifier cron |

**Exit criteria (1a):** an org with *only* a Lead Generator can describe a search, save it, run it, and
see the results in the Signal Inbox categorised under `<Assistant name> Search` — with no social
assistant present and no empty state.

---

## 5. Phases 2-3 — Engagement loop and the Anti-CRM memory

### 5.1 `lead_threads` / `lead_messages` — conversation state

Outreach today is fire-and-forget: `send_outreach` sends one email and sets a calendar reminder.
There is no record of the conversation and **no reply detection**, so the system cannot know it
succeeded. Threads make the exchange stateful.

```ts
export const leadThreads = pgTable("lead_threads", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("email"),    // 'email' | 'dm'
  // Per-thread reply alias: reply+<token>@parse.bemoreswan.com — routes inbound back to THIS thread.
  replyToken: text("reply_token").notNull().unique(),
  rfc822MessageId: text("rfc822_message_id"),             // for In-Reply-To / References threading
  state: text("state").notNull().default("open"),         // open | replied | stalled | closed
  lastOutboundAt: timestamp("last_outbound_at"),
  lastInboundAt: timestamp("last_inbound_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

`lead_messages` stores one row per message (`direction`, `subject`, `body`, `classification`,
`sentiment`, `objections jsonb`), plus the review-time edit fields from §2.6:

```ts
// On lead_messages — what the agent wrote vs what the human sent.
generatedBody: text("generated_body"),        // the agent's draft, kept verbatim
body: text("body").notNull(),                 // what actually went out
editedBy: integer("edited_by").references(() => users.id, { onDelete: "set null" }),
templateVersion: text("template_version"),    // ai_blueprints.blueprintVersion the draft came from
```

Keeping `generatedBody` alongside `body` is what makes the diff computable — without it you cannot
tell an edited message from an unedited one, and the whole feedback path in §2.6 has no input.

```ts
// Human edits as evidence (§2.6, option ⭐). Accumulates until the Strategy Agent has
// MIN_SAMPLE similar edits, then proposes the template change through the §7.1 flow.
export const templateFeedback = pgTable("template_feedback", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  leadMessageId: integer("lead_message_id").references(() => leadMessages.id, { onDelete: "cascade" }),
  templateVersion: text("template_version"),
  editReason: text("edit_reason"),             // closed vocabulary, mirrors REJECT_REASONS' rationale
  diffSummary: text("diff_summary"),           // LLM-summarised, one line
  appliedToTemplate: boolean("applied_to_template").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**Reply routing.** `inbound-email.ts` already terminates SendGrid Inbound Parse at
`parse.bemoreswan.com`, but writes to BMS's *own* admin `leads` table. Add a discriminator **at the
top** of that handler: a recipient matching `reply+<token>@` routes to `lead_messages`; everything
else falls through to today's behaviour unchanged. This is the cheapest possible route to inbound —
the MX, token auth, spam gate and multipart parsing all already work.

> ⚠️ Do **not** overload BMS's `leads`/`lead_replies` tables for tenant lead data. They are the
> platform's own trial/upgrade pipeline and are surfaced in Admin → Contacts.

### 5.2 `outreach_sequences` / `sequence_steps` / `sequence_enrolments`

Declarative multi-step cadence with a dispatcher, **cloned wholesale from
`discovery_schedules` + `dispatch-discovery-runs.ts`** — that pattern is proven and already carries
the "declarative cadence, no per-entity cron" property.

Non-negotiable rules, enforced in the worker:
- Any inbound reply **immediately halts** the sequence (`state='replied'`).
- Hard cap on steps per enrolment; hard cap on enrolments per org per day (cost/spam backstop,
  mirroring `HANDOFF_CAP_BY_TIER`).
- Global suppression check before every send — `suppression-sync.ts` already exists; use it.
- Every send and every halt writes a `revenue_events` row.

### 5.3 The account graph + memory (Anti-CRM)

```ts
// Nodes: the durable entities the memory is *about*.
export const accountNodes = pgTable("account_nodes", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  nodeType: text("node_type").notNull(),        // 'account' | 'contact' | 'deal'
  label: text("label").notNull(),
  domain: text("domain"),                       // normalised — the identity resolution key
  attributes: jsonb("attributes").notNull().default('{}'),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("account_nodes_org_domain_uidx").on(t.organisationId, t.domain)
    .where(sql`node_type = 'account' AND domain IS NOT NULL`),
]);

// Edges: typed, directed, traversed with a recursive CTE.
export const accountEdges = pgTable("account_edges", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  fromNodeId: integer("from_node_id").notNull().references(() => accountNodes.id, { onDelete: "cascade" }),
  toNodeId: integer("to_node_id").notNull().references(() => accountNodes.id, { onDelete: "cascade" }),
  edgeType: text("edge_type").notNull(),        // 'works_at' | 'engaged_with' | 'competitor_of' | 'referred_by'
  weight: integer("weight").notNull().default(1),
}, (t) => [
  uniqueIndex("account_edges_uidx").on(t.fromNodeId, t.toNodeId, t.edgeType),
  index("account_edges_from_idx").on(t.fromNodeId, t.edgeType),
]);

// Long-term semantic memory. Identical model + dimensions to kb_chunks so ONE embed path serves all.
export const accountMemory = pgTable("account_memory", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  accountNodeId: integer("account_node_id").references(() => accountNodes.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),    // 'message' | 'engagement' | 'note' | 'outcome'
  sourceId: integer("source_id"),
  content: text("content").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),   // voyage-3.5-lite, matches kb_chunks
  occurredAt: timestamp("occurred_at").notNull(),
});
```

**Memory tiering** — three stores, chosen by access pattern, not by fashion:

| Tier | Store | Contents | Retrieval |
|---|---|---|---|
| Short-term / working | `lead_threads` + `lead_messages` (Postgres rows) | The active conversation | Direct FK read — no embedding, no search. It's small and bounded. |
| Long-term semantic | `account_memory` + pgvector HNSW | Everything ever said about an account | Cosine kNN, `voyage-3.5-lite` `inputType:'query'` |
| Structural / relational | `account_nodes` + `account_edges` | Who relates to whom | Recursive CTE, depth-capped at 4 |
| Strategy state | `revenue_events` + `ai_blueprints` | What we believed and what happened | Aggregate SQL |

**No Redis.** Working memory here is a bounded set of rows keyed by thread id; Postgres serves it in
one indexed read. Introduce a cache only when a measured query proves it necessary.

**GDPR:** every `account_memory` insert must be preceded by a `vector_embeddings` row
(`sourceType:'account_memory'`). The erasure paths in `admin-gdpr-erase.ts` and
`account-delete-execute.ts` already read that table — skipping the insert silently orphans vectors
through a deletion request.

### 5.4 Outbound DM — scoped as **windowed reply**, not cold outreach

> **The headline finding: "outbound DM" as a peer to cold email does not exist on any platform we
> integrate.** Every major network prohibits messaging a person who has not messaged you first. What
> *is* available is a **reply inside a platform-enforced time window** that the prospect opens by
> contacting us. That is a different capability with a different shape, a hard clock, and — critically
> — a different human-gate design.
>
> ⚠️ Platform messaging terms change frequently and are the single most volatile area of these APIs.
> **Re-verify every row below against current developer docs before committing engineering time.**

#### 5.4.1 What each platform actually permits

| Platform | Outbound DM to a stranger | What *is* possible | Scope status in our code |
|---|---|---|---|
| **Facebook Messenger** | ❌ Prohibited | Reply within **24h** of the user's last message; `HUMAN_AGENT` tag extends to 7 days (needs approval) | ✅ `pages_messaging` **already granted** (`meta-oauth.ts:31`) |
| **Instagram** | ❌ Prohibited | Same 24h window; IG professional account linked to a Page | ❌ `instagram_manage_messages` **not requested** — see drift note below |
| **X** | ⚠️ Only if the recipient follows us or has open DMs | `POST /2/dm_conversations/…/messages` | ❌ `dm.write` not requested; needs a **paid API tier** |
| **LinkedIn** | ❌ No general member-messaging API | Sponsored Messaging only — an *ad product* via Campaign Manager, not a per-prospect API send | ❌ Partner-gated; our approved products are member posting only |
| **Threads** | ❌ No DM API | — (Threads has no native DM; it hands off to Instagram) | n/a |
| **TikTok** | ❌ No public DM API | — | n/a |
| **YouTube** | ❌ No DM | — | n/a |

> ✅ **Scope drift found while scoping this — FIXED.** `integrations.ts` listed `pages_messaging`
> under the `instagram` allow-list, but that is a *Facebook Page* permission and does not authorise
> Instagram DMs — those need `instagram_manage_messages`, which `meta-oauth.ts:31` never requests. The
> allow-list implied a capability the grant does not confer (same class of bug as the connector secret
> name mismatch: a declaration that looks right and a request that doesn't match it).
> `pages_messaging` is now removed from `instagram` and kept on `facebook`, where it is both granted
> and correct. The guard is a **hard 400** (`SCOPE_NOT_PERMITTED`) on the manual connection path;
> no client sends `scopes` and no test covered it, so this is purely tightening.
>
> ⚠️ **Related drift NOT fixed — needs a decision.** `meta-oauth.ts:31` requests
> `business_management`, which appears in **neither** allow-list. Adding it would *widen* a security
> guard with a powerful permission, so it is deliberately left alone: if the manual path ever needs to
> declare it, that should be an explicit call, not a silent side effect of this fix.

**Net achievable scope:** Facebook Messenger today; Instagram after a scope addition + Meta App
Review; X only with a paid tier and only to followers. **Everything else is out, and cold DM is out
everywhere.**

#### 5.4.2 The window collides with the human gate

This is the part that changes the design rather than just the integration.

§2.5 gates the **first outbound touch per account** (class B). For email that is free — a draft can
wait three days for approval and lose nothing. For a DM it is **destructive**: a signal arriving 18:00
Friday has a window that expires 18:00 Saturday. If the human approves on Monday, the reply **cannot
be sent at all** — not "sent late", but permanently impossible, and the prospect is left on read.

Per-instance review is therefore actively harmful here, and the resolution is already in the doc:

> **§2.6 — review the policy once, not each execution.**

So the DM gate inverts relative to email:

| | Email | DM (windowed) |
|---|---|---|
| Reviewed per message | ✅ first touch | ❌ would burn the window |
| Reviewed per template | at enrolment | **✅ the primary gate** — pre-approved reply set |
| On expiry risk | n/a | escalating notification at 50% / 80% of window |
| Fallback when window closes | n/a | **fall back to email** if an address is known; else mark `window_expired` |

Pre-approved DM replies are a **class C** decision (they govern every future conversation), reviewed
once and versioned in `ai_blueprints` like any other playbook. An individual send inside that approved
set is class A.

#### 5.4.3 Schema

`lead_threads.channel` already allows `'dm'` — no change. Add the window clock:

```ts
export const dmWindows = pgTable("dm_windows", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  leadThreadId: integer("lead_thread_id").notNull().references(() => leadThreads.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  // Platform-scoped conversation identity — NOT the connection id. Conflating the two is how
  // Threads silently vanished from cross-posts; keep the participant ref explicit.
  externalConversationId: text("external_conversation_id").notNull(),
  participantExternalId: text("participant_external_id").notNull(),
  // The clock. Reset on every INBOUND message; never extended by an outbound one.
  lastInboundAt: timestamp("last_inbound_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),          // lastInboundAt + platform window
  windowKind: text("window_kind").notNull().default("standard"), // 'standard' (24h) | 'human_agent' (7d)
  state: text("state").notNull().default("open"),        // open | replied | expired | closed
}, (t) => [
  uniqueIndex("dm_windows_thread_uidx").on(t.leadThreadId),
  // The dispatcher's hot path: windows about to expire that still have no reply.
  index("dm_windows_expiry_idx").on(t.state, t.expiresAt),
  check("dm_windows_state_check", sql`${t.state} IN ('open','replied','expired','closed')`),
]);
```

**`expiresAt` is computed from the platform's rule, never assumed to be 24h.** Store the window kind
so a `HUMAN_AGENT`-tagged thread gets the correct 7-day clock rather than being expired early.

#### 5.4.4 Send path

`netlify/functions/send-dm.ts`, following the `sync-action.ts` pattern exactly — `requireTenant`,
token via `getFreshAccessToken`, `integration_api_calls` audit row (endpoint paths only).

Refusal contract mirrors `send_outreach`: **every non-send returns HTTP 200 with a `reason`**, never
an error the user must act on —
`no_window` · `window_expired` · `not_connected` · `scope_missing` · `platform_unsupported` ·
`no_approved_template`.

> ⚠️ The silent-failure trap applies here too: a 200 with `reason` looks like nothing happened.
> Check `reason` before assuming a bug.

Window enforcement is **server-side and checked immediately before the API call**, not at enqueue
time — a queued reply can sit long enough for the window to close between claim and send.

#### 5.4.5 Files

| File | Change |
|---|---|
| `db/schema.ts`, `db/dm-windows.sql` | + `dmWindows` (manual apply) |
| `netlify/functions/social-engagement-webhook.ts` | open/reset a window on every inbound DM |
| `netlify/functions/send-dm.ts` | **new** — per-platform send with server-side window check |
| `netlify/functions/dispatch-dm-replies.ts` | **new** — expiry-ordered drain + escalating notifications |
| `netlify/functions/meta-oauth.ts` | + `instagram_manage_messages` (triggers **re-consent** for every connected account) |
| ~~`netlify/functions/integrations.ts`~~ | ~~fix the allow-list drift~~ — **done**, shipped ahead of this phase |
| `src/config/dm-capability.ts` | **new** — per-platform capability + window rules, single source of truth |

#### 5.4.6 Cost, blockers and non-goals

**Blockers (none are code):** Meta App Review for `instagram_manage_messages`; adding it forces
**re-consent for every already-connected Meta account** — an existing-user migration, not a deploy.
X requires a paid API tier. Both are decisions before engineering, not after.

**Explicit non-goals — do not build:**
- cold DM to anyone who hasn't messaged first (prohibited everywhere; also the fastest route to an
  app ban)
- LinkedIn DM automation (partner-gated; automating it violates their terms)
- reopening an expired window by any means
- treating DM as a sequence channel — sequences assume *we* control the cadence; a window means the
  prospect does

**Recommendation: sequence this after Phase 2, and ship Facebook-only first.** It is the one platform
where the scope is already granted, so it validates the window mechanic with **zero permission
work**. Instagram follows only if the App Review and re-consent cost is judged worth it. Given that
the achievable capability is "reply faster to people already talking to us" rather than a new
acquisition channel, it is a **retention/conversion improvement, not a growth channel** — price the
effort accordingly.

### 5.5 Conversational query surface

`netlify/functions/memory-query.ts` — natural-language question → hybrid retrieval (vector kNN over
`account_memory` + graph expansion over `account_edges` + aggregate over `revenue_events`) →
grounded answer with citations back to source rows.

Shipped as a **new panel alongside** the Data Hub table, not instead of it. Users keep the table they
know; the disruption is that both now read from the same memory layer.

---

## 6. Phase 4 — The Closing Agent

New role key **`deal_closer`** in `db/seed-catalog.ts`.

> ⚠️ Master `roleKey`s are snake_case and must match `db/seed-catalog.ts` verbatim. Adding a role
> also requires entries in `connection-map.ts`, `goal-metrics.ts`, `assistant-onboarding-schemas.js`,
> `mandate-suggestions.js`, `assistant-starter-prompts.js` and `assistant-dashboard-registry.js` —
> see the Assistant Onboarding Checklist. Skipping any one of them ships a half-wired assistant.

### 6.1 `deal_guardrails` — the negotiation envelope

```ts
export const dealGuardrails = pgTable("deal_guardrails", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  listPriceGbp: decimal("list_price_gbp", { precision: 12, scale: 2 }).notNull(),
  floorPriceGbp: decimal("floor_price_gbp", { precision: 12, scale: 2 }).notNull(),  // HARD stop
  maxDiscountPercent: integer("max_discount_percent").notNull().default(10),
  // Pre-approved concessions the agent may SELECT FROM. It never authors a new one.
  allowedConcessions: jsonb("allowed_concessions").notNull().default('[]'),
  nonNegotiables: jsonb("non_negotiables").notNull().default('[]'),
  maxNegotiationRounds: integer("max_negotiation_rounds").notNull().default(3),
  autonomyLevel: text("autonomy_level").notNull().default("approve_each"),
  escalateAboveGbp: decimal("escalate_above_gbp", { precision: 12, scale: 2 }),
}, (t) => [
  uniqueIndex("deal_guardrails_assistant_uidx").on(t.aiAssistantId),
  check("deal_guardrails_autonomy_check",
    sql`${t.autonomyLevel} IN ('suggest','approve_each','approve_exceptions','autonomous')`),
]);
```

**The floor price is enforced in code, after the model returns — never in the prompt.** A prompt
instruction is a request; a code check is a guarantee. Same principle that makes the disclosure
footer deterministic rather than LLM-appended.

### 6.2 Autonomy levels

The level governs **class A** actions only. Per §2.3, class B actions (concession, payment link) keep
their hard gate at *every* level except `autonomous`, and reaching `autonomous` requires the ceremony
in §2.4 — not merely selecting it.

| Level | Class A (replies, sequence steps) | Class B (concession, payment link) | Class C |
|---|---|---|---|
| `suggest` | Drafts, sends nothing | Hard gate | Hard gate |
| `approve_each` | Queues every reply | Hard gate | Hard gate |
| `approve_exceptions` | **Sends within guardrails**; queues at floor, past max rounds, or over `escalateAboveGbp` | Hard gate | Hard gate |
| `autonomous` | Sends | **Sends — requires §2.4 ceremony** | Hard gate, always |

Two properties this table is designed to guarantee:

1. **Class C is never delegable.** No autonomy level lets the agent change its own guardrails,
   suppression lists, spend caps or autonomy level. That column reads "hard gate" at every level on
   purpose — see §7.3.
2. **The step from `approve_exceptions` to `autonomous` is the only one that changes class B
   behaviour**, which is why it is the crucial moment (§2.4) and why it is a workflow rather than a
   dropdown.

`approve_exceptions` is the intended default for most orgs: it removes the high-volume class A
prompts (the fatigue source) while keeping every irreversible action gated.

### 6.3 Payment links

Stripe payment links on the **tenant's connected account** (Stripe Connect) — not BMS's own account,
which is what `create-plan-checkout-intent.ts` uses. This is a new Stripe integration surface, not an
extension of billing. Amount always derives from the guardrail-validated figure, never from model
output. Never bypass the floor check.

### 6.4 Objection handling

`objection_playbooks` — per-org, per-objection-category responses, seeded from onboarding's existing
`sales_objections` answer (already collected by the social assistant's schema) and thereafter
**rewritten by the Strategy Agent** based on which responses precede `deal_won`.

---

## 7. Phase 5 — Autonomous strategy pivoting

`netlify/functions/autonomous-strategy-agent.ts`, structurally cloned from
`autonomous-goal-optimizer.ts`.

### 7.1 The loop

```
weekly cron
  → for each org with autonomy enabled AND tier-eligible (re-check per run)
     → aggregate revenue_events over the trailing window, grouped by icpSnapshot dimensions
     → compute per-segment: win rate, mean cycleDays, mean valueGbp, top lossReason
     → require MIN_SAMPLE terminal outcomes per segment, else SKIP (no pivot on noise)
     → LLM proposes ONE change from the allow-list, with evidence citations
     → validate against the change envelope (§7.3)
     → PERSIST as strategy_proposals row (status='pending')  ← never applied here
     → audit_logs + ONE notification linking to the proposal
     ─────────────── the run ends. Nothing has changed. ───────────────
  human reviews the proposal (Strategy tab)
     → Apply  → write the change, stamp applied_at + prior value, recompile ai_blueprints
     → Reject → status='rejected', reason captured and fed to the next run's prompt
     → Ignore → expires after N days, never auto-applies
```

**The proposal is persisted, not applied. This is a class C gate (§2.3) and it is deliberate.**

`autonomous-goal-optimizer.ts:110-125` sets the opposite precedent — it writes, then audits, then
notifies. Do **not** clone that half. The difference is blast radius: the optimizer rewrites a brand
voice affecting the org's own content, whereas an ICP pivot redirects cold outreach at real strangers.
Systematic, external, and hard to walk back.

```ts
export const strategyProposals = pgTable("strategy_proposals", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  targetField: text("target_field").notNull(),      // must be on the §7.3 allow-list
  previousValue: jsonb("previous_value"),           // ← makes Apply reversible
  proposedValue: jsonb("proposed_value").notNull(),
  evidence: jsonb("evidence").notNull(),            // { sampleSize, segments[], metrics{}, eventIds[] }
  status: text("status").notNull().default("pending"),  // pending | applied | rejected | expired
  // Reject capture — a CLOSED vocabulary, for the same reason as LOSS_REASONS: free text
  // is unclusterable, so the next run could not learn from it.
  rejectReason: text("reject_reason"),
  rejectNote: text("reject_note"),                  // optional free text, for humans not the model
  decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  expiresAt: timestamp("expires_at").notNull(),     // never auto-applies; lapses instead
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("strategy_proposals_org_status_idx").on(t.organisationId, t.status, t.createdAt),
  check("strategy_proposals_status_check", sql`${t.status} IN ('pending','applied','rejected','expired')`),
]);
```

**`REJECT_REASONS`** (`src/config/strategy-proposals.ts`):

| Key | Meaning | Effect on the next run |
|---|---|---|
| `sample_unrepresentative` | The segment is skewed (one big client, one campaign) | Raise `MIN_SAMPLE` for that segment |
| `already_tried` | We tested this; it didn't work | Suppress this change permanently |
| `wrong_causation` | The correlation isn't causal | Feed back as a counter-example |
| `off_brand` | Conflicts with positioning | Add as a standing constraint |
| `bad_timing` | Seasonal or temporary effect | Re-propose after the window |
| `too_narrow` / `too_broad` | Right direction, wrong scope | Re-propose rescoped |
| `other` + note | — | Note shown to humans, not fed to the model |

`previousValue` makes Apply reversible — a pivot that turns out wrong must be undoable without
reconstructing what the field used to say. **Reject reasons are structured because they are an
input, not a record**: the next run's prompt receives prior rejections so declining a proposal
teaches the loop rather than being a dead end. `other` is deliberately excluded from the model
feedback — unstructured text would poison the prompt with one org's idiosyncratic phrasing.

> Once a body of applied proposals exists and their outcomes are measurable, an
> `auto_apply_below_confidence` threshold could be revisited for low-risk changes. Not at launch —
> that decision needs the evidence this loop is designed to produce.

### 7.2 What the Closing Agent must pass back

The analyser is only as good as its inputs. Every terminal event **must** carry:

- `outcome` + `lossReason` from the closed vocabulary
- `valueGbp` and `cycleDays`
- `icpSnapshot` and `blueprintVersion` — **the attribution join key.** Without these you can measure
  that win rate moved but not *which strategy version* moved it, and the loop degenerates into
  correlating noise.
- `payload`: objections raised, concessions offered, negotiation rounds, contact role/seniority

That last field is what makes the brief's motivating example computable: *"we target CMOs but CFOs
close faster"* is a `GROUP BY payload->>'contactRole'` over `cycleDays` and win rate.

### 7.3 The change envelope (safety)

Reuse `AUTONOMOUS_TUNABLE_FIELDS`' discipline with a sales-specific allow-list:

- **Allowed:** campaign `targetPersona`, discovery query themes, outreach playbook sections,
  objection playbook responses, lead score weightings.
- **Never:** `deal_guardrails` (floor price, concessions, non-negotiables), autonomy level,
  suppression lists, spend guardrails. **An agent must never widen its own financial or safety
  envelope.**
- One change per run. Full audit row. Notification. Reversible — store the prior value in the audit
  payload so a pivot can be rolled back.
- `MIN_SAMPLE` guard against the failure mode the goal optimizer already documents: acting on a step
  function produces oscillation, not learning.

---

## 8. Phase 6 — Swarm scaling (deliberately last)

Sequenced last because it multiplies the cost of every preceding phase, and because a fleet of agents
running against a **hard** monthly task cap is a support incident, not a feature.

- **Localisation:** per-campaign `locale`, threaded through discovery queries, outreach copy and
  objection handling. `aiAssistants.language` already exists (`schema.ts:406`) and `translate.ts`
  provides the plumbing; the gap is that generation does not currently read it.
- **Templating:** clone an assistant's configuration + blueprint + guardrails into N localised
  instances in one action.
- **Cost model first:** projected task-run consumption per swarm member against `check-capacity.ts`
  limits, surfaced *before* provisioning. The task cap is a hard stop with no overage path, and
  there is no self-serve top-up — a swarm that silently exhausts an org's quota pauses every other
  assistant they own.

---

## 9. Sequencing summary

"Blocked by" is a build dependency. "HITL gate" is the approval this phase introduces, per §2.5 —
class in brackets.

| Phase | Scope | Est. | Blocked by | HITL gate introduced |
|---|---|---|---|---|
| 0 | `revenue_events` + backfill + `recordEvent()` | ~1 wk | none — start here | none (ledger only) |
| **1a** | **Signal Inbox over saved searches** | **~1 wk** | **none — engine already live** | batch approve + anomaly gate **[A]** |
| 1b | Social ingest + intent + handoff | 1-2 wks | Meta app review | none new — same batch gate |
| 2 | Threads, reply ingest, sequence engine | ~2 wks | Phase 0 | first touch per account **[B]**; steps 2+ ungated **[A]** |
| 2b | **DM windowed reply** — Facebook only (§5.4) | ~1 wk | Phase 1b + Phase 2 | pre-approved reply set **[C]**; sends ungated **[A]** |
| 3 | Account graph + memory + conversational query | 2-3 wks | Phase 2 (needs messages) | none — read-only surface |
| 4 | Closing Agent + guardrails + payment links | ~3 wks | Stripe Connect; legal review | concession + payment link **[B]**; autonomy ceremony **[C]** §2.4 |
| 5 | Autonomous strategy agent | ~2 wks | **Phases 0 + 4** — needs real outcomes | proposal review, never apply-then-notify **[C]** §7.1 |
| 6 | Swarm scaling | TBD | cost model | per-swarm spend ceiling **[C]** |

Only three phases add a gate a user will feel day to day — 1a (batched), 2 (first touch), and 4
(irreversible actions). Phases 3 and 5 add none and one respectively, and **1a removes** per-item lead
approval in exchange for a batch action.

Phases 1 and 2 are independent of each other and can run in parallel after Phase 0.

**1a is the only phase with no dependency of any kind** — the discovery engine, the saved-search CRUD
and the cadence dispatcher are already live on staging. It is the cheapest path to a visible, working
Signal Inbox and it must not be sequenced behind 1b, whose blocker (Meta app review) is dashboard
state outside our control.

## 10. Migration notes

- Every `db/*.sql` here is a **manual apply** — `scripts/db-migrate.mjs`, not `drizzle-kit push`,
  and `psql` is not installed on this machine. See `docs/db-migrations.md`.
- Drizzle definitions in `db/schema.ts` must stay in sync with the raw DDL, including `check()`
  constraints — a later `drizzle-kit push` will otherwise revert them.
- Verify constraint changes by INSERTing inside a `sql.begin()` that throws to roll back: it proves
  good values are accepted *and* bogus ones still rejected, leaving no test rows.
- Prod deploys from `main` while dev runs on `staging` — keep them synced or prod ships stale.
- New Tailwind classes require a `style.css` rebuild, which churns unrelated selectors. Prefer
  classes already compiled; grep with `grep -F` before adding any.
