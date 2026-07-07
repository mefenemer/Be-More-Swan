# Lead Generator — Outbound Discovery Layer (design)

Target architecture for turning the current **inbound Lead Qualifier** (`roleKey: lead_qualifier`)
into the brief's **proactive outbound discovery engine**. Grounded in existing codebase patterns —
nothing here invents infrastructure we don't already run.

## Guiding decisions (why this shape)

1. **Dedicated discovery tables, not more `assistant_records` JSONB.** Real discovered leads need
   provenance (source URL, query that found them), cross-run dedupe, and enrichment signals —
   untyped JSONB rows can't index or dedupe that. New tables own the *raw* discovery pipeline.
2. **Promote into `assistant_records` on qualification, don't replace it.** The existing Data Hub,
   Review Queue (`approvalStatus` gate), Calendar, and handoff UI all render from
   `assistant_records` (`recordType: 'lead'`). A qualified `discovered_lead` is *mirrored* into an
   `assistant_records` row as a `lead_scoring_card` — so **zero front-end rebuild**. `discovered_leads`
   is the source of truth for discovery/provenance; `assistant_records` stays the source of truth for
   the human-in-the-loop workflow. (`db/backfill-lead-records.sql` shows this mirror already exists
   conceptually.)
3. **Reuse the `content_generation_jobs` worker pattern verbatim.** Same queue table shape, same
   `FOR UPDATE SKIP LOCKED` drain, same native-cron + on-demand-HTTP-trigger split
   (`process-content-jobs.ts` / `run-content-jobs.ts`) that lets staging drain its own queue. This is
   the single most important reuse — it's the piece the brief calls out ("preventing serverless
   timeouts on Netlify") and we already solved it.
4. **The LLM generates queries, not companies.** Today `lead-generation.ts:approve_idea` asks Haiku
   to *"produce realistic example companies"* — it fabricates leads. The inversion: LLM emits **search
   query arrays**, a real search/scrape layer executes them, extraction + scoring run on actual pages.

---

## 1. Database schema (Drizzle / PostgreSQL)

Naming avoids the existing `leads` table (that's Be More Swan's *own* trial/upgrade sales pipeline —
see `schema.ts:127`; do not overload it). All tables are tenant-scoped on `organisation_id` and tied
to the per-org assistant instance `ai_assistant_id`, matching every other Tier-1 table.

> Migrations are applied manually on staging (see MEMORY: "Content Engine build"). Ship as
> `db/lead-discovery.sql` **and** add the Drizzle definitions below to `db/schema.ts` so the ORM types
> match.

### 1.1 `discovery_campaigns` — the "Idea / Blueprint" (brief: CampaignIdeas)

Supersedes the current LLM-generated `lead_idea` JSONB rows with a **user-authored** hypothesis.

```ts
export const discoveryCampaigns = pgTable("discovery_campaigns", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),

  // The user hypothesis — the core Phase-1 input the schema doesn't capture today.
  idea: text("idea").notNull(),                    // "Boutique hotels in S. Europe with no booking app"
  targetPersona: jsonb("target_persona"),          // { demographics, industries[], painSignals[], sizeBand }

  // Lifecycle: draft → active (runs on schedule) → paused → archived
  status: text("status").notNull().default("draft"),

  // Denormalised ICP snapshot at activation, so a run is reproducible even if onboarding changes later.
  icpSnapshot: jsonb("icp_snapshot"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("discovery_campaigns_assistant_idx").on(t.organisationId, t.aiAssistantId, t.status),
  check("discovery_campaigns_status_check", sql`${t.status} IN ('draft','active','paused','archived')`),
]);
```

### 1.2 `discovery_schedules` — cadence (brief: Schedules)

One row per campaign. Cadence is stored declaratively; the worker (not per-campaign cron) reads them —
we never register N Netlify crons.

```ts
export const discoverySchedules = pgTable("discovery_schedules", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),

  cadence: text("cadence").notNull().default("weekly"),   // 'one_off' | 'daily' | 'weekly'
  daysOfWeek: jsonb("days_of_week"),                       // [1] = Monday, for weekly
  runAtHourUtc: integer("run_at_hour_utc").notNull().default(8),  // 08:00 batch
  timezone: text("timezone").notNull().default("UTC"),

  isEnabled: boolean("is_enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),                    // the dispatcher's claim key

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Hot path: dispatcher scans "enabled schedules whose next_run_at is due".
  index("discovery_schedules_due_idx").on(t.isEnabled, t.nextRunAt),
  uniqueIndex("discovery_schedules_campaign_uidx").on(t.campaignId),
  check("discovery_schedules_cadence_check", sql`${t.cadence} IN ('one_off','daily','weekly')`),
]);
```

### 1.3 `discovery_guardrails` — cost & brand safety (brief: GuardrailConfigs)

Per-campaign caps + negative-keyword lists. Counters are enforced *inside the worker* before each
search/scrape/LLM call — the one thing today's on-demand function has no ceiling on.

```ts
export const discoveryGuardrails = pgTable("discovery_guardrails", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),

  // Cost ceilings (checked before each unit of work; run stops + suspends when hit).
  maxLeadsPerRun: integer("max_leads_per_run").notNull().default(50),
  maxLeadsPerMonth: integer("max_leads_per_month").notNull().default(500),
  maxSearchApiCallsPerRun: integer("max_search_calls_per_run").notNull().default(100),
  maxTokensPerRun: integer("max_tokens_per_run").notNull().default(200000),
  maxCostGbpPerRun: decimal("max_cost_gbp_per_run", { precision: 10, scale: 2 }).notNull().default("2.00"),

  // Brand protection.
  negativeKeywords: jsonb("negative_keywords"),          // ["competitor.com", "acme corp", ...] — hard exclude
  excludedDomains: jsonb("excluded_domains"),
  requireHumanApproval: boolean("require_human_approval").notNull().default(true),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("discovery_guardrails_campaign_uidx").on(t.campaignId),
]);
```

### 1.4 `discovered_leads` — raw discovery output w/ provenance (brief: DiscoveredLeads)

The new source of truth for what discovery found. **Dedupe key is the normalised domain** within a
campaign — the field JSONB cards can't index. Qualified rows are mirrored into `assistant_records`.

```ts
export const discoveredLeads = pgTable("discovered_leads", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),
  jobId: integer("job_id").references(() => discoveryJobs.id, { onDelete: "set null" }),  // which run found it

  companyName: text("company_name").notNull(),
  domain: text("domain"),                                 // normalised (lowercased, no www) — dedupe key
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),

  // Provenance — the brief's whole point: WHY was this surfaced, and from WHERE.
  sourceUrl: text("source_url"),
  discoveredVia: text("discovered_via"),                  // 'niche_scrape' | 'intent_signal' | 'footprint'
  matchedQuery: text("matched_query"),                    // the exact search query that surfaced it
  signals: jsonb("signals"),                              // { hiring:true, techStack:[...], pressMentions:[...] }

  // Qualification (reuses the existing scoring engine's card shape).
  score: integer("score"),                                // 0-100
  rating: text("rating"),                                 // 'hot' | 'warm' | 'cold'
  scoringCard: jsonb("scoring_card"),                     // full lead_scoring_card wire shape

  // Discovery-side lifecycle (distinct from the assistant_records approval gate).
  status: text("status").notNull().default("discovered"), // discovered → qualified → promoted → discarded
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Dedupe: one row per (campaign, domain). Skip re-surfacing across runs.
  uniqueIndex("discovered_leads_campaign_domain_uidx").on(t.campaignId, t.domain).where(sql`domain IS NOT NULL`),
  index("discovered_leads_campaign_status_idx").on(t.campaignId, t.status),
  check("discovered_leads_status_check", sql`${t.status} IN ('discovered','qualified','promoted','discarded')`),
]);
```

---

## 2. Background worker architecture

Mirrors `content_generation_jobs` / `process-content-jobs.ts` — a proven, timeout-safe pattern in this
repo. Three moving parts:

### 2.1 The queue table — `discovery_jobs`

```ts
export const discoveryJobs = pgTable("discovery_jobs", {
  id: serial().primaryKey(),
  jobId: text("job_id").notNull().unique(),               // UUID at enqueue time
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),

  status: text("status").notNull().default("queued"),     // queued | processing | completed | failed
  stage: text("stage"),                                   // query_gen | searching | extracting | scoring | promoting
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at"),
  errorMessage: text("error_message"),

  triggerType: text("trigger_type").notNull().default("scheduled"),  // 'scheduled' | 'on_demand'

  // Resumable cursor — lets a job survive a 10s function timeout and pick up next tick.
  cursor: jsonb("cursor"),          // { queries:[...], queryIndex:N, leadsFound:M, tokensUsed:T, costGbp:C }

  // Run summary (also enforces guardrail counters).
  leadsFound: integer("leads_found").notNull().default(0),
  searchCallsMade: integer("search_calls_made").notNull().default(0),
  tokensUsed: integer("tokens_used").notNull().default(0),
  costGbp: decimal("cost_gbp", { precision: 10, scale: 4 }).notNull().default("0"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("discovery_jobs_status_idx").on(t.status, t.nextRetryAt),
  index("discovery_jobs_campaign_idx").on(t.campaignId, t.status),
]);
```

### 2.2 Two scheduled functions

Both native Netlify cron (production) + on-demand HTTP twins for staging, exactly like
`run-content-jobs.ts`.

| Function | Cron (`netlify.toml`) | Job |
|---|---|---|
| `dispatch-discovery-runs.ts` | `0 * * * *` (hourly) | Scans `discovery_schedules` where `is_enabled AND next_run_at <= now()`; enqueues one `discovery_jobs` row per due campaign; advances `next_run_at` by cadence. Cheap, no scraping. |
| `process-discovery-jobs.ts` | `* * * * *` (every minute) | Drains the queue. The heavy worker. |

### 2.3 The drain loop (timeout-safe)

Netlify functions cap at ~10s (26s background). Multi-page scraping blows through that, so the worker
is **cursor-resumable and self-chunking** — the key defence the brief asks for:

```
drainDiscoveryJobs():
  1. Reset stuck jobs:  status='processing' AND updated_at < now()-interval '3 min' AND attempt<max
                        → status='queued'   (copied verbatim from process-content-jobs.ts)
  2. Claim ≤5 jobs:     SELECT ... WHERE status IN ('queued') AND (next_retry_at IS NULL OR <=now())
                        FOR UPDATE SKIP LOCKED   → set status='processing'
  3. For each job, run ONE bounded slice of work against a wall-clock budget (~8s):
       a. load guardrails; if any counter already exceeded → status='failed', notify, stop
       b. if no cursor.queries yet → STAGE query_gen (§3) → persist queries to cursor, return
       c. else process the next K queries from cursor.queryIndex:
            search API call → extract candidates → negative-keyword/excluded-domain filter
            → upsert discovered_leads (ON CONFLICT (campaign, domain) DO NOTHING = dedupe)
            → score new leads (existing normaliseLeadCard engine)
            → increment counters; if a cap trips mid-slice, stop cleanly
       d. advance cursor.queryIndex; if more queries remain → leave status='queued' (resume next tick)
            else → STAGE promoting → mirror qualified leads into assistant_records
                   (recordType 'lead', approvalStatus 'pending_approval' when requireHumanApproval)
                   → status='completed'
  4. Backoff on throw: attempt++, next_retry_at = now()+BACKOFF_SECS[attempt]  ([10,30,90])
```

Because each tick does a *slice* and the cursor persists progress, a single logical run can span many
1-minute ticks without ever hitting a function timeout — no long-running process, no external queue
service, no Netlify Background-Function time limit risk.

### 2.4 Guardrail & human-in-the-loop enforcement points

- **Cost:** counters (`searchCallsMade`, `tokensUsed`, `costGbp`, `leadsFound`) checked *before* each
  unit; `maxLeadsPerMonth` checked with a `SUM` over the campaign's jobs this calendar month. Trip →
  job `failed` + notification (reuse `notifications` table).
- **Brand safety:** `negativeKeywords` / `excludedDomains` applied at the extraction filter *before*
  a `discovered_lead` is ever written — nothing sensitive is stored, let alone contacted.
- **Approval:** promotion writes `assistant_records.approvalStatus='pending_approval'` (the gate that
  already exists) → surfaces in the current Review Queue → nothing executes until a human approves.
  This closes the brief's "must not execute automated outreach without approval" requirement using
  infrastructure already shipped.

---

## 3. LLM search-query generation logic

The inversion. Idea string → **query arrays** (not companies). One Haiku call per run, cached on the
job cursor so retries don't re-pay for it.

```
SYSTEM: You are a B2B lead-discovery query strategist. Turn the user's hypothesis into
        search queries a scraper will run against Google/Maps/registries. Do NOT name or
        invent companies — output only queries. Cover three strategies distinctly.

INPUT (interpolated):
  Idea:            {campaign.idea}
  Target persona:  {campaign.targetPersona}
  ICP snapshot:    {campaign.icpSnapshot}      # industries, min headcount, region
  Negative list:   {guardrails.negativeKeywords}   # never generate a query targeting these

OUTPUT (strict JSON):
{
  "niche_scrape":   ["boutique hotels southern Europe", "site:booking-directory.com hotels Portugal", ...],
  "intent_signal":  ["\"now hiring\" \"driver retention\" logistics 2026", "hotels \"careers\" front desk Spain", ...],
  "footprint":      ["hotels Portugal -inurl:booking -inurl:reserve", "\"call to book\" boutique hotel", ...]
}
```

Each string maps to `discovered_leads.discovered_via` (the array it came from) and is stored on
`matched_query`, so every lead carries *why the strategy surfaced it* — the provenance the brief wants.

- **`niche_scrape`** → direct search/maps/directory API calls.
- **`intent_signal`** → the same API, phrased for hiring/tech-stack/press signals; extracted signals
  land in `discovered_leads.signals`.
- **`footprint`** → negative-match queries (`-inurl:booking`, `"call to book"`) that surface the
  *absence* the solution fixes.

### 3.1 The one true external dependency

Everything above is buildable on current infra **except** the actual search/scrape execution. We have
**no** SERP/scrape provider today (`web_search` tool unused; `cheerio` present but not wired). This is
the single procurement decision: a search API (SerpAPI / Serper / Bing) + a fetch-and-extract step
(`cheerio` is already a dependency and enough for HTML footprint checks). Wrap it behind
`src/lib/discovery-search.ts` so the worker calls one typed interface and the provider stays swappable.

---

## Build order

1. **Schema** — `db/lead-discovery.sql` + `db/schema.ts` additions (5 tables). Manual apply on staging.
2. **`discovery-search.ts` provider wrapper** + provider procurement — unblocks everything real.
3. **Query-gen prompt** — swap `lead-generation.ts:approve_idea` from "invent companies" to "emit
   queries"; keep `normaliseLeadCard` scoring untouched.
4. **Worker** — clone `process-content-jobs.ts` → `process-discovery-jobs.ts` + `dispatch-discovery-runs.ts`
   + on-demand twins; wire cron in `netlify.toml`.
5. **Campaign UI** — replace the "Propose lead ideas" modal with an Idea/Blueprint + cadence + guardrail
   form; discovered leads already render via the existing Data Hub / Review Queue (no rebuild).
6. **Outreach + handoff execution** — the currently-drafted-but-never-sent `outreachDraft` and the
   label-only `nextActionOwner` handoff are a *separate* follow-on epic; discovery stops at a qualified,
   approved lead in the Review Queue.
```
