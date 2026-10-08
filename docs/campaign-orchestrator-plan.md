# Campaign Orchestrator — design & build plan

**roleKey:** `campaign_orchestrator` (snake_case, to be added verbatim to `db/seed-catalog.ts`)
**Display name:** Campaign Orchestrator
**Status:** Phase 1 + paid rails built (catalog name "Campaign Assistant"). ⚠️ A started campaign
places no orders — see §9.1, which blocks everything in §9. Mockup: `docs/mockups/campaign-orchestrator-mockup.html`
**Written:** 2026-08-06 · **§9 added:** 2026-10-08 (marketing review)

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

---

## 9. Marketing review — Phase 4 (added 2026-10-08)

A marketing-manager review of this plan. The verdict: keep the Effort Ledger, but the plan solves
for system architecture and misses how a team actually plans and runs a year of marketing. It asks
for a **hybrid team orchestrator** — AI and human colleagues, audiences, brand assets, a campaign
hierarchy — not "an AI blog-and-tweet factory". Each point below was checked against the code on
2026-10-08; most of the building blocks already exist elsewhere in the product and are simply not
wired to campaigns.

### 9.0 The rule for every item in this section: GUI and chat parity

Every capability here ships **twice, in the same commit**: a manual control on the campaign
surface, and the same outcome reachable by talking to the assistant. A capability that exists in
only one of the two is not done.

- **One server path.** The GUI and the chat call the same `campaigns.ts` action with the same
  validation. Chat never gets its own write path — a guard that holds for one caller holds for
  exactly one caller (§5).
- **Chat writes produce a card, the card writes the row.** The model proposes a `uiElement`; the
  user's click on that card performs the write; the reply is built from the write's return value,
  never from the model's intent (`chat-claims-drafts-it-never-saved`).
- **Every chat write dispatches a `document` event** (`campaign:updated`, alongside the existing
  `campaign:created`) so the tab behind the chat modal re-renders. There is no generic mechanism.
- **The §1.3 invariant is unchanged and applies to every new capability**: a chat turn may create
  and edit *drafts* and *proposals*, but can never start a campaign, raise a ceiling, resume a
  pause, send to a human, or spend. Those are clicks on the campaign surface with the numbers
  visible. Where the table below says "proposal", the chat card files a pending decision that
  the user approves on the Decisions tab or the card itself — never auto-applied.
- **No £ figure in any chat card** (§6) — including in hierarchy and budget views.
- **The system prompt names every new tab, field and button verbatim**, and
  `tests/campaign-prompt-surfaces.test.ts` pins each one, so the assistant can tell the user where
  the manual control lives and never invents one.

| Capability | Manual (GUI) | Chat |
|---|---|---|
| Audience / persona / funnel stage | Fields on the campaign create/edit form | Set in the strategy proposal card; "change the audience to…" → edit card |
| Exclude existing customers | Toggle on the campaign (default ON for acquisition stages) | Stated in the proposal card; chat can turn it ON, never OFF without the user's click |
| Campaign tone & assets | Tone field + asset picker on the campaign | "Use the holiday guidelines / these images" → edit card listing the assets it will attach |
| Parent / child, always-on | Parent picker + always-on flag; Calendar year view | "Put this under Summer Rebrand" → edit card; "what's running this year?" → read-only summary |
| Commission AI work (orders) | "Add work" on the campaign row | Orders inside a proposal → pending decision |
| Human tasks | "Assign to a person" on the campaign row; mark done | Proposed as an order; ticket created only on the user's approval |
| Email nurture | "Add work → Email campaign" | Proposed as an order to the Email Marketing Assistant |
| A/B test | "Test two angles" on the campaign | "Test angle X vs Y" → test card with hypothesis |
| Post-mortem | "Campaign summary" on a finished row; save learnings | "How did the campaign go?" → the same summary; "remember that" → save-learning card |

### 9.1 Prerequisite — orders must actually flow (BLOCKING)

Found 2026-10-08: a started campaign briefs nobody. `start` only flips status; the chat proposal's
`orders` are dropped by `chat-session.js` `onCampaignCreate` and ignored by `create`; decision kind
`strategy` is handled by `decide` but nothing ever inserts one; `place_order` has no caller.
Prod's only campaign has run since 2026-09-30 with zero orders.

- **Chat:** `create` persists the proposal's orders as a pending `strategy` decision. Approving it
  places them verbatim and starts the campaign (the path `decide` already implements).
- **GUI:** a campaign create/edit form on the Campaigns tab (today chat is the ONLY way to create
  a campaign, and the `edit` action has no client), plus "Add work" on each row → `place_order`.
- Every subsection below extends the order system, so none of it is worth building first.

**✅ Built 2026-10-08 (not yet deployed; no DDL).** `src/utils/campaign-plan.ts` files a chat plan
as a pending `strategy` decision (a newer plan supersedes the old one); `create` and the new
`propose_plan` action file it, and never place it. Approving it (on the campaign row as
"Approve plan & start", or in Decisions) checks the monthly cap and the whole plan against the
budget, activates the campaign **before** placing its orders (section 13 only compiles live
campaigns), then places them. The Campaigns tab gained "New campaign", "Edit", "Add work"
(→ `place_order`) and the plan block; the chat gained a campaigns snapshot, `campaignId` on the
proposal (add work to an existing campaign) and a `campaign_edit_proposal` card that cannot touch
the budget (`viaChat` refuses it server-side). Fixed on the way: executors read `brief.quantity`
while the ledger priced `quantity` (6 posts priced, 1 drafted); chat briefs carried no `idea` /
`angle`, so lead searches and messaging changes could never run; a blank target saved as 1; blog
pillars priced up to 20 but drafted at most 5. Guarded by `tests/campaign-plan-flow.test.ts`.

### 9.2 Audience, personas, suppression

**Exists:** campaign-first `icpSnapshot` resolver (Lead Generator), `audience_segments` (Email
Marketing Assistant), a `brief.persona` slot on orders that nothing populates.
**Build:**
- `campaigns.audience` (jsonb: persona name, description, segment id or ICP override) and
  `campaigns.funnel_stage` (§9.6). Carried into every order's brief and into blueprint section
  `13-campaign` so drafting writes *for someone* — both seams, as §4 requires.
- Per-order persona override, so one campaign can brief the Blog Writer for Persona A and the Lead
  Generator for Persona B.
- **Existing-customer exclusion.** `checkSuppression` covers opt-outs only; nothing stops a
  `run_lead_search` order finding companies that are already customers. Exclude domains from won
  outcomes / CRM contacts at discovery time, default ON for awareness/consideration/conversion
  campaigns, OFF for retention (where customers ARE the audience).

**✅ Built 2026-10-08 (not yet deployed). ⚠️ Needs `db/z-campaign-audience.sql` applied to BOTH
envs BEFORE the code deploys** (`requireCampaign` selects every column). `campaigns.audience`
(persona, description, excludeDomains) + `exclude_existing_customers` (default TRUE until §9.6
sets it per stage). Pure helpers in `src/config/campaign-audience.ts`. Drafting: blueprint §13
reads `audienceLine(campaign.audience, order.brief.audience)` — the order's own audience wins.
Lead searches: `src/utils/customer-exclusion.ts` resolves, on every run, the domains of leads
marked WON in Conversations plus the campaign's "also leave out" list, for searches a campaign
order points at only (hand-built searches untouched); merged into a COPY of the guardrails.
Customers the platform never saw can only be excluded by domain — there is no tenant customer
list to read. Segment ids are deferred to §9.7. GUI: form fields, an audience line on every row
("No audience set" when missing), per-brief audience on Add work. Chat: proposal + edit cards
show and send the audience; the chat can switch the exclusion ON but never OFF, and its domain
list is merged, never replaced. Guarded by `tests/campaign-audience.test.ts`.

### 9.3 Creative assets & campaign tone

**Exists:** `content_assets`, brand kit (`brand-kit.ts`), brand cards, AI image generation.
**Build:**
- `campaigns.tone` (free text, e.g. "holiday guidelines: warm, no discounts language") injected
  through §13 alongside the angle.
- Campaign asset tags on `content_assets`; `draft_social_posts` orders prefer tagged assets before
  generating or falling back to stock.
- Commissioning visuals is a human task (§9.5) or an AI image order — never silently text-only
  when the campaign has assets attached.
- Open question: the brand kit is one per workspace. A per-campaign variant ("holiday guidelines")
  either lives in `campaigns.tone` + tagged assets, or needs a named brand-kit variant. Start with
  the former.

### 9.4 Campaign hierarchy & the year view

Each campaign already has its own task ceiling, so reallocating inside one cannot cannibalise
another — the budget concern is already structurally met. The real gap is planning.
**Build:**
- `campaigns.parent_campaign_id` (one level: umbrella → child) and `campaigns.always_on`
  (no `ends_at`, excluded from the reconciler's finish sweep).
- Calendar (§3.6, never built): campaign flights as bars, children nested under umbrellas,
  always-on as a background band, delegated posts/blogs overlaid.
- Umbrella rows on the Campaigns tab roll up children's tasks used and outcomes (read-only sums).
  Parent-level budgets that constrain children are **deferred** until someone needs them.

### 9.5 Human team members (hybrid workflows)

**Exists:** Meeting Note Taker's `create_tasks` handler (Jira / Asana tickets), Slack connector,
chained orders (`blocked` until the predecessor delivers, released by the reconciler).
**Build:**
- Order action `request_human_task`: assignee (name/email or a PM-tool project), description, due
  date, 0 work items. New order status `waiting_on_human`, chip "Waiting on: <name>".
- Delivery: a native "Mark done" (with optional asset upload, which attaches to the campaign —
  §9.3) works with no integration (Golden Rule 1); a Jira/Asana ticket closing is the automatic
  path. Without a return path the order waits for ever — the exact bug the reconciler was
  written to close.
- Legal/compliance review as a gate: a human task can block the orders behind it, so "hold the
  launch until Legal approves the claims" is a chain, not a new mechanism.

**✅ Native half built 2026-10-08 (not yet deployed; NO DDL).** Order `request_human_task`
(role `human` — deliberately NOT in `ORCHESTRATABLE_ROLE_KEYS`: a person is asked, not commanded),
0 tasks, brief = assignee, task, optional dueDate + assigneeEmail. **Nothing is ever sent to the
person** — the email is shown so the USER knows who to tell. Deviation: no new `waiting_on_human`
status (it would have meant widening a CHECK); 'issued' + "Waiting on <name>" carries it, and
'blocked' is "not started — waiting for earlier work". Waiting: plan items take `after` (1-based,
backwards only); positions are translated when invalid items are dropped, and an item whose
prerequisite was dropped is SKIPPED, never run early. "Add work" can "Hold this until" an open task.
"Mark done" delivers (releasing waiting work via unblockChain, which now RELEASES a person's task
instead of cancelling it for having no assistant); "Won't happen" rejects (cancelling what waited).
Chat: plans can include people + `after`; a `campaign_task_update` card marks a task done through
the same `complete_task`. Rows show open tasks, overdue, and how much work waits on each.
**Not built (the automatic half):** filing a Jira/Asana ticket (needs a per-tenant project picker —
the Meeting Note Taker's `createJiraIssue`/`createAsanaTask` are the code to reuse) and closing the
task when the ticket closes (webhooks or polling); asset upload on "Mark done" waits for §9.3.
Guarded by `tests/campaign-human-tasks.test.ts`.

### 9.6 Funnel stage & differentiated KPIs

**Build:**
- `funnel_stage`: `awareness | consideration | conversion | retention`, required on new campaigns.
- Outcome metrics per stage: awareness → reach, engagement (from `post_insights`, already
  collected); consideration → clicks on tracked links, replies; conversion → leads, signups;
  retention → email engagement, repeat outcomes.
- KPI cards (§3.1) switch labels and sources by stage; card 2 stays "Effort per Outcome".
- **Proposer guard:** `halt` (lead quality) and any target-shortfall logic apply to conversion
  campaigns only. An awareness campaign must never be halted for not producing signups.
- Unblocks `signups` (`UNAVAILABLE_OUTCOME_METRICS`): Form Builder submissions are already
  attributed via `campaign_attributions`.

**✅ Built 2026-10-08 (not yet deployed). ⚠️ Needs `db/z-campaign-funnel-stage.sql` applied to
BOTH envs BEFORE the code deploys.** `campaigns.funnel_stage` (NOT NULL DEFAULT 'conversion' —
every earlier campaign was a lead campaign; inline CHECK, no DROP). Stage → allowed outcomes in
`STAGE_OUTCOME_METRICS` (vocab); create/edit fall back to the stage default rather than letting an
awareness campaign count leads. New countable outcomes: `engagement` (post_insights on the posts
its orders produced), `clicks` (tracked links, bots excluded), and `signups` is now live (Form
Builder signups via campaign_attributions); `email_engagement` waits for §9.7.
**Found on the way: nothing counted a campaign's own outcome** — target and metric were stored and
shown, `replies` was counted nowhere. `src/utils/campaign-outcomes.ts` now counts each metric
through the campaign's orders and links only (never by date overlap), null = not countable. Rows
show stage + "37 of 500", the chat snapshot carries the same numbers. Drafting: a per-stage line
in the §13 directive (awareness never pitches, retention speaks to customers). Halt: only for
conversion campaigns (`mayProposeHalt`). Retention defaults to including customers.
**Deviation from the plan:** the four assistant-level KPI cards were NOT made stage-aware — they
aggregate every campaign an assistant runs, and summing engagements with leads is meaningless.
Stage-specific measurement lives on each campaign row instead. Pace stays 'unknown'; it can now
be computed from these counts (a follow-up). Guarded by `tests/campaign-funnel-stage.test.ts`.

### 9.7 Email nurture

The review asked for HubSpot/Mailchimp; we already have the Email Marketing Assistant (forms,
segments, email campaigns, form-started campaigns). It is simply not an order target.
**Build:** order action `draft_email_campaign` → Email Marketing Assistant, landing as a draft
email campaign for approval. ⚠️ `orchestration-target-role-decides-artifact`: the hand-off must
branch on the target's role or it produces a social post nobody finds. External ESPs stay out of
scope until a customer asks.

**✅ Built 2026-10-08 (not yet deployed). ⚠️ Needs `db/z-campaign-email-orders.sql` applied to
BOTH envs BEFORE the code deploys — the Email Studio's bare reads break without it, not just
campaigns.** Order `draft_email_campaign` → Email Marketing Assistant (`newsletter_editor` added to
`ORCHESTRATABLE_ROLE_KEYS`), 2 tasks per email, default 4, max 7. Uses the Studio's own generator
(`draftCampaignEmails`) and cadences. `emailTrigger: form` = a follow-up sequence for form signups
(the nurture), `custom` = draft emails the user sends; the stage picks when unsaid. **It never
sends:** sequences stay `is_enabled = false`, emails stay drafts; switching on is the user's in
Email Studio. Drafting is a BACKGROUND job (`draft-campaign-emails-background`) because one model
call per email would blow the plan-approval request's ~26s; awaited wake-up, atomic claim on the
order, lost wake-ups re-sent by the hourly reconciler, failures cancelled + refunded through the
reconciler's one settlement path. Emails/sequences carry `campaign_order_id`, which unlocks the
`email_engagement` outcome (distinct people who opened or clicked; retention's default measure).
Not done: a segment id on the campaign audience (the send-it-yourself drafts have no segment set —
the user picks one when sending); no notification when the emails are ready (the order's row and
Email Studio show it). Guarded by `tests/campaign-email-orders.test.ts`.

### 9.8 A/B testing & post-mortems

**Exists:** paid variants (`ad_variants`) already test creatives.
**Build:**
- Organic test: an order pair with a declared hypothesis ("long-form beats short-form on LinkedIn")
  and two angles, tagged A/B on the produced posts. The result reports **"not enough data"**
  below `MIN_POSTS_FOR_AVERAGE` — organic samples are small and a winner declared on noise is
  worse than none.
- Post-mortem: when the reconciler moves a campaign to `finished`, generate a summary (objective
  vs result, orders delivered, test outcomes, what the user rejected and why). The user chooses
  which learnings to save.
- ⚠️ Saved learnings need their own route into prompts: learned directives / `content_rules` reach
  posts roles only today (`learned-directives-gated-to-posts-roles`). Saving a learning that no
  future campaign reads is the `goals-steer-generation` bug again — ship the consumer in the same
  commit, or don't ship the save button.

### 9.9 Build order

1. **§9.1** orders flow (chat strategy decision + GUI create/edit/add work). Blocking.
2. **§9.2 + §9.6** audience, persona, funnel stage, existing-customer exclusion — small, and they
   change what gets drafted.
3. **§9.7** email order — closes capture → nurture.
4. **§9.5** human tasks — native first, Jira/Asana/Slack second.
5. **§9.3 + §9.4** campaign tone/assets, hierarchy, Calendar year view.
6. **§9.8** organic A/B and post-mortems.

Each step lands with: DDL in an idempotent `db/*.sql` applied to both envs **before** the code
(`requireCampaign` selects every column), the drizzle mirror, the GUI control, the chat card and
prompt text (§9.0), and the prompt-surfaces test extended.
