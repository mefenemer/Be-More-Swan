# Campaign Orchestrator — design & build plan

**roleKey:** `campaign_orchestrator` (snake_case, to be added verbatim to `db/seed-catalog.ts`)
**Display name:** Campaign Orchestrator
**Status:** design only — nothing built. Mockup: `docs/mockups/campaign-orchestrator-mockup.html`
**Written:** 2026-08-06

---

## 0. The one-paragraph version

Every other campaign tool optimises **the ad**. This one optimises **the company's whole
output**, because in Be More Swan the budget line and the content line are the same line. Its
unit of control is not an ad set — it is an **Order** issued to a colleague. It can spend £50
boosting a post, *or* three of the Social Media Assistant's drafting slots, *or* one Blog Writer
pillar, *or* 200 Lead Generator search calls — and it prices all four in the same ledger. No ad
platform can do that, because each one owns exactly one lever.

---

## 1. Critique of the brief before we build it (Phase 0)

The brief is good and the ambition is right. Three parts of it cannot ship as written, and one
part of it is far better than the brief realises. Getting this straight now is the difference
between this assistant and the last three.

### 1.1 The autonomous ad buying is blocked on approvals we do not control

| Platform | What the brief assumes | What is actually true in this repo today |
|---|---|---|
| **Meta** | "creates campaigns, adjusts bids" | `meta-oauth.ts:32` `SCOPES` does **not** request `ads_read` or `ads_management`. All 8 scopes we *do* request sit at **Standard** access. Business verification is **Unverified** (business `1406204451352969`). Access verification (Tech Provider) is a second ~5-day stage behind it. Until both clear, Live-mode customers dead-end before consent. See `meta-app-live-blockers`. |
| **LinkedIn** | "create campaigns via Advertising API" | The app has exactly two products: *Sign In with LinkedIn (OIDC)* and *Share on LinkedIn*. The Advertising API is not a scope we can add — it is a **product application** we have never made. We cannot even read an org's follower count today. See `linkedin-scopes-match-approved-products`. |
| **Google Ads** | "full creation via API" | No Google Ads developer token exists in this codebase. Basic access requires an application and a review. We have `searchconsole` only. |
| **TikTok** | "full programmatic access" | We have a TikTok *content* connector, not an ads one. |

**Therefore: paid ads are Phase 3, not Phase 1.** Designing the Phase 1 screen around a "Launch
paid campaign" button would ship the `follower-counts-availability` /
`goals-steer-generation` bug again — a control that renders, promises, and can never return a
value. The paid rails are designed in the mockup as an *honest locked state* that names the
blocker and the ETA, in the style of `searches-tab-states-what-it-is-doing`: **an empty surface
must say why it is empty and what unblocks it.**

### 1.2 "£0 budget" is not a scenario. It is the product.

The brief treats zero-budget as one mode among many. Invert it. Be More Swan already meters a
finite, real, hard-capped resource end to end: **the monthly task allowance**
(`usage_counters.task_count`, per org, UTC month, `atomicCapCheck` refuses at the cap rather
than billing overage — `task-cap-is-a-hard-stop`).

That is a budget. It is denominated in capacity instead of pounds, it is already enforced
server-side, it needs zero platform approvals, and **no competitor meters it**. So:

> A campaign is an allocation of **two** budgets: **£** (external, on the customer's own ad
> account, gated on approvals we do not control) and **tasks** (internal, already metered,
> live today).

Ship the task budget first. The £ budget slots into the identical UI later without a redesign.
This is also Golden Rule 1 (never require an external system) expressed as a product feature
rather than a fallback.

### 1.3 The autonomy claim has to be gated harder than auto-publish

`auto-publish-gate-rules` requires five conditions before a *post* goes out unattended.
Spending money is a strictly larger blast radius. And `chat-creates-draft-campaigns` already
settled the governing invariant for the Lead Generator, for exactly this reason:

> **Approving in chat SAVES. It never STARTS.** A model's judgement plus one click must never
> be enough to spend money or reach a stranger.

That invariant is inherited here and tightened: **a chat turn can never start a spend, raise a
ceiling, or resume a paused campaign.** Those three actions require a click on the campaign
surface itself, by a human, with the number visible.

### 1.4 The genuinely disruptive part the brief undersells

The brief's disruption is "the AI buys ads for you", which is a commodity (Meta Advantage+,
Google PMax and Smartly all do it, better, with more data). The actual disruption is the
**Effort Ledger**: one campaign, one objective, and a single allocator that trades money against
agent capacity and can see the outcome of both in the same database. Lead in with that.

---

## 2. The role

**Campaign Orchestrator** — the assistant that turns one business objective into orders for
everyone else, then spends whatever it takes (money or capacity), inside limits you set, to hit
it. It writes nothing itself. It commissions, allocates, measures and reallocates.

Three things define it against the rest of the roster:

1. **It is the only assistant whose output is other assistants' work.** Its Data Hub is a ledger
   of orders it issued, not artefacts it made.
2. **It is the only assistant that spends.** So it is the only one with a kill switch in its
   permanent chrome.
3. **It is the only assistant that is allowed to change another assistant's instructions.** That
   is why every order it issues is attributable, reversible and shown before it lands.

---

## 3. Screens

Follows the uniform template (`assistant-detail-four-tab-template`): Performance Metrics strip
above the tab bar, then tabs. New surfaces are marked ⊕.

```
Performance Metrics  (4 KPI cards — mode-aware, campaign-lifetime window)
⊕ Budget & Control strip  (persistent, all tabs — the two ledgers + the kill switch)
────────────────────────────────────────────────────────────────
⊕ Campaigns │ Data Hub (Orders) │ Review Queue (Decisions) │ Calendar │ Goals │ Workflow │ Activity
   ^ landing tab (defaultMainTab: 'campaigns')
```

### 3.1 Performance Metrics — four KPI cards

Registry entry (`assistant-dashboard-registry.js`) — without one this role silently inherits the
**social_media_manager** dashboard, which is wrong in every cell.

| # | label | title | desc |
|---|---|---|---|
| 1 | Outcomes Delivered | What It Actually Produced | Leads, signups and replies this campaign caused — not clicks, not impressions. |
| 2 | Cost per Outcome *(paid)* / Effort per Outcome *(organic)* | The Real Price | Every pound — or every task — divided by the outcomes it produced. |
| 3 | Decisions Taken For You | Reallocations | Budget moves, channel switches and halts it made without waking you, each with its evidence. |
| 4 | Needs You | Awaiting Approval | Decisions parked above your threshold, and campaigns blocked on something only you can fix. |

Two deliberate departures from the existing roles:

- **Card 2 swaps its unit by campaign mode.** An organic campaign showing "Cost per Outcome: £0"
  is a lie about a real cost (capacity). It shows tasks instead.
- **The window is campaign-lifetime, not "Last 30 days".** `#metrics-status-note` reads
  *"This campaign, since launch"*. A 30-day window across a 6-week flight is arithmetic that
  cliff-drops at rollover — `roi-hero-defaults-all-time` already bit us once.

### 3.2 ⊕ Budget & Control strip (persistent)

Sits under the KPI grid, above the tab bar, visible on every tab. Three blocks:

1. **Money — your ad account.** `£ spent / £ ceiling this month`, with the account it is charged
   to named in full. Copy states plainly: *"Charged by Meta to your ad account, not by Be More
   Swan."* Rationale: `discovery-spend-cap-is-operator-only` — a £ sign on a card **is** a price
   to whoever reads it, whatever we meant. There must be no ambiguity about whose money moves.
   Hidden entirely in organic-only workspaces; not shown as "£0".
2. **Capacity — your plan.** `tasks committed / tasks left this month`, read from
   `usage_counters` by org with `getPeriodStart()` — never re-derived from `task_runs`. Shows how
   much of the org's remaining allowance this campaign has claimed, and the phrase that makes the
   cap a feature: *"At the cap it stops. It never bills you extra."*
3. **Stop everything.** One button. Halts every active campaign, cancels queued orders, leaves
   published work alone. Always enabled, never behind a menu.

⚠️ **Every pause needs a resume** (`connection-pause-needs-a-resume`). "Stop everything" writes a
`halt_reason` and produces a *named, listed* resume path on the Campaigns tab — the last build
paused posts and `system_paused` assistants with no route back, and nobody noticed for weeks.

### 3.3 ⊕ Campaigns tab (landing)

One row per campaign. Directly modelled on `searches-tab-states-what-it-is-doing`, whose lesson
was learned the expensive way: *a list that does not say what is happening reads as broken.*

Each row carries:

- **Objective in the user's own words** — "Acquire 50 trial signups by 30 September".
- **A state chip**, from a closed vocabulary: `Draft · Awaiting approval · Running · Throttled ·
  Paused (you) · Paused (guardrail) · Blocked · Finished`.
  `Throttled` and `Paused (guardrail)` are distinct on purpose — one is the agent optimising,
  the other is the agent stopping. Conflating them is `connection-status-vocabulary-drift`.
- **Both burn bars** — £ and tasks — against their ceilings, plus pace-vs-target.
- **What it is doing right now**, in one sentence: *"Waiting on the Blog Writer — pillar drafted,
  in your Review Queue since Tuesday."*
- **Start / Pause / Edit.** Starting is the only write this tab makes besides approving.

**The empty state is derived, not fixed** — four variants, exactly as the Searches tab learned:
never launched · launched and running · finished and hit target · finished and missed. "It found
nothing" and "it never got as far as looking" are different facts and only one means *widen it*.

### 3.4 Data Hub — "Orders"

`assistant_records`, new `record_type = 'campaign_order'` (extends the CHECK enum in
`db/internal-data-hub.sql`, `db/assistant-records*.sql` **and** `db/schema.ts` — they must move
together or a future `drizzle-kit push` reverts the DDL; this exact break already cost us the
dead "Add Lead" button).

One row per instruction issued. Columns: `Order · Campaign · Assigned to · Cost (£ / tasks) ·
Status · Result`. The **Result** column is what makes this table worth having: it links to the
post, blog or lead the order produced, so the chain *objective → order → artefact → outcome* is
one click end to end. Nothing else in the product can currently show that chain.

Spreadsheet fallback (Golden Rule 1): `importColumns: ['campaign','channel','spend','outcomes','date']`
so a founder can bring last quarter's numbers in from a spreadsheet and get a real baseline on
day one instead of an empty dashboard.

### 3.5 Review Queue — "Decisions"

`{ kind: 'records', recordType: 'campaign_decision' }`. Every decision above the user's autonomy
threshold lands here as a card carrying: what it wants to do, the evidence, the cost, what
happens if you ignore it, and an explicit **expiry**. Four kinds:

1. **Strategy proposal** — the one-click "Approve Strategy" of the brief. Approving it *saves and
   starts the organic half*; the paid half requires the separate money click (§1.3).
2. **Reallocation** — "move £150 from LinkedIn to the organic sequence".
3. **Escalation** — "this organic post is at 3.1× average; commission a pillar / boost it".
4. **Halt** — "lead quality dropped below 40%; stop this variant".

⚠️ **Rejection must teach something.** `lead-rejection-teaches-nothing` — the Lead Generator
shipped a Reject button that captured no reason and fed no consumer, so the user re-corrects the
same mistake forever, and `feedback-loop-social-only` means the records roles have no learning
path at all. Here, Reject is a **two-field** action (reason chip + optional note) and its
consumer is specified before build: the reason is written to the campaign's constraint set and
restated in the prompt that generates the *next* proposal. If the consumer is not built, the
button ships disabled — not silently inert.

### 3.6 Calendar

`calendar.js` via `initCalendar({ assistantId })`. Campaign flights as bars; delegated posts and
blog publish dates overlaid from the existing sources. `modules.hasPostingSchedule: false` — this
role publishes nothing itself, so the platform filter and posted/overdue legend are stripped.

### 3.7 Chat

`primaryAction: { label: 'Set an Objective', kind: 'chat' }`. Emits a
`campaign_strategy_proposal` uiElement, registered in `disruptive-ui-registry.js` (escape every
LLM string via the passed `escapeHtml`).

Three coupled requirements, each one a bug we have already paid for:

- **Approving in chat writes a DRAFT** (`asDraft: true`) and enqueues nothing.
- **A chat write must dispatch `campaign:created` on `document`**, because the chat modal is
  mounted at body level and the tabs behind it are already loaded — otherwise the Campaigns tab
  keeps reading "No campaigns yet" and the assistant looks like it did nothing
  (`chat-creates-draft-campaigns`). There is no generic mechanism; it is wired per surface.
- **The system prompt must name these tabs and buttons verbatim**, guarded by a new
  `tests/campaign-prompt-surfaces.test.ts` cloned from `tests/lead-prompt-surfaces.test.ts`.
  `lead-prompt-surface-coupling`: an assistant never told its own product exists will invent an
  explanation and send the user to a competitor. Renames count, not just additions.
- Never claim a write that did not happen (`chat-claims-drafts-it-never-saved`): the reply is
  built from the insert's return value, not from the model's intent.

---

## 4. Integration scenarios — what is wireable now vs. what is aspirational

`orchestration_links` exists (`source_event → target_action`) but the runtime only fires on post
events, so each scenario below names the new event it needs.

| # | Scenario | Phase 1 (buildable now, no approvals) | Later |
|---|---|---|---|
| 1 | **Organic → escalation** (Social) | Post at ≥2.5× account average → order the Blog Writer to build a pillar on that topic and the SMM to re-cut it into 3 more posts. New `source_event: 'post_outperforms'`. **Entirely organic, ships today.** | Same trigger → paid boost, once Meta ads scopes clear. |
| 2 | **Lead-quality feedback loop** (Lead Gen) | Lead Generator flags >40% low-quality over 24h → orchestrator halts the *order*: edits the discovery search's `negativeKeywords`/idea and adjusts the ICP, and tells the SMM to change top-of-funnel messaging. `lead-rejection-teaches-nothing` says fixing the search is the only lever that actually works today. | Halt the paid variant too. |
| 3 | **Unified launch** | One prompt → orders fan out: SMM 2-week teaser calendar, Blog Writer pillar + CTA, Lead Generator capture page and follow-up. Orchestrator holds the launch until every asset passes its consistency check. | Native ad forms on the same schema. |
| 4 | **Content pillar brief** (Blog) | Campaign strategy requiring education → structured brief (keywords, persona, CTA, tracking) to the Blog Writer; on publish, auto-atomised by the SMM into 14 days of posts. | — |
| 5 | **Capture forms** | **Schema-first, BMS-hosted.** The form is a row in our DB and renders on a Be More Swan page. Needs no ad-platform approval and exists nowhere in the product today (`capture-lead.ts` is *our own* trial pipeline against the `leads` table — do not overload it). | The same schema translates out to Meta/LinkedIn/Google native forms, and friction-throttling mutates the platform copy. |

⚠️ **The campaign objective must actually reach generation, or the whole thing is decoration.**
This is the single largest risk in the build, and we have the receipts: SMART Goals shipped 7
functions, 3 crons, a metric catalog and a progress bar, and `grep -i goal` over the generation
path returned **nothing** — every post was byte-identical to having no goal
(`goals-steer-generation`). The fix pattern is known and must be copied exactly:

- New blueprint section (`13-campaign`) carrying structured data **plus** a pre-rendered
  `directive` string, listed in `VERBATIM_DIRECTIVE_SECTIONS` so the generic flattener does not
  dump the JSON alongside the prose.
- **Two generation seams, both must be fed**: social goes through `renderBlueprintPrompt()`;
  blog assembles its own prompt in `buildBlueprintGuardrailsBlock()` and needs a separate
  injection. Missing the second is `inspo-tab-build` all over again.
- **Never put a fast-moving value in section content** — blueprint rows de-dupe by content, so a
  live spend figure would make every unrelated recompile emit a new row. Carry pace as a bucket
  (ahead / on track / behind), not a number.

---

## 5. Data model sketch

New tables, mirroring the `discovery_campaigns` family (idempotent `db/campaigns.sql`, manual
apply, matching `db/schema.ts`, RLS on every tenant-scoped table):

- `campaigns` — objective, mode (`organic` | `paid` | `blended`), status
  (`draft → active → throttled → paused → finished → archived`), window, `halt_reason`.
- `campaign_budgets` — **two ceilings per campaign**: `max_spend_gbp` (locked to `0.00` and
  immutable for organic campaigns) and `max_tasks`. Plus autonomy threshold: the value above
  which a reallocation needs a human.
- `campaign_orders` — the instruction to another assistant: target assistant, action, priced in
  both units, status, and the artefact id it produced.
- `campaign_spend_events` — append-only. Every £ and every task, attributed to an order.
  Append-only because `phase-4-5-outcome-capture` established that a correction **appends a row**
  rather than editing history.
- `campaign_outcomes` — reads from the existing `revenue_events` / `account_edges` rather than
  minting a private ROI ledger. There is already an attribution substrate; a second one would
  disagree with the first.
- `campaign_decisions` — mirrored into `assistant_records` (`campaign_decision`,
  `approval_status = 'pending_approval'`) so the existing Review Queue renders it with no rebuild.

Guardrails enforced **server-side at the HTTP boundary**, not just in the UI — the personal-inbox
gate taught us that a UI-only guard holds for exactly one caller.

---

## 6. Failure modes designed for up front

| Risk | Why it is real | Design response |
|---|---|---|
| **Connection dies mid-flight while spend continues** | `connection-status-vocabulary-drift`: dead connections were badged "Connected". A 5s Neon blip destroyed a rotating X token (`prod-neon-blip-kills-rotating-tokens`). If the ad connection dies while a paid campaign runs, the platform keeps spending and we no longer control it. | A dedicated **"Control lost"** state — never "Connected", never silent. Campaign auto-throttles, user is notified with the exact sentence *"We can no longer stop this campaign from here."* |
| **Runaway reallocation loop** | `insights-cron-condemns-connections` produced an endless reconnect loop; `quality-review-compliance-gate` found suggestions diverge where compliance converges. Optimisation is a divergent process. | Max reallocations per campaign per day, decreasing step size, and a floor below which it stops moving money at all. |
| **API rate limits (Meta 100 QPS, Google 10k mutate)** | The brief correctly flags it. | All platform writes go through a batched, resumable job queue cloned from `process-discovery-jobs.ts`, with the cursor/slice pattern that already survives the ~10s function tick. `background-trigger-must-be-awaited` — an un-awaited fetch strands jobs forever. |
| **Chat proposes a number the user reads as a bill** | Happened verbatim: the model proposed "Max £50 per run" and users read it as a charge (`discovery-spend-cap-is-operator-only`). | The chat proposal card may state the objective and the *task* budget. Any £ figure is stripped from the chat schema and set only on the campaign surface, by a human, next to the account it charges. |
| **Everything renders and nothing steers** | §4's warning. | `tests/campaign-directive.test.ts` on the pure directive builder, plus an admission test per seam asserting the campaign changes the generated prompt. |

---

## 7. Build order

**Phase 1 — Organic campaigns, task budget only (no ad approvals needed).**
Catalog entry · connection map · onboarding schema · dashboard registry · `campaigns` /
`campaign_orders` / `campaign_spend_events` tables · Campaigns tab · Orders Data Hub ·
Decisions Review Queue · Budget & Control strip (capacity block only) · blueprint section 13 in
both seams · orchestrator route + prompt + surfaces test · scenarios 1, 2, 3, 4.

**Phase 2 — Outcomes & capture.** BMS-hosted schema-first capture pages, campaign-tagged, feeding
the Lead Generator's existing normaliser. Outcome attribution off `revenue_events`.

**Phase 3 — Paid rails.** Gated on Meta business verification → access verification → ads scopes,
and on a Google Ads developer token. Ships behind a plan feature, default off, exactly as
`strategy_agent` did. Until then the paid surface renders as a locked state that names the
blocker — never as a button that fails.

---

## 8. Onboarding self-audit (`assistant-onboarding-checklist`)

Every one of these needs a deliberate answer before Phase 1 is called done. A "MISSING" is only
acceptable when it is an intentional fallback with a stated reason.

`seed-catalog.ts` · `roles.ts` · **`connection-map.ts` (security — a role missing here is
fail-open; note the legacy `paid_ads: ['social']` entry which has no catalog twin and should not
be reused)** · `assistant-onboarding-schemas.js` (exactly one `operational: true` step) ·
`master_assistants` copy (DB-driven — do **not** recreate `assistant-role-content.js`) ·
`mandate-suggestions.js` · `goal-metrics.ts` · **`assistant-dashboard-registry.js` (missing ⇒
silently inherits the social dashboard)** · `assistant-starter-prompts.js` ·
`disruptive-ui-registry.js` · `chat-orchestrator.ts ROUTES` · `notification-prefs.ts` ·
`assistant_feature_defs` · `orchestration_links` · plan/pricing · tests.

UI traps to carry in: **`hidden` loses to `inline-flex`** — any new tab badge must go through
`_setDetailRqTabBadge` and pin `style.display`, or it renders as an empty amber dot. Reuse
compiled Tailwind classes so `style.css` needs no rebuild (`tailwind-rebuild-drift`);
`last:border-b-0` is not in the compiled sheet.
