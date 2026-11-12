# System Map: Every System, Its Health, Cost and Better Options: Plan

Added 2026-11-12. **Owner's request:** *"In the admin portal I want a page where I can visualise Be More
Swan and all of its integrations and connections to other systems and whether those systems are up and
running, the all time costs and the costs for the last 30 days, number of equivalent tasks used… the
connecting lines between the systems and the system versions etc this include LLM models… If I click
on a system it provides me with more information… highlight whether there are any better tools
available in the market whether that is for quality, features or price."*

Status: **plan agreed 2026-11-12 ("write the plan doc then start phase 1").** **Phase 1 built 2026-11-12 on staging
(not committed).** Typecheck + all 705 test files pass; tests/system-map.test.ts holds it together. As built:
- Remotion: `renderProgress()` now returns `costUsd` (Remotion's `costs.accruedSoFar`, USD only); both render paths
  log it once per finished render, a failed render before its retry included (`logRenderCost`, model `remotion-lambda`).
- whisper: own voice and footage review log $0.006/min (`logTranscriptionCost`). Tour narration logs its speech on a cache miss.
- Registry: OpenAI (own entry, free /v1/models check), ElevenLabs + Stability (free balance reads as health), Remotion
  (all-parts-present check), Hunter, Companies House, Gemini, and connectors Canva, Google Calendar, Outlook/Teams.
  "Embeddings & moderation" is now just Voyage.
- `src/utils/system-map.ts`: `systemForUsageModel()` and `fixedCostForPeriod()`.
- ⚠️ **`db/z-system-fixed-costs.sql` must be applied to BOTH DBs** before Phase 2 reads it (nothing reads it yet). Starts empty.
- **Known gap left:** AI Visibility's direct OpenAI (gpt-5.5) and Gemini calls still log nothing. Their prices weren't
  checked, so no guessed figure was written. The registry says so on the Gemini entry.
- **Not verified live:** no real render, transcription or tour clip has written a row yet.

**Phase 2 built 2026-11-12 on staging (not committed at time of writing).** SQL applied to both DBs (owner). As built:
- **One registry:** `src/utils/system-registry.ts` (moved out of admin-system-status.ts, which is now a thin wrapper).
  Adds `SYSTEM_VERSIONS` (API version we call + installed SDK version; a test fails on drift) and an Anthropic
  health check (free `GET /v1/models`). Neon's Postgres version is read live.
- **One loader:** `src/utils/system-map-data.ts` → `loadSystemMap()`; maths in `assembleSystemMap()` (pure). GBP at
  platform_config `fx_rates_to_gbp` (the COGS rate), shown on the hub. Unmapped spend is flagged but counted.
- **Endpoint** `admin-system-map.ts`: GET the map; POST `add_fixed` / `end_fixed` / `delete_fixed` (validated by
  `validateFixedCostRequest`). Super admin; writes refused while impersonating.
- **Chat** `admin-systems-chat.ts` ("Ask about systems", under the map): reads the same loader, never writes;
  cards POST the page form's exact body to admin-system-map.ts. Model Opus 5.5, Opus 4.8 fallback.
- **Page** `src/components/admin-system-map.js`: strip (spend 30 d / all time + since, tasks 30 d / all time,
  cost per task, systems down), hub-and-spoke map with health-coloured curves, model chips under providers,
  drawer (status, version, cost split, models with assistant names, monthly bills add/end/delete, links,
  "Better options: not checked yet"). Phone: lines hidden, groups stack, drawer full screen.
- **Checked** in the browser pane against a fixture (no DB): desktop + 375 px (no sideways scroll), drawer, bill
  form, Escape + focus return, chat card confirm. **Not checked against staging data or a real chat answer.**
- Decisions taken by default (owner's open questions): GBP with the rate shown; the owner enters bills in the drawer
  (or via chat). Nothing seeded.

---

## 1. Where it stands today

| Need | What already exists | Gap |
| --- | --- | --- |
| List of systems | `admin-system-status.ts`: 18 services + 19 OAuth connectors, tier, configured, health ping (Admin → Systems & connections, super_admin) | Missing: ElevenLabs, Stability, OpenAI (as its own system), Voyage (shared with OpenAI), Remotion Lambda, Hunter, Companies House, Canva, Google Calendar |
| Variable spend | `ai_usage_log.cost_usd` per call. Claude tokens (gateway + direct calls), fal images/video (`logMediaCost`), Stable Audio, voiceovers (OpenAI / ElevenLabs), Serper + Hunter (`logServiceCost`), Voyage embeddings | **Not logged:** Remotion renders (AWS compute), whisper transcription for own voice and footage review, onboarding tour narration (TTS) |
| Fixed spend | Nothing | Netlify, Neon, Resend, ElevenLabs Starter, Porkbun, Google Workspace etc. are monthly bills no API call shows |
| Tasks used | `task_ledger` (units per org per period) | None — read it |
| Versions | Node runtime (Systems page); model ids in code | SaaS APIs rarely report a version: use the API version we call, stated in the registry |
| Better options | Nothing | New: monthly research job, stored and dated |

**"All time" is honest only from when each provider started logging.** Media logging began 2026-10-13;
Remotion/whisper/tour narration begin with Phase 1. The page shows "since <first row>" per system and
never implies more.

## 2. What the page looks like (Phase 2)

- **Where:** the existing Admin → Systems & connections view becomes the map. One registry, one
  endpoint; the GUI and the admin chat read the same data (GUI + chat parity).
- **Top strip:** spend in the last 30 days · all-time spend (since …) · tasks in the last 30 days · tasks all time · systems down.
- **The map:** Be More Swan in the middle; groups around it: AI models, Media, Data & storage, Email,
  Billing, Search & data, Hosting, Social connectors, Business connectors. Lines run from Be More Swan to each
  system, coloured by health (green ok, red error, grey not configured, dashed = configured but not checkable).
  Each Claude/OpenAI/fal model is a node under its provider, labelled with the assistant roles that use it
  (from the per-role model picker).
- **Click a system → drawer:** purpose, version, health + time checked, env var NAMES (never values),
  console link, 30-day and all-time cost (variable + fixed), cost per task, which features/assistants call
  it, and "Better options".
- Phone width: the map collapses to a grouped list; the drawer becomes a full-screen sheet.

## 3. Better options (Phase 3)

- A monthly background job (same pattern as AI Visibility) researches each PAID system with web search
  and stores: alternatives, why (quality / features / price), sources, date checked.
- Shown as a dated opinion: "Checked 3 Dec: … (sources)". Never switches anything; only suggests.
- It respects decisions the owner already took (e.g. Opus 5.5 for image prompts, FLUX.2 Pro, ElevenLabs
  Pepper), listed per system so it doesn't re-suggest what was turned down.
- Spend: one research run per paid system per month, logged to `ai_usage_log` like any other call.

## 4. Phases

### Phase 1 — make the numbers true (this phase)
1. Log Remotion render cost (Remotion reports `costs.accruedSoFar` in USD) when a render finishes, from both render paths.
2. Log whisper transcription (own voice, footage review) at $0.006/min.
3. Log tour narration TTS on a cache miss.
4. Add the missing systems to the registry, with health checks where a free read-only call exists
   (ElevenLabs and Stability already have balance reads).
5. `src/utils/system-map.ts`: one pure mapping from an `ai_usage_log.model` value to its system key, so
   costs can be grouped per system; a test fails when a logged model maps to nothing.
6. `db/z-system-fixed-costs.sql`: `system_fixed_costs` (system key, monthly amount + currency, from / to
   dates, note) for subscriptions. Filled in by hand until Phase 2 gives it a form.

### Phase 2 — the map page
Endpoint returns registry + health + 30-day/all-time spend per system (variable + fixed) + tasks from
`task_ledger` + first-logged date. Map, strip, drawer on the Systems view; admin chat reads the same endpoint.

### Phase 3 — better options job
Monthly job + stored results + drawer section + "decisions already taken" list per system.

## 5. Open questions for the owner
- ~~Currency~~ — GBP at the COGS rate, shown (default taken 2026-11-12; say if you want USD).
- ~~Fixed costs~~ — entered by the owner in the drawer or chat; nothing seeded.
