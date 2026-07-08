# Integration Scenario Library (design + build)

Target architecture for the brief's **"Integration Scenario Library"** — a Zapier/Make-style
marketplace of prebuilt 1-way and 2-way integration recipes connecting Be More Swan (the Data Hub)
to external systems of record. Grounded in existing codebase patterns — this is a thin *recipe layer*
over primitives BMS already runs, not a new subsystem.

## Guiding decisions (why this shape)

1. **Reuse the Phase-1 integration primitives; add only the recipe layer.** BMS already ships the hard
   parts: `workspace_integrations` (per-org OAuth grant, tokens in `vault_secrets`), `webhook_events` +
   `webhook-intake.ts` (inbound receiver), the `sync-action.ts` action handlers (outbound execution),
   and `integration_api_calls` (audit log). The library adds four config tables and a job queue — it
   does **not** re-implement auth, token refresh, or webhook verification.
2. **One dispatcher, driven by stored JSON recipes — never per-provider functions.** `sync-action.ts`'s
   twelve hardcoded handlers become the exported **`ACTION_HANDLERS` registry**; both the HTTP endpoint
   and the new scenario job processor resolve handlers from it. Adding a Tier-1 provider action = one
   registry entry + one seed row, **no dispatcher edit**.
3. **Per-assistant scope.** `active_scenarios` is scoped to `(organisation_id, assistant_id)` — a recipe
   is turned on for a specific assistant (e.g. only the Lead Generator's leads push to HubSpot), matching
   `system_connections`' per-assistant connection model.
4. **Outbound is queued, not synchronous.** A BMS status change enqueues one `scenario_jobs` row, drained
   every minute by `process-scenario-jobs.ts` with the same claim/retry/backoff shape as `discovery_jobs`.
   Netlify functions are ephemeral, so a durable queue (not `LISTEN/NOTIFY`) is the right fit.
5. **Tier 3 reuses the existing upvote system.** A greyed roadmap scenario links to a `feature_requests`
   row; its "Upvote" button writes `feature_request_votes`. Zero new voting code.
6. **Vanilla UI.** The frontend is vanilla JS (IIFE `window.*` modules), not React — the Integrations Hub
   is an inline controller in `integrations.html`, not a component tree.

---

## 1. Database schema (Drizzle / PostgreSQL)

Drizzle definitions live in `db/schema.ts`; DDL is applied **manually** (no `drizzle-kit push` — an
RLS-enabled push can propose `DROP POLICY` on `ai_assistants`). Ship as `db/integration-scenarios.sql`
and `db/scenario-jobs.sql`.

| Table | Purpose | Tenancy |
|---|---|---|
| `integration_providers` | Catalog of connectable providers (HubSpot, Salesforce, `custom_webhook`, …) | Seed |
| `integration_scenarios` | The browsable recipe library; `tier` 1 native / 2 webhook / 3 roadmap | Seed |
| `active_scenarios` | Recipes a tenant turned on, **per assistant**, with JSONB `field_mappings` | `org` + `assistant` |
| `suppression_list` | Scenario Type C target — domains the discovery AI must never prospect | `org` |
| `scenario_jobs` | Outbound trigger queue (mirrors `discovery_jobs`) | `org` |

`integration_api_calls` gains an `active_scenario_id` column so the execution-log UI filters per recipe.
Tokens are never added here — they stay in `vault_secrets` under the existing `workspace_integrations`
grant.

---

## 2. The unified Event Engine (Netlify functions)

Three data-flow patterns from the brief, each mapped to a concrete function:

### Type A — "Handoff" push (BMS ➔ external) · `process-scenario-jobs.ts`
- **Trigger:** a lead flips to `QUALIFIED` / `MEETING_BOOKED`. The write-path seam calls
  `enqueueScenarioTrigger()` (`src/utils/scenario-engine.ts`) → one `scenario_jobs` row.
- **Drain (every minute):** claim the job, `getMatchingOutboundScenarios()` resolves the assistant's
  enabled recipes whose `trigger_config.when` includes the new status, `buildDiffPayload()` applies each
  recipe's field map, then execute:
  - **Tier 1** → `runAction(actionType, payload)` through `ACTION_HANDLERS` (HubSpot/Salesforce/…).
  - **Tier 2** → POST `buildWebhookPayload()` to the recipe's `webhook_url`.
- Partial failures retry with backoff; a job fails terminally only after `max_attempts`.

> **Integration point (one line):** wherever a lead is approved/qualified in the Review Queue path, call
> `enqueueScenarioTrigger(db, { organisationId, assistantId, triggerEvent: 'lead.status_changed', subject })`.
> `subject.fields` is the flat bag recipes map from (`company`, `contactEmail`, `aiSummary`, `attribution`, …).

### Type B — "Feedback Loop" pull (external ➔ BMS) · `process-webhook-events.ts`
- The CRM's outbound webhook lands via the **existing** `webhook-intake.ts` (verify + dedupe + store).
- The processor's new `handleFeedbackLoop()` runs first: for an enabled inbound recipe matching the
  event's org + provider, it reverse-maps the external stage (`trigger_config.stageMap`, e.g.
  `closedwon → CLOSED_WON`) and records the outcome on the matching `discovered_leads` row's `signals`
  — feeding the discovery AI's training loop. No new receiver function.

### Type C — "Suppression List" sync (external ➔ BMS) · `suppression-sync.ts`
- Daily cron. For each enabled `suppression_sync` recipe, a per-provider `DOMAIN_FETCHERS[provider]`
  (HubSpot = customer-lifecycle companies) pulls client domains, normalised via `normaliseDomain()`
  (same rule as `discovered_leads`) and upserted into `suppression_list`.
- The discovery pipeline's pre-prospect guard becomes a `LEFT JOIN suppression_list … WHERE domain IS NULL`.

**Netlify wiring** (`netlify.toml`): `/api/integrations/*` → `integration-scenarios` (Hub API);
`process-scenario-jobs` @ `* * * * *`; `suppression-sync` @ `0 4 * * *`. `/api/actions/sync` unchanged.

---

## 3. Integrations Hub UI (vanilla JS · `integrations.html`)

A second inline IIFE below the existing connections grid — no React.

- **ScenarioLibrary** — `GET /api/integrations/scenarios?assistantId=` → cards grouped by tier. Tier 1/2
  show **Enable**; Tier 1 gates behind "Connect {provider} first" when no `workspace_integrations` grant
  exists. Tier 3 renders greyed with **▲ Upvote (N)** → `POST /api/integrations/upvote`.
- **Assistant selector** — recipes are per assistant (`get-assistants`).
- **ScenarioConfigDrawer + FieldMapper** — modal built from `scenario.field_schema` (BMS field → external
  field inputs, prefilled with `defaultTarget`); Tier 2 adds a webhook-URL field. Save →
  `POST /api/integrations/activate` (writes `active_scenarios.field_mappings`).
- **ExecutionLogViewer** — `GET /api/integrations/logs?assistantId=` joins `integration_api_calls` ⋈
  `active_scenarios` ⋈ `integration_scenarios`, filtered by `active_scenario_id`.

Hub API resources (all org-scoped via `requireTenant`): `scenarios`, `logs`, `activate`, `toggle`,
`deactivate`, `upvote`.

---

## 4. Files

| File | Change |
|---|---|
| `db/schema.ts` | + `integrationProviders`, `integrationScenarios`, `activeScenarios`, `suppressionList`, `scenarioJobs`; `+ integrationApiCalls.activeScenarioId` |
| `db/integration-scenarios.sql`, `db/scenario-jobs.sql` | Manual DDL (idempotent) |
| `netlify/functions/sync-action.ts` | Switch → exported `ACTION_HANDLERS` registry + `runAction()` |
| `src/utils/scenario-engine.ts` | Enqueue, recipe matching, field mapping, `normaliseDomain` |
| `netlify/functions/process-scenario-jobs.ts` | Outbound drain (Type A) |
| `netlify/functions/process-webhook-events.ts` | + `handleFeedbackLoop()` (Type B) |
| `netlify/functions/suppression-sync.ts` | Suppression cron (Type C) |
| `netlify/functions/integration-scenarios.ts` | Hub API |
| `src/utils/vault.ts` | `logApiCall` gains `activeScenarioId` |
| `db/seed-catalog.ts` | Seed providers + scenarios (incl. Tier-3 roadmap features) |
| `integrations.html` | Scenario Library section + controller IIFE |
| `netlify.toml` | `/api/integrations/*` rewrite + two scheduled functions |

## 5. Rollout

1. Apply `db/integration-scenarios.sql` then `db/scenario-jobs.sql` (owner, manual).
2. `npm run db:seed-catalog` — upserts providers + scenarios idempotently.
3. Deploy — scheduled functions register from `netlify.toml`.
4. Wire the one-line `enqueueScenarioTrigger()` call at the lead-qualification seam.

## 6. Deferred / next

- Additional `DOMAIN_FETCHERS` (Salesforce, Pipedrive) and Tier-1 Salesforce feedback loop.
- Promote the recorded `crmOutcome` signal into an explicit discovery training feature.
- Per-recipe rate limits + a dead-letter view for terminally-failed `scenario_jobs`.
