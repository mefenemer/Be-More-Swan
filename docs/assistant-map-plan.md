# Assistant Map: Every Assistant, What It Uses and Who It Works With: Plan

Added 2026-11-12. **Owner's request:** *"In the admin portal I want a page where I can visualise Be More Swan
assistants and their integrations and connections with other systems and other assistants similar to how you are
building the Be More Swan System Dashboard."*

Status: **plan written 2026-11-12, waiting on the owner's go-ahead. Nothing is built.** It builds on the System Map
(docs/system-map-plan.md), which is live on prod (released 2026-11-13).

---

## 1. The idea in one paragraph

The System Map answers *"what does Be More Swan run on, is it up, what does it cost?"*. The Assistant Map answers
*"what does each assistant need, who does it hand work to, and who gets hurt when something breaks?"*. It is a
**second view on the same page**: a toggle at the top, **Systems | Assistants**. Both views share one loader,
drawer, health checks and cost figures. There's no second registry of systems and no second admin page.

## 2. What already exists (so we don't build it twice)

| Need | Already there | Gap |
| --- | --- | --- |
| Systems, health, versions, cost | `src/utils/system-registry.ts`, `src/utils/system-map-data.ts` → `loadSystemMap()`, `admin-system-map.ts`, `src/components/admin-system-map.js` | None. Reuse as it is |
| Which roles use which model | `loadSystemMap()` already joins `ai_usage_log` → `ai_assistants` → `master_assistants` (`rolesByModel30`); `assistant_model_settings` holds the chosen model per role | Only models. Media, search, email and connectors aren't attributed to roles |
| Spend by assistant | `ai_usage_log.assistant_id` | Not grouped by role anywhere |
| Tasks by assistant | `task_ledger.assistant_id` (indexed with org + period) | Not grouped by role anywhere |
| Who the Campaign Assistant can order | `ORCHESTRATABLE_ROLE_KEYS` in `src/constants/roles.ts`, already checked by a test | None. Reuse it to draw those lines |
| Hand-offs that actually happened | `campaign_orders`, `orchestration_runs` (status `handed_off`/`skipped`), `video_projects.scheduled_post_id`, `mentor_outcomes.job_id`, `scenario_jobs` (lead → CRM). `src/utils/requested-by.ts` already explains each route | No single place lists the routes, so nothing can say a route is missing |
| Links the customer set up | `orchestration_links` (source assistant, `source_event`, target assistant, free-text `target_action`) | Only visible inside each workspace |

**The real gap:** the hand-off routes between assistants live in separate files (`video-handoff.ts`,
`lead-handoff.ts`, `newsletter-from-post.ts`, `orchestration.ts`, the Mentor). A map drawn from memory would be out of
date within a month. Phase 1 fixes that before any screen is drawn.

## 3. What the map draws

### Nodes
- **Assistants:** one per role in `master_assistants`, named as the catalogue names it (`roleNames`). Each shows
  how many workspaces have it hired and active, using the same "active" rule as `assistant-capabilities.ts`.
  Archived and draft roles are hidden behind a "show all" switch.
- **Systems:** the same nodes and groups as the Systems view, using the same health colours.

### Three kinds of connection

1. **Assistant → system** (what it needs to work).
   - *Wired:* declared in the new links registry, marked **required** (the assistant can't work without it, e.g.
     the Video Producer needs Remotion) or **optional** (it does more with it, e.g. a Canva connection).
   - *Used:* real calls in the last 30 days, from `ai_usage_log` grouped by role, with the model mapped to its
     system by `systemForUsageModel()`.
   - **Undeclared use is flagged:** if a role spends on a system the registry doesn't list, the line is drawn in
     warning style and the drawer says "used but not declared". This keeps the registry honest at runtime, on top
     of the tests.

2. **Assistant → assistant** (who hands work to whom).
   - *Built-in routes*, declared in the registry, each naming the file that does it:
     - Campaign Assistant → every role in `ORCHESTRATABLE_ROLE_KEYS` ("orders"). These edges are **generated from
       the constant**, never copied.
     - Social / Blog → Video Producer ("make a video version", `video-handoff.ts`).
     - Blog Writer → Email Marketing ("publishes a post → newsletter draft", `newsletter-from-post.ts`, via an
       orchestration link).
     - Business Mentor → Social ("post request", `mentor_outcomes`).
     - Lead Generator → Email Marketing audience ("Won leads → Audience").
   - *Customer-made links* (`orchestration_links`): shown as one line per role pair with a count, e.g. "Blog →
     Brand Designer · 12 workspaces". **The free-text `target_action` is customer content and is never shown
     platform-wide.**
   - *Used:* hand-offs in the last 30 days, counted from `campaign_orders`, `orchestration_runs` (`handed_off`),
     `video_projects` with a source post, and `mentor_outcomes` with a job. Line thickness = volume. A declared route
     with zero use in 30 days is drawn faint, not hidden.

3. **Shared inputs** (Business Info, Brand Knowledge, Products, Team activity). Every assistant reads them, so
   lines from each one to every assistant would just clutter the map. They're shown instead as a **band** across
   the map labelled "Every assistant reads", with exceptions named (an assistant whose surfaces don't use one,
   per the surfaces registry).

### Layout
- Assistants in the middle, system groups around the outside, assistant-to-assistant lines curve inside.
- **Click (or focus) an assistant:** its own lines light up and everything else dims. This is what stops a
  25-node map turning into a hairball, so it isn't optional.
- **Click a system in this view:** it highlights every assistant that depends on it. This is the "who's affected"
  view.
- **Phone:** lines are hidden, assistants are listed with their needs and hand-offs as rows, and the drawer opens
  full screen. Same rules as the System Map.

### Assistant drawer
- Name, role key, lifecycle state, hired-and-active count.
- Model: the chosen one from `assistant_model_settings`, or the code default, with thinking level.
- Needs: required and optional systems, each with its health right now.
- Hands work to / receives work from: built-in routes with 30-day counts, plus customer-link counts.
- Spend in the last 30 days and all time (since the first logged row, as the System Map does), split by system.
  Tasks in the last 30 days and all time. Spend per task.
- Feature switches turned on for this role (`assistant_features`).
- "Undeclared use" warnings, if any.

## 4. Health carries through ("who breaks if X is down")

- An assistant's status is the worst health among its **required** systems: green when all are up, amber when one
  is erroring, grey when one isn't configured in this environment. Optional systems never turn it red; they show
  as a note.
- The top strip in the Assistants view shows: assistants affected right now · hand-offs in the last 30 days ·
  undeclared uses.
- Example: fal is down, so Brand Designer, Video Producer and Social (images) go amber, and the drawer names the
  reason.

## 5. The links registry (Phase 1, no UI)

A new file `src/config/assistant-links.ts`:

```ts
ROLE_NEEDS:   Record<roleKey, { system: SystemKey; required: boolean; why: string }[]>
HANDOFFS:     { from: roleKey; to: roleKey; label: string; via: 'campaign_order' | 'orchestration_link'
                | 'video_handoff' | 'mentor_request' | 'won_to_audience'; code: string; marker: string }[]
SHARED_INPUTS: { key: string; label: string; except: roleKey[] }[]
```

Tests (new file `tests/assistant-links.test.ts`):
- Every live role in the seed catalogue has a `ROLE_NEEDS` entry, even if it's empty, so a new assistant can't
  slip in without being declared.
- Every `system` key exists in `system-registry.ts`.
- Every hand-off's `code` file exists and contains its `marker`. Markers must be unique strings (see the
  source-scan notes).
- Campaign-order edges equal `ORCHESTRATABLE_ROLE_KEYS` exactly, so the map's version and the code's version can't
  drift apart.

Loader: `loadAssistantMap()` lives next to `loadSystemMap()` and **calls it** rather than re-querying systems.
The maths goes in a pure `assembleAssistantMap()`, tested against a fixture, the same pattern as
`assembleSystemMap()`.

**No SQL is needed.** Every number comes from tables that already exist.

## 6. GUI and chat parity

"Ask about systems" (`admin-systems-chat.ts`) gets the assistant data from the same loader, so it can answer
"which assistants stop if ElevenLabs goes down?" or "what does the Video Producer cost per task?". It stays
read-only, like the System Map chat. Nothing on this page writes anything except the System Map's existing bill
form.

## 7. Phases

| Phase | What | Done when |
| --- | --- | --- |
| **0** | Merge the System Map to main (owner's call) | Systems view live on prod |
| **1** | `assistant-links.ts` + tests + `loadAssistantMap()` + endpoint field (`?view=assistants`) | Tests pass. A one-off staging run lists any undeclared use, and the registry is corrected from it |
| **2** | Assistants view: toggle, layout, focus/dim, drawer, phone layout | Checked in the browser pane at desktop and 375 px, against a fixture and then staging data |
| **3** | Health carried through + top strip + chat reads assistants | "fal down" simulated in a fixture shows the right assistants amber |
| **4** *(later, only if wanted)* | Workspace filter: one customer's assistants, their own links with `target_action` text | Super admin only, follows the impersonation rules; separate decision |

## 8. Decisions taken by default (owner can overrule)

1. **Platform-wide, not per workspace.** It shows assistant types across all workspaces, with counts. A
   per-workspace view is Phase 4 because it shows customer data.
2. **Same page, toggle at the top.** Not a new admin page.
3. **System Map ships first.** Building on unreleased work would stack two releases into one risky merge.
4. **Shared inputs as a band, not lines.**
5. **Customer links shown only as counts.** Their wording stays private.

## 9. Risks and what isn't known yet

- **All-time spend by role** groups across the whole of `ai_usage_log`. Nobody has checked whether that's fast
  enough without an index on `assistant_id`. Phase 1 measures it on staging first; if it's slow, all-time is
  cached daily rather than adding an index blind.
- **Spend with no `assistant_id`** (helpers, the public taster, admin tools) can't be pinned to a role. It's
  shown as "not tied to an assistant" with its total, so nothing is quietly dropped. Same rule as the System
  Map's unmapped spend.
- **`ROLE_NEEDS` starts as my reading of the code** and could be wrong in places. The undeclared-use check against
  real staging usage is how Phase 1 proves it.
- **The Mentor and Won-leads routes** are recorded differently from campaign orders. Their counts may need their own
  small queries; the exact columns are confirmed in Phase 1 before the counts are trusted.
