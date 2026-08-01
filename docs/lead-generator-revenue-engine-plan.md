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
   is not a feature flag; it needs an explicit **autonomy level** (§5.2) or you fork the record
   lifecycle for one role and break the shared template.
2. **"Anti-CRM" vs. the four-tab template.** Everything renders through
   Overview / Data Hub / Review Queue / Calendar. **Decision: build the memory layer as the new
   source of truth and keep the tables as a projection over it.** Same disruptive capability,
   zero regression, and the conversational surface ships as an *addition* (§4.4).
3. **Autonomous negotiation + payment collection is regulated.** An AI agreeing commercial terms and
   taking payment needs the guardrail table (§5.1) designed in from day one, plus an immutable
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

6. **Promote, don't replace.** Exactly as discovery does today: new tables own the typed pipeline,
   and rows are *mirrored* into `assistant_records` so the shared Data Hub / Review Queue / Calendar
   UI renders them with no rebuild. Adding a `deal` record type is cheaper than a parallel UI.

---

## 2. Phase 0 — The outcome ledger (keystone)

**Nothing else in this document works without this. Build it first.**

### 2.1 `revenue_events` — append-only fact stream

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

### 2.2 Terminal outcomes on the record lifecycle

`assistant_records.approval_status` stays exactly as-is (it is the *approval* gate). Deal outcome is a
separate axis, stored on the mirrored record's `data` and denormalised into `revenue_events`. Do not
overload `approval_status` with `won`/`lost` — five other assistant roles read that column.

### 2.3 Backfill

`db/revenue-events.sql` (manual apply — see `docs/db-migrations.md`) creates the table and backfills
from existing history so the Strategy Agent has data on day one:

- every `discovered_leads` row → `lead_discovered` at `created_at`
- `contact_email IS NOT NULL` → `lead_enriched`
- `score IS NOT NULL` → `lead_scored` with the score in `payload`
- `assistant_records.approval_status` `approved`/`rejected` → `lead_approved`/`lead_rejected`
- `data->>'outreachSentAt'` → `outreach_sent`

Backfilled rows get `actor='system'` and a NULL `blueprintVersion` — the analyser must tolerate NULL
there and treat those as unattributable (they predate strategy versioning).

### 2.4 Files

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

## 3. Phase 1 — Social → Lead handoff (the gap the brief assumes closed)

### 3.1 `social_engagements` — inbound signal capture

```ts
export const socialEngagements = pgTable("social_engagements", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
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
  uniqueIndex("social_engagements_platform_ext_uidx").on(t.platform, t.externalId),
  index("social_engagements_intent_idx").on(t.organisationId, t.intent, t.handoffStatus),
  check("social_engagements_kind_check", sql`${t.kind} IN ('comment','dm','mention','reaction')`),
  check("social_engagements_handoff_check", sql`${t.handoffStatus} IN ('none','queued','promoted','ignored')`),
]);
```

> ⚠️ **Do not hardcode the platform list.** Use `SOCIAL_PLATFORMS` — stale 4-platform literals are
> exactly how Threads and YouTube got silently dropped elsewhere in the codebase.

### 3.2 Ingestion

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

### 3.3 Extending the handoff runtime

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

### 3.4 Files

| File | Change |
|---|---|
| `db/schema.ts`, `db/social-engagements.sql` | + `socialEngagements` (manual apply) |
| `netlify/functions/social-engagement-webhook.ts` | **new** — signed ingest |
| `netlify/functions/classify-engagement-jobs.ts` | **new** — intent classifier drain |
| `src/utils/orchestration.ts` | + `identifies_intent`, + target-role payload branch |
| `src/lib/intent-classify.ts` | **new** — prompt + normaliser |
| `netlify.toml` | + classifier cron |

---

## 4. Phases 2-3 — Engagement loop and the Anti-CRM memory

### 4.1 `lead_threads` / `lead_messages` — conversation state

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
`sentiment`, `objections jsonb`).

**Reply routing.** `inbound-email.ts` already terminates SendGrid Inbound Parse at
`parse.bemoreswan.com`, but writes to BMS's *own* admin `leads` table. Add a discriminator **at the
top** of that handler: a recipient matching `reply+<token>@` routes to `lead_messages`; everything
else falls through to today's behaviour unchanged. This is the cheapest possible route to inbound —
the MX, token auth, spam gate and multipart parsing all already work.

> ⚠️ Do **not** overload BMS's `leads`/`lead_replies` tables for tenant lead data. They are the
> platform's own trial/upgrade pipeline and are surfaced in Admin → Contacts.

### 4.2 `outreach_sequences` / `sequence_steps` / `sequence_enrolments`

Declarative multi-step cadence with a dispatcher, **cloned wholesale from
`discovery_schedules` + `dispatch-discovery-runs.ts`** — that pattern is proven and already carries
the "declarative cadence, no per-entity cron" property.

Non-negotiable rules, enforced in the worker:
- Any inbound reply **immediately halts** the sequence (`state='replied'`).
- Hard cap on steps per enrolment; hard cap on enrolments per org per day (cost/spam backstop,
  mirroring `HANDOFF_CAP_BY_TIER`).
- Global suppression check before every send — `suppression-sync.ts` already exists; use it.
- Every send and every halt writes a `revenue_events` row.

### 4.3 The account graph + memory (Anti-CRM)

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

### 4.4 Conversational query surface

`netlify/functions/memory-query.ts` — natural-language question → hybrid retrieval (vector kNN over
`account_memory` + graph expansion over `account_edges` + aggregate over `revenue_events`) →
grounded answer with citations back to source rows.

Shipped as a **new panel alongside** the Data Hub table, not instead of it. Users keep the table they
know; the disruption is that both now read from the same memory layer.

---

## 5. Phase 4 — The Closing Agent

New role key **`deal_closer`** in `db/seed-catalog.ts`.

> ⚠️ Master `roleKey`s are snake_case and must match `db/seed-catalog.ts` verbatim. Adding a role
> also requires entries in `connection-map.ts`, `goal-metrics.ts`, `assistant-onboarding-schemas.js`,
> `mandate-suggestions.js`, `assistant-starter-prompts.js` and `assistant-dashboard-registry.js` —
> see the Assistant Onboarding Checklist. Skipping any one of them ships a half-wired assistant.

### 5.1 `deal_guardrails` — the negotiation envelope

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

### 5.2 Autonomy levels

| Level | Behaviour | Approval gate |
|---|---|---|
| `suggest` | Drafts a response, sends nothing | `pending_approval` (today's behaviour) |
| `approve_each` | Drafts and queues each reply | `pending_approval` |
| `approve_exceptions` | Sends within guardrails autonomously; queues anything at the floor, past max rounds, or over `escalateAboveGbp` | conditional |
| `autonomous` | Full zero-touch including payment link | bypassed, everything logged |

This is how zero-touch coexists with the shared Review Queue: the gate is *conditional*, not removed.
`autonomous` should be tier-gated, off by default, and require explicit opt-in with the guardrails
fully populated.

### 5.3 Payment links

Stripe payment links on the **tenant's connected account** (Stripe Connect) — not BMS's own account,
which is what `create-plan-checkout-intent.ts` uses. This is a new Stripe integration surface, not an
extension of billing. Amount always derives from the guardrail-validated figure, never from model
output. Never bypass the floor check.

### 5.4 Objection handling

`objection_playbooks` — per-org, per-objection-category responses, seeded from onboarding's existing
`sales_objections` answer (already collected by the social assistant's schema) and thereafter
**rewritten by the Strategy Agent** based on which responses precede `deal_won`.

---

## 6. Phase 5 — Autonomous strategy pivoting

`netlify/functions/autonomous-strategy-agent.ts`, structurally cloned from
`autonomous-goal-optimizer.ts`.

### 6.1 The loop

```
weekly cron
  → for each org with autonomy enabled AND tier-eligible (re-check per run)
     → aggregate revenue_events over the trailing window, grouped by icpSnapshot dimensions
     → compute per-segment: win rate, mean cycleDays, mean valueGbp, top lossReason
     → require MIN_SAMPLE terminal outcomes per segment, else SKIP (no pivot on noise)
     → LLM proposes ONE change from the allow-list, with evidence citations
     → validate against the change envelope (§6.3)
     → write proposal → audit_logs → notify
     → apply (or queue for approval, per autonomy level)
     → applying an ICP/playbook change triggers the existing ai_blueprints recompile
```

### 6.2 What the Closing Agent must pass back

The analyser is only as good as its inputs. Every terminal event **must** carry:

- `outcome` + `lossReason` from the closed vocabulary
- `valueGbp` and `cycleDays`
- `icpSnapshot` and `blueprintVersion` — **the attribution join key.** Without these you can measure
  that win rate moved but not *which strategy version* moved it, and the loop degenerates into
  correlating noise.
- `payload`: objections raised, concessions offered, negotiation rounds, contact role/seniority

That last field is what makes the brief's motivating example computable: *"we target CMOs but CFOs
close faster"* is a `GROUP BY payload->>'contactRole'` over `cycleDays` and win rate.

### 6.3 The change envelope (safety)

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

## 7. Phase 6 — Swarm scaling (deliberately last)

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

## 8. Sequencing summary

| Phase | Scope | Est. | Gates |
|---|---|---|---|
| 0 | `revenue_events` + backfill + `recordEvent()` | ~1 wk | none — start here |
| 1 | Social engagement ingest + intent + handoff | 1-2 wks | Meta permissions |
| 2 | Threads, reply ingest, sequence engine | ~2 wks | Phase 0 |
| 3 | Account graph + memory + conversational query | 2-3 wks | Phase 2 (needs messages) |
| 4 | Closing Agent + guardrails + payment links | ~3 wks | Stripe Connect; legal review |
| 5 | Autonomous strategy agent | ~2 wks | **Phases 0 + 4** — needs real outcomes |
| 6 | Swarm scaling | TBD | cost model |

Phases 1 and 2 are independent of each other and can run in parallel after Phase 0.

## 9. Migration notes

- Every `db/*.sql` here is a **manual apply** — `scripts/db-migrate.mjs`, not `drizzle-kit push`,
  and `psql` is not installed on this machine. See `docs/db-migrations.md`.
- Drizzle definitions in `db/schema.ts` must stay in sync with the raw DDL, including `check()`
  constraints — a later `drizzle-kit push` will otherwise revert them.
- Verify constraint changes by INSERTing inside a `sql.begin()` that throws to roll back: it proves
  good values are accepted *and* bogus ones still rejected, leaving no test rows.
- Prod deploys from `main` while dev runs on `staging` — keep them synced or prod ships stale.
- New Tailwind classes require a `style.css` rebuild, which churns unrelated selectors. Prefer
  classes already compiled; grep with `grep -F` before adding any.
