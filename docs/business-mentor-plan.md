# Business Mentor — design & build plan

**Status:** proposal, 2026-10-25. Nothing built. **All owner decisions in §2 made 2026-10-25**;
Phase 1 can start. Everything here is buildable from pieces already in the repo.

**Working name:** Business Mentor (role key `business_mentor`). The user names their own Mentor on first
login; "Business Mentor" is the catalogue name only.

---

## 0. What it is, in one paragraph

An assistant every workspace gets on every plan. It is the user's guide to Be More Swan, a business
coach that writes and keeps a small set of strategy documents with the user, and the one place that
looks across every *active* assistant's settings, goals and Results and proposes improvements. It
never acts on its own: every change it wants is a proposal card the user clicks, written through the
same endpoint the GUI uses. It can raise a support ticket or an issue report on the user's behalf, and
the platform files technical incidents automatically when something actually fails.

**What makes it different** from the AI-coach products on the market is not the coaching. It's that
the advice is grounded in this workspace's real data and can be carried out by the assistants the user
already has, with their approval. Every phase below should strengthen that; anything that is just
"generic chat about business" is not worth building, because Claude/ChatGPT already do it for ~£20.

### Two ways in

1. **Existing business.** The workspace has Business Information, maybe assistants and some activity.
   The Mentor starts from the gaps (§3.3).
2. **A new idea.** Little or nothing is filled in and the user says they're starting out. The Mentor
   starts with an idea check (§4.1) and builds the business plan from it.

The introduction (§3.1) asks which applies, and checks the offer profile and Products & Services to
suggest the answer.

### What it is NOT

- Not a writer. It does not draft posts, emails or articles. If it did, nobody on the £29 plan would
  hire a second assistant (§2.3). It reviews, critiques and proposes; the role assistants produce.
  Critiquing a draft the user pastes in *is* in scope (§3.6).
- Not in the publish path. It never gates or holds another assistant's draft. It reviews afterwards and
  proposes.
- Not autonomous. No write of any kind without a user click.
- Not chat-only. Every capability is also on a screen, through the same server action (§14).
- Not a financial, legal or tax adviser. It can build a business plan with figures the user supplies or
  agrees; it must say plainly when a question needs an accountant or solicitor.

---

## 1. What is already on the ground

Verified against the working tree, 2026-10-25. The Mentor is mostly *new reading and new prompts over
existing write paths*.

| The Mentor needs | Already exists | Gap |
|---|---|---|
| A role that can be hired, with chat + dashboard | `src/config/assistant-build-manifest.ts` (12 roles), chat `ROUTES` in `netlify/functions/chat-orchestrator.ts`, `src/components/assistant-dashboard-registry.js`, `src/public/assistant-onboarding-schemas.js` | New role in all four; `tests/assistant-go-live.test.ts` pins them |
| Changing an assistant's settings, goals, rules, schedule with approval | `src/utils/chat-assistant-settings.ts`, `chat-goals.ts` (via `goal-connections.ts`), `chat-rules.ts`, `chat-schedule.ts`, `chat-platforms.ts` | See §1.1: the cards can already target another assistant; the Mentor route needs its own validation |
| Changing any set-up answer | Set-up answers save through `update-assistant-context.ts` | No generic card. Only the schedule and platform-switch cards write set-up answers today (§3.4) |
| Knowing every assistant's fields | `SETTINGS_BY_ROLE` (mirrors the registry), onboarding schemas (about 46 questions across 11 roles, plus the Social wizard), `get-assistant-context` | A read-only "workspace snapshot" builder that walks every active assistant |
| Knowing what the team is doing | `src/utils/team-activity.ts` (`<team_activity>`, every chat turn), `src/utils/roi-activity.ts`, Results tab (Goal Progress / Performance / Autopilot) | Nothing new — reuse |
| Knowing the business | Business Information (`org_offer_profile`, `org_products` via `src/utils/org-products.ts`), Brand Knowledge via `src/utils/business-knowledge.ts`, `org_intro_offer`, outreach offer, hooks / call-to-action | A "gaps" checker over these fields |
| Knowing the customers | `revenue_events` (won / lost / disqualified), `audience_contacts` (Won leads land here), `lead_threads` / `lead_messages`, `org_reviews`, `invoices`, `assistant_records` (the Support Agent's tickets) | Read-only customer summary for Phase 3b (§5.2) |
| Strategy reaching every draft | `business-knowledge.ts` is the ONE loader for blueprint §11, blog-generate and chat; `recompileOrgBlueprints()` after asset changes | Approved strategy docs feed that loader (§4.4) |
| Being the user guide | Ask Your Team answers from published `help_articles` only (`src/utils/help-knowledge.ts`) and cites them | Reuse the same block in the Mentor's prompt |
| Handing work to another assistant | Chat hand-offs (`ROUTES[targetRoleKey]`, `orchestration_runs`), Campaign Assistant orders, "Requested by" pills (`src/utils/requested-by.ts`) | Mentor as a requester (§2.2) |
| Support request from chat | `netlify/functions/support-tickets.ts` (POST `{subject, category, description}`, emails the admin inbox, audits) | A proposal card any route can emit (§3.7) |
| Bug report from chat | `issue_reports` + `netlify/functions/issue-reports.ts` (Report an Issue, user-facing) + `admin-issue-reports.ts` + "Pass to Developer" (`admin-issue-handoff.ts`) | Same card, routed by kind (§2.6) |
| Automatic incident reporting | The same `issue_reports` table and admin screens | A hidden, system-only source (§6.2); `issue_reports.user_id` is NOT NULL today |
| Weekly review email | `netlify/functions/weekly-digest.ts` — fixed but deliberately **unscheduled** | Reuse as the delivery vehicle if the owner turns it on |
| Facts with sources | `gatewayGenerateGrounded` in `src/lib/ai-gateway.ts` (Anthropic `web_search` server tool, max 4 searches, URL allow-list from the tool's own results); used by `src/utils/compliance-verification.ts` | Must run as a background job (§1.1) |
| Per-role model choice | Admin ▸ Assistants ▸ Model & rules (`admin-assistants.ts`), `assistant_model_settings`, `src/utils/assistant-model.ts`, `src/config/assistant-prompt-layers.ts`; prices in `src/config/model-options.ts`; new calls go through `adaptForModel()` + `replyText()` | Chat picks it up automatically; the Mentor's background jobs and prompt layers must be registered (§3.11) |
| Metering | `meterInteraction` in `src/utils/task-credit.ts` (chat and helpers), `src/utils/work-metering.ts` (background work), `src/utils/fair-use.ts` | See §1.1 and §2.1 |
| Several people, several workspaces | `user_organisations` (user ↔ org with a role); a user can belong to several orgs | One Mentor per org; who it coaches is decision §2.5 |

**Don't build on:** `pending_actions` / `approve-pending-action.ts`. Nothing writes to it and nothing
renders it. The proposal-card pattern is the human-in-the-loop mechanism.

### 1.1 What checking turned up (2026-10-25)

Earlier drafts of this plan stated these without checking. Each was then checked against the code.

1. **Chat no longer spends tasks.** Since the task-allowance change (`docs/task-metering.md`,
   commit `cdd09975`, cutover planned for 17 October 2026), when the `unified_task_metering` flag is
   on for an org, chat turns and editing helpers are free. They count against a per-org daily
   fair-use limit instead (`fair_use_chat_per_day`, default **300**, in `platform_config`).
   Background work spends weighted tasks. The flag fails closed: if the lookup errors, chat spends a
   task as before. **Staging (read 2026-10-25):** flag `enabled = true`, rollout 100%, switched on
   2026-10-17 05:23, so it applies to every staging workspace (`src/utils/feature-flags.ts`: enabled
   + 100% = everyone). No fair-use rows in `platform_config`, so the 300 / 200 defaults apply.
   **Prod (read 2026-10-25): the same** — enabled, 100%, switched on 2026-10-17 05:34, no fair-use
   rows. So chat is free for every customer today. This changes decision §2.1 completely.
2. **The assistant limit is counted in about eight places, not one.** `src/utils/assistant-capacity.ts`
   (used by `hire-assistant.ts` and `onboarding.ts`), `check-capacity.ts`, `manage-assistant.ts`
   (resume), `release-paused-limit.ts`, `plan-moves.ts`, `beta-ending.ts`, `billing-downgrade.ts`
   (display) and `stripe-webhook.ts`. **On a downgrade, `stripe-webhook.ts` pauses the excess
   assistants**, so an uncounted Mentor would still be paused unless it is excluded there too.
   `checkRoleSwap` (one role switch a month on capped plans) also needs to ignore it. See §2.3.
3. **Plan limits.** Older notes said 500 / 2,500 / 10,000 tasks and £79 or £99 for the middle tier;
   they're out of date. **Staging and prod (both read 2026-10-25) are identical** and match
   `seed/data/master_plans.json`:

   | tier_key | Plan | £/month | Assistant limit | Tasks/month |
   |---|---|---|---|---|
   | `trial` | Free Trial | 0 | **none** | 150 |
   | `beta` | Beta | 0 | 10 | 10,500 |
   | `saver` | The Workflow Saver | 29 | 1 | 600 |
   | `buster` | The Busywork Buster | 69 | **none** | 2,750 |
   | `employee` | The Digital Employee | 349 | 10 | 10,500 |
   | `enterprise` | Bespoke Assistant | 1,199 | none | none |

   Only £29 and £349 have an assistant limit; the trial and £69 plans have none.
4. **The cards can already change another assistant.** Every card builder takes `aiAssistantId`
   and `roleKey` as arguments. Each card carries `assistantId`. The browser posts the card's own
   `ui.assistantId` (`src/components/disruptive-ui-registry.js`), and each endpoint checks the
   assistant belongs to the org. What's missing: the Mentor route must check that the target is in
   the org **and active** before drawing a card; each card must name the assistant it changes; and the
   schedule card replaces the whole `onboarding_context` (GET then PUT), so a stale card can
   overwrite a change made since. That's the same risk the schedule card already has, but more
   likely when the target assistant's page isn't the one open.
5. **Cited research can't run inside a chat turn.** A grounded verification was measured at
   **~124 seconds** (four searches plus reasoning; see `compliance-verification.ts`). A synchronous
   Netlify function is killed at 26 seconds with no body. The Mentor's research must be a background
   job whose answer arrives later in the chat (§4.5).
6. **Model costs.** List prices per million tokens in `src/config/model-options.ts`: Haiku 5.5
   $0.10 in / $0.50 out; Sonnet 5.5 $2 / $10; Opus 5.5 $4 / $20. The per-draft figures quoted earlier
   (Haiku 5.5 ≈ $0.001, Sonnet 5.5 ≈ $0.02 per social draft) come from a 24 October comparison that
   **is not recorded in the repo**, and they're for social drafts, not Mentor turns. A Mentor turn
   carries the workspace snapshot plus the Help Centre block (~12k tokens, cached), so it is
   input-heavy. **The cost per Mentor turn is unmeasured**; Phase 1 measures it before the default
   model is chosen.

---

## 2. Decisions needed from the owner

Each has a recommendation; none is decided.

### 2.1 What does the Mentor cost the customer?

With unified metering on (§1.1 point 1), chat is already free under the daily fair-use limit, so the
question is narrower than it was:

- **(a) Mentor chat:** share the org's daily chat pool (300), or get its own?
- **(b) Mentor background work** (weekly review, strategy drafting, research jobs, audits): spend
  tasks like other background work, or be free?

| Option | Effect |
|---|---|
| **A. Treat it like any assistant** | Chat shares the pool; background work spends tasks (e.g. 1 per weekly review, 1 per research job). No new metering code |
| **B. Free background work, capped** | Chat shares the pool; Mentor background work is free up to a monthly cap (e.g. 4 reviews + N research jobs), then refused. Needs a small per-role exemption in `work-metering.ts` |
| **C. Its own allowance** | A separate Mentor allowance in `master_plans.features`, shown on the pricing page. Most code; clearest to sell |

**Recommendation: A**, now that chat is free. A weekly review at 1 task is about 4 tasks a month
on the £29 plan's 600, and it's honest. On the Free Trial (150 tasks) that's still under 3%.
Revisit if users skip reviews to save tasks.

**✅ Decided 2026-10-25 (owner): A.** Mentor chat shares the org's daily fair-use pool; its
background work spends tasks like any assistant's (1 per weekly review, 1 per research job).

### 2.2 Mentor vs Campaign Assistant — who orchestrates?

The Campaign Assistant already turns one objective into orders for other assistants. A second
"orchestrator" will confuse users and duplicate code.

| Option | Effect |
|---|---|
| **A. Separate layers** | Mentor = *why and what* (strategy, priorities, which assistants, goals). Campaign Assistant = *how and when* (campaigns, orders, dates). The Mentor proposes "run a campaign for X"; if the Campaign Assistant is active the card hands off to it, otherwise it says what hiring it would add |
| **B. Mentor absorbs campaign planning** | One fewer assistant to explain; but it rebuilds orders, ledgers and campaign UI inside the Mentor, and the Campaign Assistant becomes redundant |
| **C. Campaign Assistant becomes the Mentor** | Reuses the most code; but its UI, setup and prompt are built around campaigns, not coaching or onboarding |

**Recommendation: A.** The Mentor never places orders itself. It becomes a requester (it shows up in
"Requested by" pills through a hand-off), and it only hands off to, or points the user at, an
assistant they have active.

**✅ Decided 2026-10-25 (owner): A.** Separate layers; the Mentor never places orders itself.

### 2.3 Plan packaging

The proposal is "£29 = Mentor + one assistant of your choice", and so on up.

1. **Does the Mentor count against the assistant limit?** Recommendation: **no**. Because the limit
   is counted in about eight places (§1.1 point 2), this means **one shared rule**,
   `occupiesSeat(row)`, used by all of them, including the downgrade pause in `stripe-webhook.ts`
   and `checkRoleSwap`, with a test that fails if a new count skips it.
2. **Can it be paused or archived?** Recommendation: it can be **quietened** (no proactive nudges, no
   weekly review) but not removed, since it's the guide and the support route. `manage-assistant.ts`
   refuses pause/archive for this role.
3. **Existing customers:** Recommendation: provisioned automatically on the first visit after launch
   (idempotent, one per org), not by a bulk script. The introduction (§3.1) is shown once.
4. **Is anything plan-gated?** Recommendation: no gating at launch. Gate later on evidence, through
   `master_plans.features`, never in code.
6. **Free Trial and Beta workspaces get it too?** Recommendation: **yes**. A trial is when the guide
   matters most. On the trial's 150 tasks, metering (§2.1) needs to leave room for real work.
7. **"Mentor + one assistant" only describes £29.** On staging and prod only £29 (1) and £349 (10) have an
   assistant limit; Free Trial, £69 and Bespoke have none. So the pitch is "£29 = Mentor + one
   assistant", and on other plans the Mentor is simply included. If the £69 plan is meant to have a
   limit (the pricing page has shown 3), that's a separate pricing fix.
5. **Public copy:** nothing on the pricing page, FAQ or website until Phase 1 is on prod. Help
   articles ship with each phase (§8.3).

**✅ Decided 2026-10-25 (owner): all recommendations above.** Not a seat (one shared `occupiesSeat`
rule); can be quietened, not removed; existing customers provisioned on their next visit; no plan
gating at launch; no public copy until Phase 1 is on prod; Free Trial and Beta get it; the pitch is
"£29 = Mentor + one assistant" and "included" on other plans.

### 2.4 Smaller decisions — ✅ decided 2026-10-25 (owner)

- **Default model: Opus 5.5**, for chat and every background job. See §2.4.1 for what that means
  in practice.
- **Weekly review delivery follows each user's notification settings.** A new notification type
  (e.g. `mentor_weekly_review`) in the existing notification preferences (My Account ▸
  Notifications), with in-app and email switches like the other types. The review always exists in
  the Mentor's chat; the notification only decides how the user is told. Email goes through the
  notification templates, and `weekly-digest.ts` can be reused for the email body if that's
  simpler. It goes to owners and admins by default (§2.5), each according to their own settings.
- **Mentor proposals appear in both** the Mentor's chat and the Inbox "Needs you" list. One card,
  shown in two places, using the same refresh chain (`src/utils/chat-card-refresh.ts`) so a card
  approved in one place shows as done in the other, as Team Chat cards already do.

#### 2.4.1 Opus 5.5 as the default: what to watch

Recorded so the build handles it, not to reopen the decision.

- **Chat speed.** Chat is a request path held to Low thinking, and Opus can't switch thinking off.
  The model-picker test measured Opus at **up to 22.6 s** on a social draft, against Netlify's
  26-second limit. A Mentor turn carries more input (the workspace snapshot plus the Help Centre),
  so it may be slower. §3.9's measurement must report the slowest turns, not just the average. If
  Mentor chat turns come close to the limit, the fix is in code (smaller always-in-prompt snapshot,
  more *on request*), or the owner can switch chat to Sonnet 5.5 on the Model & rules tab in one click
  without a deploy.
- **Cost.** Opus 5.5 is $4 in / $20 out per million tokens, the most expensive option on offer, and
  chat is free to the customer under fair use (up to 300 messages a day per workspace). §3.9 records the
  real cost per Mentor turn; Admin ▸ Assistants ▸ Model & rules shows the running 30-day spend.
- **Background jobs** (weekly review, strategy documents, research) have no 26-second limit, so Opus
  can think at a higher level there.

### 2.5 Several people in one workspace, and people in several workspaces

A user can belong to several orgs (`user_organisations`), and an org can have several members.

| Question | Recommendation |
|---|---|
| How many Mentors? | One per org. It never reads or mentions another org, even when the same user belongs to both |
| Who does it coach? | The workspace. Strategy documents are the org's. Any member can chat; approving a strategy document or a cross-assistant change needs the org role that the same change needs in the GUI |
| Whose commitments? | Each commitment has an owner (a user). The weekly review shows everyone's, and each person sees their own first |
| Who gets the weekly review? | Owners and admins, as `weekly-digest.ts` already does |
| Memory of conversations | Per user, like other chats today. What the whole workspace should know goes into the strategy documents, not the chat |

**✅ Decided 2026-10-25 (owner): all recommendations above.**

### 2.6 Where "this is broken" goes

There are two systems: **support tickets** (`support-tickets.ts`: questions, billing, help, call-back
requests) and **Report an Issue** (`issue_reports`, which feeds Pass to Developer).

**Recommendation:** one proposal card, two destinations. The Mentor (or any assistant) classifies:
something not working → an issue report with the view and assistant attached; anything else → a
support ticket. The user sees which on the card and can switch it before sending.

**✅ Decided 2026-10-25 (owner): agreed.** One card, two destinations. If Report an Issue (described
in code as testing-phase) is retired later, its destination moves to support tickets.

### 2.7 Can a workspace with no paid plan still use the Mentor?

`meterInteraction` refuses chat when an org has no active or past-due plan (a paywall). A lapsed or
cancelled customer would then lose the Mentor, and with it the easiest way to ask for help.

**Recommendation:** with no plan, the Mentor can still answer from the Help Centre and raise a support
ticket or issue report, but proposes nothing else and runs no reviews. That needs a narrow exemption in
the Mentor route.

**✅ Decided 2026-10-25 (owner): agreed.** With no paid plan, the Mentor answers from the Help Centre
and raises support tickets / issue reports only.

### 2.8 Can the Mentor read the other assistants' chat conversations?

**Recommendation: no** (§12.2). It sees what those chats *did* (cards accepted, drafts created, team
activity), not what people typed. In a workspace with several people, one member's chat with the
Social assistant shouldn't surface in another member's Mentor. Reading transcripts would also make
every Mentor turn much bigger.

**✅ Decided 2026-10-25 (owner): agreed.** The Mentor never reads other assistants' chat conversations.

---

## 3. Phase 1 — Guide, gaps and the support route

**Goal:** a new user logs in, meets their Mentor, gets their workspace set up properly, and knows which
assistant to hire next and why. Any assistant can raise a support ticket or issue report.

### 3.0 Before building

- **Mockup:** `docs/mockups/business-mentor-mockup.html`, covering the introduction, gap cards, hire
  recommendation, the Plan tab and the weekly review. The other plans have mockups; this one should
  too.
- **Rubric and test workspaces** (§8.1) written before the prompt, so the prompt is built to pass them.
- **Success measures** (§8.2) wired before launch, so Phase 1a has a baseline.

### 3.0a Phase 1a first, existing subscribers first (adopted §15.2 items 1–2)

Phase 1 ships in two releases. **Phase 1a** goes to the 9 prod workspaces as early as possible, and
everything else waits for what they show us.

| Phase 1a (first) | Phase 1b (after feedback) |
|---|---|
| The role, naming, `occupiesSeat`, model picker entry (§3.1, §3.11) | New-user opening: "existing business or new idea?" (§3.1) |
| **Existing-subscriber health check** (§13), since every current customer is one | Set-up field card (§3.4) |
| Workspace snapshot + data inventory + "What I can see" panel (§3.2, §12, §14) | Who to hire next (§3.5) |
| Gap cards + set-up checklist (§3.3) | Feedback on the user's own draft (§3.6) |
| Support / issue card (§3.7) | |
| Proposal basics: "Why?", dismiss with a reason, at most 3 a week (§3.13) | Approve several at once (§3.13) |
| Quiet mode; no-other-assistants handling (§3.12) | |
| Success measures on Admin ▸ Mentor activity (§8.2) | |

Phase 1a still follows §14: each capability in it ships with both its card and its screen.

### 3.1 The role and the introduction

- New role `business_mentor`: catalogue row (starts Hidden; status only through
  `admin-assistants.ts ?action=status`), manifest entry, chat route, dashboard registry entry with
  its own surface flags. **Do not inherit social defaults**: no Posts, no Calendar, no posting
  schedule. Tabs: Chat, Plan (§4), Results.
- Auto-provisioned per org (§2.3), excluded from every seat count.
- First visit: the Mentor introduces itself and asks for a name, or offers to pick one. The name is
  stored on the assistant row like any assistant's name. Then it asks whether this is an existing
  business or a new idea (§0).

### 3.2 Workspace snapshot (read-only)

`src/utils/mentor-snapshot.ts`, one builder, cached per turn:

- Business Information completeness: offer profile kinds, Products & Services, audience, tone,
  Brand Knowledge assets, intro / outreach offer, hooks, call-to-action.
- Every **active** assistant: role, status, the `SETTINGS_BY_ROLE` snapshot, set-up answers, goals with
  progress, rules count, connections status.
- Plan, task balance and fair-use use (reuse `chat-plan-snapshot.ts` / `task-balance.ts`).
- Team activity (reuse `team-activity.ts`).

It is rendered as a `<workspace>` block in the Mentor's system prompt. Character caps live in the
builder, like `business-knowledge.ts`. **What goes in it, and what is deliberately left out, is §12.**

### 3.3 Filling the gaps

- The Mentor lists what's missing and *why it matters* (e.g. "Products & Services is empty, so none of
  your assistants can mention prices").
- It offers to draft each missing piece and shows the draft on a proposal card. The click writes
  through the existing endpoint (`org-products.ts`, Business Information save, etc.). This also closes
  the known gap that Products & Services can only be added in the GUI; the card is reusable by other
  routes.
- Never invent facts about the business. It drafts from what the user has said and what's already
  saved, and asks for the rest.

### 3.4 Changing any set-up answer (`setup_field_proposal`)

You asked for the Mentor to understand and change *every* field. The existing cards cover settings,
goals, rules, schedule and platform switches, not the ~46 set-up questions.

- A generic card: target assistant, field key, label, current value, proposed value, reason.
- Validates the key and value against that role's onboarding schema on the server.
- Writes through `update-assistant-context.ts`, sending **only the changed key**, merged onto a fresh
  read, so a stale card can't overwrite other answers (unlike the schedule card's whole-object PUT).
- **Coverage list:** a test that walks every role's schema and fails unless each field is either
  changeable by this card or listed as excluded with a reason (e.g. secrets, connection tokens).
  The Social wizard's fields are listed separately.
- Also available on every assistant's own chat, not just the Mentor's.

### 3.5 "Who to hire next"

- A recommendation card: an ordered list of 1–3 roles, each with a reason grounded in the snapshot,
  plus a "See this assistant" link to the catalogue. It does not hire anything itself.
- Only roles that are Live in the catalogue. It respects the plan's assistant limit and says so when
  the next hire needs an upgrade (reuse `check-capacity.ts`'s `nextPlan`).

### 3.6 Reviewing the user's own work

"Here's my sales email, what do you think?" The Mentor critiques pasted text or an uploaded document
against the business's audience, offer and (from Phase 2) approved strategy. It points out what to
change and why. It doesn't rewrite the whole thing; if the user wants a rewrite and the right
assistant is active, it offers a hand-off; if not, it says which assistant would do it.

### 3.7 Support ticket or issue report from any assistant

- A `support_request_proposal` card any route can emit when the user says something is broken or asks
  for help from Be More Swan. It shows the subject, description and destination (§2.6); the click
  POSTs to `support-tickets.ts` or `issue-reports.ts`.
- Context attached on the server: role, assistant id, chat session id, and the source view. **Not**
  database dumps or full prompts (see §6.2 on privacy).
- The user sees the ticket or report and its replies, as they do today. User-requested reports are
  never hidden.

### 3.8 Prompt craft

- An expert-coach section (owner rule: every assistant writes as an expert in its role): validation
  questions, prioritisation (1–3 things a week), and plain disagreement. If it thinks the user is
  heading the wrong way, it says so with reasons, then helps anyway if the user still wants to.
- Help Centre block (`help-knowledge.ts`) for "how do I…" questions, answered only from articles.
- `loadProductsBlock` + `SPECIAL_CATEGORY_RULE` + business knowledge, as every route has.
- Binding honesty rule: no statistic, benchmark or market claim without a source it can show (the
  research job, §4.5). Without one, it labels the point as its own judgement or offers to look it up.

### 3.9 Measure the cost

On staging, run the test workspaces (§8.1) on **Opus 5.5** (the decided default, §2.4) and record,
per turn: tokens, cost (from `ai_usage_log`) and **time, including the slowest turns**. Run Sonnet 5.5
alongside for comparison so the fallback is ready if Opus is too slow for chat (§2.4.1). Record the
results in this document.

### 3.10 Tests

- Data inventory (§12.4): every org-scoped table is classified for the Mentor.
- GUI ↔ chat parity (§14): every capability has both a card and a screen.
- Manifest / go-live drift (existing test picks up the new role).
- `occupiesSeat` used by every seat count; the Mentor is never paused on downgrade.
- Snapshot only includes active assistants; never another org.
- Every proposal card writes through the GUI endpoint, is org-checked, and names its target assistant.
- Set-up field coverage list (§3.4).
- Prompt-surfaces test names the Mentor's real tabs and controls.

### 3.12 When the Mentor is the only active assistant

Owner requirement (2026-10-25): with no other active assistant, the Mentor must handle it gracefully.
This is common: every new workspace starts here, a £29 customer may not have picked their one
assistant yet, and assistants can all be paused.

**Tell apart why there are none**, because the right answer differs:

| Situation | What the Mentor says and does |
|---|---|
| Never hired one | "It's just us for now." Coaching, strategy and the idea check work fully. The hire recommendation (§3.5) becomes its main suggestion, framed as what the user's plan already includes (on £29, one assistant slot is free) |
| Hired, but all paused by the user | Names them and says they're paused; offers to explain what resuming would do. Never resumes anything itself |
| Paused for the task cap or payment | Explains why and when it lifts, links to billing; proposes no new work for them |
| Archived | Treated as never hired, but it may say "you used to have a Blog assistant" if the user asks |

**What changes in its behaviour:**
- **No team cards.** It never draws a card that changes, hands work to or depends on another assistant
  (settings, goals, schedule, set-up fields, hand-offs, campaign proposals). Business Information,
  strategy, commitments, support and research cards all still work.
- **Do-it-yourself steps instead.** Where an assistant would normally do the work, it gives the user
  the steps to do it themselves, and says once, plainly, which assistant would take it on. It doesn't
  repeat that in every reply.
- **The weekly review still runs**, but reviews Business Information, the strategy documents and the
  user's own commitments, not assistant results. With nothing to review, it says so and asks a
  coaching question instead of sending an empty report.
- **Results:** its Results tab shows commitments and plan progress, not empty assistant charts.
- **Prompt:** reuse the existing `NO_TEAMMATES_BLOCK` from `src/utils/team-activity.ts` (what other
  chats already get when they have no teammates), extended with the table above.
- **The moment one is hired or resumed,** the next turn's snapshot includes it and the team cards
  come back. No restart needed.

Covered by the "blank new-idea workspace" test (§8.1), plus a new test workspace whose assistants
are all paused.

### 3.13 How every proposal behaves (adopted §15.2 items 5–8)

Applies to every Mentor proposal, in chat and in Inbox "Needs you", and to the screens in §14.

- **"Why?"** Every card carries a short evidence line naming the figures or records it's based on
  ("14 drafts waiting, oldest 9 days"), each linking to the screen it came from. A proposal with no
  evidence isn't shown. This makes an invented reason obvious, and it's checked by the rubric (§8.1).
- **Dismiss with a reason** from a fixed list: *not relevant*, *already done*, *disagree*, *not now*.
  Stored per proposal type (the `template_feedback` pattern). *Not now* snoozes it for a fortnight;
  *disagree* or *not relevant* stops that kind of proposal for this workspace until something
  material changes. Dismissed proposals are listed on the Mentor page and can be brought back.
- **Approve several at once.** "Review all" opens the proposals together, each with its preview and
  its own tick; one click applies the ticked ones, each through its own server action. Nothing is
  pre-ticked. Any that fail are reported one by one, not hidden.
- **At most 3 proposals a week** per workspace, counting weekly review, audits and nudges together.
  The Mentor picks the three with the most evidence and impact. Answering a question the user asks
  in chat isn't counted.

### 3.11 Model picker

The Mentor must be choosable on Admin ▸ Assistants ▸ Model & rules like every other role.

- **Chat: automatic.** Every role's chat already reads `assistant_model_settings` through
  `loadRoleModel`, defaulting to `CHAT_DEFAULT_MODEL` (Haiku 4.5). Once the `business_mentor` role row
  exists, the page lists it and the chat obeys it.
- **Default = Opus 5.5 (decided, §2.4).** Set it as a `business_mentor` row in
  `assistant_model_settings` on both databases at launch (thinking Low; chat is held to Low anyway),
  rather than changing `CHAT_DEFAULT_MODEL`, which every other role's chat falls back to. The code
  defaults in `ROLE_MODEL_PATHS` for the Mentor's background jobs are also Opus 5.5, so the Mentor
  still runs on Opus if the row is ever removed.
- **Background jobs: register them.** Add a `business_mentor` entry to `ROLE_MODEL_PATHS` in
  `src/config/assistant-prompt-layers.ts` naming each job that uses the role's model, with its code
  default: *Weekly review* (Phase 3), *Strategy documents* (Phase 2), *Research with sources*
  (Phase 2). Each job calls `withRoleModel()` + `adaptForModel()` + `replyText()`. Background jobs
  aren't clamped to Low thinking (only request paths are), so the review can think harder.
- **Research needs a search-capable model.** `gatewayGenerateGrounded` picks the web-search tool
  version from the model id (`webSearchTool()` in `src/lib/ai-gateway.ts`). Confirm every model
  the picker offers works with it, or have the research job fall back to its default when the chosen
  model can't search.
- **Prompt layers.** Add a `MENTOR` list to `BY_ROLE` so the Model & rules tab shows what the
  Mentor's prompt is built from: coaching craft, the source/honesty rule, the Help Centre block,
  active-teammates rule, special-category rule, and the workspace snapshot (listed by name only, as
  for other roles). `tests/assistant-config-view.test.ts` checks each claim against the code.
- **Cost estimate.** The tab's cost estimate reads `ai_usage_log`; it will show real Mentor figures
  once §3.9's measurement has run on staging.

**Done when:** a fresh staging workspace logs in → names the Mentor → fills ≥3 gaps via cards →
changes a set-up answer on another assistant → gets a hire recommendation → raises a test ticket that
reaches the admin inbox and a test issue that appears in Admin → Issues; and Admin ▸ Assistants ▸ Model
& rules lists the Mentor, and switching its model changes the model recorded in `ai_usage_log`.

---

## 4. Phase 2 — Idea check and strategy documents

**Goal:** the Mentor drafts a small set of strategy documents with the user, the user approves them,
and every assistant writes from them.

**Build status (2026-10-25):** items §4.1–§4.5 built on staging; needs `db/z-business-mentor-phase-2.sql`
(`strategy_documents`, `mentor_jobs`) on each database — the code runs without it and says "not switched
on yet". Where things are: `src/utils/strategy-documents.ts` (kinds, sections, versions, diff, pre-fill,
save/approve), `src/utils/break-even.ts`, `src/utils/mentor-jobs.ts` + `netlify/functions/mentor-job-background.ts`
(research and "Draft it for me", 1 task each on delivery), `src/utils/mentor-plan-cards.ts` (chat cards),
`src/components/assistant-mentor-plan.js` (the Plan tab), all through `netlify/functions/mentor.ts`.
Approved business-plan customer/problem/offer and marketing-plan audience/messaging/channels reach drafts
through `business-knowledge.ts` and blueprint §11. Playbooks (§4.6): drafts for `services` and `products`
in `src/config/mentor-playbooks/`, **unreviewed** — the Mentor uses none until the owner sets `reviewed`.
Pre-draft (§13.2) is code, not a model: filled only from saved Business Information, assistants and goals.

### 4.1 Idea check (the "new idea" path)

A structured interview, the way an investor or experienced mentor would question a new idea:

- Who exactly is the buyer? What problem do they have now, and what do they use instead?
- Why would they pay *you*? What would they pay? How will they hear about you?
- What has to be true for this to work, and how could you test it cheaply this month?

Output, on approval: a **Lean Canvas** (the nine standard boxes) and a list of the riskiest
assumptions, each with a cheap test (e.g. "talk to 5 potential customers", "a landing page with a
waiting list"). These become the first commitments (§5.1). The Mentor is plain about weak spots and
doesn't pretend an idea is validated before tests have run.

### 4.2 Documents

Start with two, not four:

1. **Business plan (lean):** who the customer is, the problem, the offer, pricing, channels, the
   90-day milestones, and the numbers the user supplies or agrees. For the new-idea path, built from
   the Lean Canvas.
2. **Marketing plan:** audience, messaging, channels per assistant, cadence, and goals.

Sales and operations plans come later if users ask. Most of what they'd contain lives already in the
Lead Generator and assistant settings.

### 4.3 Break-even calculator

"If I spend £500 on ads, how many sales do I need?" Computed in **code**, not by the model: price,
cost per sale, fixed costs, spend → sales and leads needed at a given conversion rate. The model only
fills in the inputs from the business plan or asks for them, and explains the result. Every input is
shown, so the user can see what's assumed. A conversion rate the user didn't supply is labelled as an
assumption, with a source if the research job found one.

### 4.4 Storage and reaching drafts

New table `strategy_documents` (org, kind `idea_check|business_plan|marketing_plan`, version, status
`draft|approved|superseded`, body as structured JSON sections, approved_by, approved_at). Each approval
creates a new version; old versions are kept. The migration goes on **both** databases before the code;
readers must tolerate the missing table until then.

GUI: a **Plan** tab on the Mentor page that shows the current approved version, the draft, and a diff.
Chat: `strategy_proposal` card (draft / revise a section / approve). Both use the same function.

Approved documents feed `src/utils/business-knowledge.ts`, the one loader. The relevant sections (offer,
audience, messaging) appear in every drafting prompt, and `recompileOrgBlueprints()` runs on approval.
No second loader.

### 4.5 Research with sources (a background job)

Because a grounded search takes ~2 minutes (§1.1 point 5):

- The Mentor offers "Want me to look that up?" → the click queues a `mentor-research-background` job.
- The job calls `gatewayGenerateGrounded`. Only URLs from the search tool's own results are kept;
  any URL the model wrote but didn't find is dropped (the rule `compliance-verification.ts` already
  enforces).
- The answer is posted into the same chat session when it's ready, with its links, and a notification.
- No search ran or nothing was found → it says so. It never fills the gap from memory.
- Metered according to §2.1.

### 4.6 Playbooks by kind of business (adopted §15.2 item 9)

For each of the six offer-profile kinds in Business Information, a short **human-reviewed, sourced
playbook**: what good looks like, the usual first 90 days, common mistakes, and the measures that
matter. Stored as reviewed content (like help articles, through dated files), each claim with its
source.

- The Mentor coaches from the playbook for the workspace's kind, rather than from general knowledge.
  More expert, fewer invented facts.
- Start with the kinds the 9 prod workspaces actually are; add the rest as customers arrive.
- Visible to the user on the Plan tab ("the playbook I'm using"), so the GUI rule holds (§14).
- A playbook is reviewed by a person before it's used; the Mentor never writes or changes one.

**Done when:** a new-idea workspace completes the idea check and a Lean Canvas; the user approves both
plans; a newly queued social draft and a blog draft show the approved messaging; a research job returns
with real, allow-listed links; the break-even calculator matches a hand calculation.

---

## 5. Phase 3 — The weekly review

**Goal:** once a week the Mentor compares reality with the plan and proposes changes the user can
approve in one click each.

- Scheduled per org (metered according to §2.1). Skips orgs at the cap.
- Reads: Results across active assistants (`roi-activity.ts`, goal progress), the approved strategy,
  last week's commitments.
- Writes: a review message in the Mentor's chat with 1–3 proposals, using **existing card types**
  (§1.1 point 4) plus `setup_field_proposal`. Each card names the assistant it changes.
- **Data-sparse by design.** Most workspaces will have too little data for "win rate" style
  conclusions. The strategy-agent plan found 135 leads discovered and 1 ever decided
  (`docs/strategy-agent-plan.md` §0). The review must say "not enough data yet" rather than invent a
  trend, using a minimum sample per metric.
- Delivery: the review always lands in the Mentor's chat; each user is told in-app and/or by email
  according to their own notification settings (`mentor_weekly_review`, §2.4). Its proposals also
  appear in the Inbox "Needs you" list.

### 5.1 Commitments and the end-of-week check

- The user picks 1–3 things to do this week. A small `mentor_commitments` table: org, owner user,
  week, text, status `done|missed|dropped`, `miss_reason`, note. No dependency graph.
- **End-of-week check:** for each missed commitment, the Mentor asks why, using a **closed list**
  (the same approach as `template_feedback`'s edit reasons): *no time*, *didn't know how*,
  *priorities changed*, *waiting on someone else*, *decided against it*, *other* (with a note).
- The reasons are what the Mentor learns from: repeated *no time* → suggest fewer commitments or an
  assistant that would take the work; *didn't know how* → a how-to or a smaller first step;
  *priorities changed* → revisit the plan.

### 5.2 Customers (Phase 3b)

The customer side of "ideation through to selling and managing customers". It only uses data that
exists, and only from assistants that are active:

| Signal | Source | Available when |
|---|---|---|
| Won, lost and why | `revenue_events` | Lead Generator active and deals marked |
| Customer list | `audience_contacts` (Won leads are added here) | Lead Generator or Email Marketing active |
| Last contact with each won customer | `lead_threads` / `lead_messages` | Lead Generator active |
| Customer feedback | `org_reviews` | Review requests in use |
| Overdue invoices | `invoices` | Accounts Receivable active |
| Recurring support problems | `assistant_records` (the Support Agent's tickets) | Support Agent active |

What it offers: a short list of customers not heard from in a while (proposing a check-in, handed to
Email Marketing if active, otherwise a draft the user sends themselves); themes from reviews and
support tickets; and why deals are being lost. With none of these sources, it asks the user about
their customers in the weekly review instead.

⚠️ Don't confuse this with `churn-signals.ts` / `src/utils/churn.ts`. Those are about **Be More Swan's**
customers leaving Be More Swan, not the user's customers.

### 5.3 "What changed because of your Mentor" (adopted §15.2 item 4)

Every accepted proposal is remembered (what changed, when, which assistant, the measure it was meant
to move and its value at the time). Each weekly review reports what happened since, for example
"You shortened the posting schedule 3 weeks ago; engagement is up 12% since". It is honest about
changes that didn't help and about results too small to judge (the minimum-sample rule above).

- Shown in the review, on a **Track record** panel on the Mentor page (§14), and as
  *Requested by: Mentor* pills on the work that resulted (extending `src/utils/requested-by.ts`).
- It says "since", not "because". The Mentor never claims to have caused a change it can't
  separate from everything else that happened.
- Needs a small table (`mentor_outcomes`: proposal, target, measure, before, after, checked_at).

### 5.4 As built (2026-10-26)

- **Tables:** `db/z-business-mentor-phase-3.sql` — `mentor_reviews`, `mentor_commitments`, `mentor_outcomes`
  (idempotent; code tolerates them missing).
- **Review:** `src/utils/mentor-review.ts`. Daily dispatch at 06:45 UTC (`dispatch-mentor-reviews.ts`; staging:
  `run-mentor-review-dispatch` in `staging-crons.yml`), one scheduled review per workspace per week on its
  review day (set-up answers `weeklyReview`, `reviewDay`; Monday by default; a missed day is caught up that
  week), worker `mentor-review-background.ts`. Below the minimum sample it writes "not enough data yet" in
  code with no model call and **no charge**; otherwise 1 task (`mentor_review`). "Review my week now" on the
  Overview tab (owners and admins). Reviews land in every owner's and admin's chat with the Mentor; each is
  told by the new `mentor_weekly_review` notification row (in-app + email).
- **Proposals** reuse the chat's cards and checks (set-up answer, Business Information, Products &
  Services, who to hire, plan revision) plus one new card, `mentor_draft_request`: a post asked of an
  ACTIVE Social Media assistant through "Create a Post" (`generate-post.ts`). That is where *Requested by:
  Mentor* pills come from (`mentor_outcomes.job_id` → `requested-by.ts`); setting changes have no "work"
  of their own to carry a pill.
- **Customers:** `src/utils/mentor-customers.ts`. ⚠️ Correction to §5.2/§12.1: `invoices` is **Be More
  Swan's own billing**, not the business's invoices, so it is `never`; overdue invoices come from the
  Accounts Receivable assistant's `assistant_records` instead. A check-in for a quiet customer is a message
  the Mentor drafts in chat for the user to send (no Email Marketing hand-off yet).
- **Screens:** Overview tab — Reviews, Track record, Customers; Results tab — Commitments.

**Done when:** a staging workspace with real activity gets a review whose proposals each apply
correctly through the GUI endpoint; a workspace with no activity gets an honest "not enough yet"; a
missed commitment records its reason; a workspace with won leads sees its quiet customers.

---

## 6. Phase 4 — Content audits and automatic incidents

### 6.1 Content suggestions

On the weekly review (no extra schedule), the Mentor checks saved content against the approved
strategy, for example a Brand Knowledge doc that contradicts the offer, an empty call-to-action, or
goals with no connected platform (reuse `goal-connections.ts`). It shows proposals, never silent edits.

### 6.2 Automatic incident reports (hidden from the user)

**The trigger is deterministic code, not the model's opinion.**

- Sources: failed background jobs after their last retry, caught exceptions in the write path of a
  proposal card, and a chat turn that errors. Each source calls one helper,
  `src/utils/platform-incident.ts`.
- Writes to `issue_reports` with a new `source = 'system'` column. Because `user_id` is NOT NULL
  today, either make it nullable for system rows or attribute to the org owner and hide system rows
  from `issue-reports.ts`'s user list. Decide in the migration.
- De-duplicated by fingerprint (source + error class + role) per day, and rate-limited per org.
- The admin portal shows them alongside user reports, so Pass to Developer works on them unchanged.
- **Model-suspected issues** ("this looks like a bug") go to the same table at a lower priority, marked
  `suspected`, and are never auto-queued for the developer runner.

**Privacy:** capture the error, role, ids and the view only. No customer content, no full prompts, no
DB state. If more is ever needed, the privacy policy and DPA must say so first (the privacy policy and
trust page already disagree on whether Be More Swan is controller or processor; settle that first).

### 6.3 As built (2026-10-26)

- **Incidents:** `src/utils/platform-incident.ts` → `recordPlatformIncident()`, called from: a social post job
  after its last retry and after the AI-provider park runs out (`process-content-jobs.ts`), a blog job after its
  last retry but **not** a deliberate stop (task cap, assistant gone; `process-blog-jobs.ts` `failJob`), both
  chat error paths (`chat-orchestrator.ts`), a Mentor action (`mentor.ts`), a Mentor job and a weekly review.
- **Migration decision:** `user_id` is made **nullable** (not attributed to the owner). NULL keeps an incident
  out of every user's own list and every status notification (`notifyIssueUser` returns on NULL) and out of
  the Support inbox (its inner join). A CHECK keeps user reports carrying a user. SQL: `db/z-platform-incidents.sql`
  (manual, both DBs). ⚠️ The new columns are deliberately **not** declared in `db/schema.ts`: Drizzle names
  every declared column in an INSERT, so declaring them would break Report an Issue wherever the SQL hasn't run.
  They are read raw behind `incidentColumnsReady()`; until the SQL runs nothing is recorded and nothing breaks.
- **Dedupe / limits:** fingerprint = kind + error class (Postgres code, Error subclass, or the message shape
  with numbers and quoted text removed) + role, one row per UK day, repeats add to `occurrences`. At most 10
  new rows per workspace per day. Stored: error class, a scrubbed 200-character message (no emails, links or
  quoted text), role, ids, view.
- **Admin:** Issue Reports shows an *Automatic ×N* chip and an incident panel; the developer runner gets the
  incident context. `suspected` is supported in the schema and kept out of both bulk hand-offs, but **nothing
  writes a suspected row yet** — no model-suspected path is wired.
- **Content checks:** `src/utils/mentor-content-checks.ts`, on the weekly review. In code (free, also in a
  "not enough data" week, as *Worth fixing in your set-up*): a chosen call to action that can't be used, a
  recorded offer no content assistant uses, an active goal whose platform isn't connected. On the paid review
  only, the model compares up to 3 Brand Knowledge excerpts (600 chars) with the recorded offer and approved
  plan and mentions a clear contradiction. Findings are words with where to fix them — no new card (the call to
  action card belongs to each content assistant's chat, not the Mentor's).

---

## 7. Later, only on evidence

- Data-driven pivots (lead-segment win rates, channel reallocation) once `MIN_SAMPLE` is met. This is
  the Strategy Agent's job and should reuse it, not duplicate it.
- Sales and operations plans.
- Proactive nudges outside the weekly review (risk of noise; wait for usage data).

---

## 8. Quality, admin and rollout

### 8.1 Quality bar

Owner rule: every assistant is judged against what an expert in the role would produce.

**The full rubric (12 lines), the 10 test workspaces and the run log are in
`docs/business-mentor-rubric.md`.** The summary below is the original eight.

**Rubric** (each reply graded pass / fail on what applies):

1. Grounded: uses this workspace's real data; invents nothing about the business.
2. Sourced: every statistic or market claim has an allow-listed link or is labelled as judgement.
3. Prioritised: gives 1–3 next steps, not a list of twenty.
4. Honest: disagrees when the user is heading the wrong way, with reasons, then helps anyway.
5. Within scope: no legal, tax or investment advice; points to the right professional.
6. Active teammates only: never hands off to, or points at, an assistant that isn't active.
7. Human in the loop: every change is a card; never claims something is done before the click.
8. Plain English, and short enough to read on a phone.

**Test workspaces** (fixtures on staging, run before each phase ships and on every model change):
a blank new-idea workspace; a half-set-up sole trader; a busy workspace with 3+ assistants and
activity; a workspace with a bad idea the Mentor should challenge; a workspace that asks for financial
advice; one that asks it to use an assistant it hasn't hired; and one whose assistants are all paused
(§3.12). Results recorded in this document.

### 8.2 Admin side

- Catalogue row on Admin → Assistants like any role; go-live checks apply.
- **Admin → Mentor activity** (per org and in total): introductions completed, gaps filled, cards
  proposed vs accepted vs dismissed (with reasons), reviews run, research jobs, support requests and
  incidents filed.
- **Success measures** (adopted §15.2 item 3), shown at the top of that screen, with the baseline
  taken at Phase 1a launch:
  1. **Is the advice any good?** Proposals accepted ÷ proposals shown.
  2. **Is it getting people set up?** Business Information gaps closed per workspace.
  3. **Does it make a difference?** Goals that moved after an accepted proposal (from §5.3).
  4. **Does it keep people?** Workspaces still active 30 days after meeting the Mentor.
  With 9 workspaces these are read case by case, not as statistics; no targets are set until
  there are enough workspaces to make them meaningful.
- Impersonation stays read-only, as for every assistant.

### 8.3 Help articles

Shipped with each phase so Ask Your Team can answer about it: *Meet your Business Mentor* (Phase 1),
*Asking for help or reporting a problem* (Phase 1), *Your business and marketing plans* (Phase 2),
*Your weekly review* (Phase 3). Through dated help-article files, not the retired seed. The full
checklist, with the knowledge-base and website tasks, is §8.6.

**2026-10-26:** all four written in `db/help-articles-2026-12zzzzzzzz-business-mentor.sql`, inserted
**unpublished** (§8.6: no copy ahead of the product, and Ask Your Team reads published articles only).
Publish them at rollout step 6 with the statement at the foot of that file.

### 8.4 Phone width

Every Mentor card and the Plan tab are checked at phone width with the existing UI harness
(`scrollWidth` vs `clientWidth`, no horizontal scroll) before each phase ships.

**2026-10-26, Phases 1–4 on staging, 375 px, workspace 58:** no horizontal scroll on Chat, Overview,
Results, Plan (Idea check, Business plan, Marketing plan, break-even calculator) or Activity, nor in the
profile drawer. All 13 Mentor card types drawn in the chat column (9 from real history, 4 with long
unbroken text) stay inside it, with nothing clipped.

### 8.5 Rollout

1. Migrations (if any for the phase) applied to **staging and prod** before the code reaches either.
2. Build on staging with the role **Hidden**. Turn it on for test workspaces only, using a
   `business_mentor` feature flag with `allowed_workspace_ids`.
3. Run the test workspaces (§8.1) and the cost measurement (§3.9). Fix until the rubric passes.
4. Help article published (§8.3).
5. staging → main PR. On prod, the role stays Hidden and the flag whitelisted to your own workspace;
   check it end to end there.
6. Set the role Live and widen the flag. Existing orgs get their Mentor on their next visit (§2.3),
   and see the existing-subscriber introduction (§13).
7. Only then: pricing page, FAQ and website copy (§8.6).

**2026-10-26, owner:** steps 1–5 done (merged as #490, checked end to end in workspace 37 on prod). Step 6 changed:
the role **stays Hidden** in the catalogue and only the flag widens (enabled, 100%). Setting it Live would send the
in-app "new role available" notification and waitlist emails (role-launch-notify.ts) and show a Hire button for a
role every workspace already has; provisioning (mentor-provision.ts) never needed it. The four help articles are
published with it.

### 8.6 Saved for later: knowledge base, help articles, website

Not part of any build phase. Each item is done **after** the phase it describes is live on prod, never
before (the public copy must not run ahead of the product).

**Knowledge base** (what Be More Swan's own assistants and admin screens know about the product):
- [ ] Catalogue copy for the Mentor (`master_assistants` row and the DB-driven assistant content):
      description, what it does, what it doesn't.
- [ ] Ask Your Team: route "help me plan my business / what should I do next?" questions to the
      Mentor, and stop it handing off to any assistant the user hasn't got (the Mentor is always there).
- [ ] Every other assistant's prompt: they may point the user at the Mentor for strategy or support,
      since it's always active.
- [ ] Admin ▸ Assistants ▸ Model & rules shows the Mentor's prompt layers (§3.11).
- [ ] This document: record decisions, measured costs and test results as each phase lands.

**Help articles** (dated help-article files only; the old seed is retired):
- [ ] *Meet your Business Mentor* (Phase 1): naming it, what it can see (from §12, in plain words),
      that it never changes anything without your click.
- [ ] *Asking for help or reporting a problem* (Phase 1): from any assistant's chat.
- [ ] *Changing your assistants' settings from chat* (Phase 1): the set-up field card.
- [ ] *Your business and marketing plans* (Phase 2): idea check, Lean Canvas, the Plan tab,
      break-even calculator, research with sources.
- [ ] *Your weekly review and commitments* (Phase 3).
- [ ] Update existing articles that describe plans and assistant limits ("£29 = Mentor + one
      assistant", decision §2.3).

**Website:**
- [x] **First: check the competitors** (adopted §15.2 item 10). Done 2026-10-26 (web search; vendor pages and
      third-party reviews, prices change often):

      | Product | What it is | Price found | Does the work too? |
      |---|---|---|---|
      | MentorMe | Not found under that name. Nearest: "Mentor AI: Business Coach" (iPhone chat app) | Credits, $0.99 per 1,000 | No |
      | Foundra (foundra.ai) | Guided "AI co-founder": validate an idea in 3 phases, strategy cards, free idea tools | $39/month, 3-day trial | No: strategy only |
      | GhostCoach | Not found. Nearest: small "AI Business Coach" apps (assessments, accountability) | Unknown | No |
      | iTrepreneur | Only a 2026 Canadian chamber event listing; no product page | Unknown | Unknown |
      | CoachHub AIMY | AI career/leadership coach sold to employers | Quote only | No: employee coaching |
      | BetterUp | Human + AI coaching for employees; individual plans closing (2026) | Enterprise quote; individual ~$71–279/month, third-party figures | No |
      | **Sintra** (not named by Gemini) | 12 AI "helpers" incl. **Buddy** (strategy and planning) beside social, email and others, sharing one "Brain AI" | ~$97/month all helpers; single helpers discontinued | **Yes, partly**: strategy and execution helpers in one product. One review says helpers "don't run autonomously. You initiate each task". No source says Buddy reviews the other helpers' work. |

      **What this backs:** pairing a strategy coach with AI workers is NOT new (Sintra), so no "first", "unique" or
      "disruptive" claim, and no named competitor comparison. **What we can say, because the code does it:** a
      Business Mentor is included on every plan and takes no assistant place; it reads what your team actually did
      (results, goals, drafts) and suggests changes to them that only happen when you approve; a weekly review with
      up to 3 suggestions; plans, a break-even calculator and sourced research; it never sees passwords, card
      details or your contacts' personal details.
- [ ] Public assistant page for the Mentor (the showcase pages: JSON → generated SQL, no real
      personal data).
- [ ] Pricing page: plan cards and comparison table (Plan Features rows in the DB, not hard-coded),
      including "Business Mentor included" on every plan.
- [ ] FAQ: what the Mentor is, whether it costs tasks (decision §2.1), what it can see.
- [ ] Homepage / marketing pages: only claims that are live (§9's last risk).
- [ ] Privacy and trust pages, if the automatic incident reports (§6.2) collect anything new.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| It becomes a free general chatbot | Shares the daily fair-use pool; the prompt keeps it on this business and this platform |
| It cannibalises paid assistants | No drafting (§0); "who to hire next" is a feature, honestly framed |
| Made-up facts and benchmarks | Binding source rule; research job with URL allow-list; "my judgement" label; break-even maths in code |
| Two orchestrators confuse users | Decision 2.2 |
| Changes another assistant the user didn't expect | Every card names the target assistant; GUI endpoint; org and active checks; nothing without a click |
| A stale card overwrites a newer change | `setup_field_proposal` sends only the changed key, merged on a fresh read |
| Points the user at an unhired assistant | Snapshot holds only active assistants; prompt rule; test |
| Empty or broken experience with no other assistants | §3.12; its own test workspace |
| Opus 5.5 chat turns near the 26 s limit, or costly | §2.4.1: measure slowest turns in §3.9; shrink the snapshot or switch chat to Sonnet 5.5 on the Model & rules tab |
| The Mentor gets paused on a downgrade | One `occupiesSeat` rule in every seat count, with a test |
| Weekly review costs add up | Runs once a week, skips orgs at the cap; default model chosen from measured cost |
| Incident noise | Deterministic triggers, fingerprint de-duplication, `suspected` kept separate |
| Leaks between workspaces | One Mentor per org; snapshot is org-scoped; test |
| Marketing runs ahead of the build | No public copy until Phase 1 is on prod (§8.5 step 7) |

---

## 10. Build order summary

| Phase | Ships | New tables / columns | Depends on |
|---|---|---|---|
| 1a | Mockup, rubric, success measures; role, naming, existing-subscriber health check (§13); snapshot, data inventory, "What I can see"; gap cards + checklist; support/issue card; "Why?", dismiss reasons, 3-a-week cap; quiet mode; no-assistants handling; `occupiesSeat`; model picker; cost measurement | `mentor_proposals` (shown / accepted / dismissed + reason; feeds §3.13 and §8.2) | All §2 decisions (made) |
| 1b | New-user opening, set-up field card, who to hire next, draft feedback, approve several at once | none | Feedback from 1a |
| 2 | Idea check + Lean Canvas, business and marketing plans, Plan tab, break-even calculator, research job, playbooks (§4.6), feed into drafts | `strategy_documents` | Phase 1b |
| 3 | Weekly review, cross-assistant cards, commitments + end-of-week check, track record (§5.3); 3b customers | `mentor_commitments`, `mentor_outcomes` | Phase 2 |
| 4 | Content audits, automatic incidents | `issue_reports.source` (+ fingerprint) | Phase 3 for audits; incidents can go any time |

---

## 11. SQL to run before deciding

These read the live settings this plan depends on. Run on **staging and prod** separately.
**Both run 2026-10-25**; staging and prod returned the same values (results in §1.1 points 1 and 3).

```sql
-- Plan limits and prices (the seed file doesn't set these columns; the DB is the truth)
SELECT tier_key, name, monthly_price_gbp, assistant_limit, monthly_task_limit
FROM master_plans
ORDER BY monthly_price_gbp;

-- Is the single task allowance on? (decides §2.1)
SELECT key, enabled, rollout_percentage, allowed_workspace_ids, allowed_tiers, updated_at
FROM feature_flags
WHERE key = 'unified_task_metering';

-- Daily fair-use limits (defaults 300 chat / 200 helpers if no row)
SELECT key, value, updated_at
FROM platform_config
WHERE key IN ('fair_use_chat_per_day', 'fair_use_helpers_per_day');
```

---

## 12. What the Mentor can see, and what it can't

The aim: everything a good business coach would ask to see, nothing it doesn't need. Two rules decide
the borderline cases: **it never sees a secret**, and **it sees what an assistant did, not private
details of people**.

**How it reads:** a small **always-in-prompt** summary (marked *Always* below), plus **detail on
request** (*On request*) that it pulls only when the conversation needs it, so turns stay small.
Phase 1 must check whether the chat route can fetch detail mid-turn. If not, *On request* items load
by topic, the way other routes add blocks for posts or leads.

Table names below were checked against the code; where a table name wasn't checked, the item names
the screen instead.

### 12.1 What it sees

| Area | What | How |
|---|---|---|
| **The business** | Name, description, audience, tone (`organisations`); what it offers (`org_offer_profile`); Products & Services (`org_products`); intro offer (`org_intro_offer`); outreach offer; hooks and call-to-action | Always |
| | Brand Knowledge documents and links, through `business-knowledge.ts` (same caps) | Always (capped) |
| | Inspo: titles and notes | On request |
| **The team** | Every **active** assistant: name, role, status, set-up answers (`onboarding_context`), the settings snapshot (`SETTINGS_BY_ROLE`: posting schedule, draft horizon, review cadence…), which platforms are connected and switched on (never the tokens) | Always |
| | Paused or archived assistants: name and status only, so it can say "your Blog assistant is paused". It never hands work to them | Always |
| | Goals: target, date, progress (`goals`) | Always |
| | Rules: rule text, which assistant, on or off (`content_rules`) | On request |
| | What the team did in the last 14 days and what's booked next (`team-activity.ts`) | Always |
| **The work** | Social posts, blog articles and emails: counts by status, recent titles or first lines, platform, dates, rejection reasons; campaigns and their orders; who asked for what ("Requested by") | Counts always; items on request |
| | **Waiting for you**: drafts and decisions waiting for review (often the single most useful thing to coach on) | Always |
| **Results** | Goal Progress, Performance and Autopilot figures (`roi-activity.ts`, the Results tab) | Always |
| **Leads and sales** | Lead counts by stage (`discovered_leads`); won / lost / disqualified and why (`revenue_events`); why leads were rejected (`lead_reject_feedback`); outreach edit reasons (`template_feedback`); the ideal customer profile | Counts always; items on request |
| **Customers** | Customer and audience counts and segments (`audience_contacts`, `audience_segments`); reviews: rating and text (`org_reviews`); review requests sent | Counts always; reviews on request |
| | Won customers not heard from lately: name, company, last contact date (from `lead_threads` / `lead_messages`) | On request (Phase 3b) |
| | Overdue invoices: count and total (`invoices`, when Accounts Receivable is active) | Always, if active |
| | Support Agent tickets: themes and counts (`assistant_records`) | On request |
| | Open meeting action items (`action_items`), when the Meeting Note Taker is active | On request |
| **Plan and usage** | Plan, assistant limit, tasks used this month, daily fair-use use, next plan up (`chat-plan-snapshot.ts`, `task-balance.ts`) | Always |
| **Help** | Published Help Centre articles (`help-knowledge.ts`) | Always (cached) |
| | The user's own support tickets and issue reports, with status (`support_tickets`, `issue_reports`) | On request |
| **Its own** | Strategy documents, commitments and miss reasons, its own chat history with this user | Always |

### 12.2 What it can't see, and why

| Not visible | Why |
|---|---|
| **Secrets**: OAuth tokens, vault keys, API keys, connection credentials, passwords | Never needed to coach; a leak through a model reply would be serious |
| **Any other workspace**, even when the same person belongs to both | Workspace isolation |
| **Other assistants' chat conversations** | Decided (§2.8): it sees what they did, not what people typed |
| **Other members' personal details** beyond name and role: email, login history, IP addresses (`login_events`) | Not needed; personal data |
| **Audience contacts' personal details**: email addresses, phone numbers, consent records (`audience_consent_events`) | It coaches from counts and segments; no need to hold contact details |
| **Full inbound emails and lead message bodies** | Size and privacy. It sees thread counts and last-contact dates; the Lead Generator handles the content |
| **Full meeting transcripts** | Size and privacy. It sees summaries and action items |
| **Images, video and audio themselves** | It sees captions and descriptions. Reviewing visuals is a later decision |
| **Special category data** (health, religion, etc.) | `SPECIAL_CATEGORY_RULE` applies as in every prompt |
| **Billing internals**: Stripe ids, card details, invoices from Be More Swan | It sees the plan, limits and usage, which is all it needs |
| **Be More Swan's own internals**: audit logs, admin notes, system incident rows, feature flags, platform settings, model costs (`ai_usage_log`), other roles' system prompts | Not the customer's data |
| **What Be More Swan thinks about the customer**: churn signals about this workspace (`churn.ts`), admin flags | It must never tell a customer "you're at risk of leaving" |
| **Compliance reviews** (`bias_audit_reviews`) and raw lead-search data | Internal |
| **The old approval queue** (`pending_actions`) | Nothing writes to it |

### 12.3 Data that may be missing, and must not be read as "zero"

- **Facebook and Instagram figures:** Meta App Review is still pending, so customers can't connect
  them. No numbers there means *not connected*, not *no engagement*.
- **Any assistant that isn't active:** no data from it means it isn't hired, not that nothing happened.
- **New workspaces:** everything is thin. The Mentor says "not enough data yet" (§5).

### 12.4 Keeping this list true

A test (Phase 1) walks every org-scoped table in `db/schema.ts` and fails unless each is listed in a
Mentor inventory as *always*, *on request* or *never*, with a reason for *never*. A new table then
forces a decision, rather than being quietly visible or quietly missing. The inventory is also the
source for the *Meet your Business Mentor* help article (§8.6), so the article can't drift either.

---

## 13. Existing subscribers: how it appears and what it says

Same Mentor, same rules, same engine. What differs is **where it starts**. A new workspace starts
with an introduction and questions; an existing one starts with what the Mentor already knows.

### 13.1 How it appears

| | New workspace | Existing subscriber |
|---|---|---|
| When | Created with the workspace | On the first visit after launch (§2.3); one per org, idempotent |
| Where | On the team, first in the list | On the team, first in the list, with a "New" badge until they open it |
| Announcement | Part of sign-up | One Inbox message ("Meet your Business Mentor") and a notification. No pop-up that blocks the page. An email announcement is an outward-facing step for the owner to approve separately |
| Who sees it | Every member | Every member; the announcement goes to owners and admins |
| Seat | Not counted (§2.3) | Not counted. Nothing they already have is paused or changed by its arrival |

### 13.2 What it says first

**New workspace** (§3.1): introduces itself → asks for a name → asks "existing business or new
idea?" → fills gaps or starts the idea check → strategy → who to hire.

**Existing subscriber:** introduces itself → asks for a name (skippable) → **a short health check from
their real data**, instead of questions they've already answered. For example:

> I've looked over your workspace. Three things stand out:
> 1. 14 drafts are waiting for your review, the oldest from 9 days ago.
> 2. Products & Services is empty, so none of your assistants can mention prices.
> 3. Your Social assistant's goal of 500 followers by December is behind: 120 so far.
>
> Want me to start with the drafts, or would you like me to draft a business plan from what's
> already in your workspace?

Then it differs in four ways:

1. **It doesn't re-ask.** Anything already in Business Information or an assistant's set-up is used,
   not asked again. Questions are only for real gaps.
2. **Strategy documents are pre-drafted.** There's enough in the workspace to draft the business and
   marketing plans from existing information. The user reviews and corrects, rather than starting
   with an interview. The idea check (§4.1) is offered only if they say they're starting something
   new.
3. **Hiring advice respects what they have.** It doesn't recommend hiring unless there's a clear gap.
   On £29, where the one assistant slot is taken, it says honestly that another assistant needs an
   upgrade or a swap, and that it's their call.
4. **It points to what's already there.** It knows their assistants, goals and campaigns, so its first
   suggestions use existing cards (adjust a goal, change a schedule) rather than starting anything new.

### 13.3 Special cases

| Situation | What the Mentor does |
|---|---|
| An assistant set-up left half-finished (an onboarding draft exists) | Offers to pick up where they left off |
| Campaign Assistant already active | Sends campaign-shaped proposals to it (§2.2) |
| Paused for hitting the task cap, or paused for payment | Explains why and what will happen, links to billing; proposes no new work |
| No paid plan (lapsed or cancelled) | Help Centre answers and support only (decided, §2.7) |
| On the Free Trial | The same as a new workspace, plus when the trial ends and what happens then |
| Beta workspace with an end-of-beta date | Explains the date and the choices, using the end-of-beta notice the workspace already has |
| Several members | Each person gets their own conversation; the health check describes the workspace, not one person |
| No other active assistant | §3.12: no team cards, do-it-yourself steps, hire recommendation leads |

### 13.4 How it's built

One engine with a **starting-point check** in the snapshot (§3.2): roughly, has Business Information,
at least one active assistant, and some activity. The check picks the opening (introduction vs health
check) and whether strategy documents start as an interview or a pre-draft. The health check is shown
**once**; after that, the weekly review (§5) takes over, so existing customers don't get nagged.
Covered by the test workspaces in §8.1 (the "busy workspace" is the existing-subscriber case).

---

## 14. Every capability through both the GUI and chat

Standing owner rule: every assistant capability is reachable **both** from a screen and by chatting,
through **one server action**. Chat proposes a card; the user's click writes. Both ship in the
**same commit**, and a chat path is never deferred quietly.

Checked 2026-10-25: earlier drafts of this plan left **twelve capabilities without a screen** (marked ⚠️).
Each now has its screen below, and these screens are part of the phase that builds the capability.

| Capability | Phase | Chat | Screen (GUI) |
|---|---|---|---|
| Name the Mentor | 1 | Asks on first visit | Rename on the Mentor page, like any assistant |
| Fill Business Information gaps | 1 | Proposal cards (§3.3) | Existing Business Information pages, plus a ⚠️ **"Set-up checklist" card** on the Mentor page listing the same gaps, each linking to its field |
| Change another assistant's setting, goal, rule, schedule or set-up answer | 1 / 3 | Existing cards + `setup_field_proposal` | That assistant's own page (existing) |
| ⚠️ Who to hire next | 1 | Recommendation card | **"Recommended next" panel** on the Mentor page and a "Recommended" badge in the assistant catalogue, from the same function |
| ⚠️ Feedback on the user's own draft | 1 | Paste into chat | **"Get feedback" box** on the Mentor page (paste text or upload a document); the result shows inline |
| Ask for help / report a problem | 1 | `support_request_proposal` card | Existing support page and Report an Issue button |
| ⚠️ Quieten the Mentor (no nudges, no weekly review) | 1 | Settings card (`chat-assistant-settings.ts`, new Mentor row in `SETTINGS_BY_ROLE`) | Mentor page settings, a **"Quiet mode" switch** |
| ⚠️ "What can my Mentor see?" | 1 | Answers from the inventory (§12.4) | **"What I can see" panel** on the Mentor page, generated from the same inventory |
| ⚠️ Idea check | 2 | Interview in chat | **Step-by-step form** on the Plan tab with the same questions; answers saved to the same draft, so the user can switch between chat and form mid-way |
| Strategy documents (draft, revise, approve) | 2 | `strategy_proposal` card | Plan tab: view, edit, diff, approve |
| ⚠️ Lean Canvas | 2 | Drafted and revised in chat | **Editable nine-box canvas** on the Plan tab |
| ⚠️ Break-even calculator | 2 | Asks for inputs, explains the result | **Calculator** on the Plan tab (same code function; every input editable) |
| ⚠️ Research with sources | 2 | "Want me to look that up?" | **"Look this up" button** beside any claim in the Plan tab, and a **Research** list showing past results with their links |
| ⚠️ Weekly review | 3 | Arrives in chat | **Reviews** list on the Mentor page (every past review, its proposals and what was approved), plus review day and on/off in settings |
| Notification settings for the review | 3 | Existing review-notification card gets the `mentor_weekly_review` type | My Account ▸ Notifications |
| ⚠️ Commitments and miss reasons | 3 | Set and checked in chat | **Commitments list** on the Mentor Results tab: tick done, pick a reason from the same list |
| ⚠️ Quiet customers / customer themes | 3b | On request in chat | **Customers panel** on the Mentor page |
| Content suggestions | 4 | Proposals in chat | Inbox "Needs you" (decided, §2.4), on the same card |
| "Why?" evidence on a proposal | 1a | Line on the card | The same line on the card in Inbox and on the Mentor page, each link opening its screen |
| Dismiss a proposal with a reason; bring one back | 1a | Dismiss button + reason on the card | **Dismissed** list on the Mentor page, with "Bring back" |
| Approve several at once | 1b | "Review all" in chat | "Review all" in Inbox "Needs you" and on the Mentor page |
| See the playbook in use | 2 | Asks which playbook it's using | **Playbook** section on the Plan tab |
| Track record (what changed since) | 3 | In the weekly review | **Track record** panel on the Mentor page |
| Hand work to the Campaign Assistant | 3 | Hand-off card | The same card in Inbox "Needs you", and "Send to Campaign Assistant" on a proposal |

**Not customer capabilities, so the rule doesn't apply:** automatic incident reports (§6.2: system
only, hidden by design) and the model picker (§3.11: admin only, on the admin screen).

**How each pair is built** (as for every assistant):
- One server action per capability; the screen and the card both call it.
- After a write, dispatch a `document` event so an open page repaints (as `assistant:settingsChanged`
  does today).
- The Mentor's system prompt names the real screen and button for each capability, so it can say
  "or use the calculator on your Plan tab".
- A parity test lists every row above and fails if a capability has a card but no screen, or a screen
  but no card. The prompt-surfaces test pins the screen names the prompt uses.

---

## 15. Review: is it disruptive, and how could it be better?

Written 2026-10-25, after all §2 decisions. **✅ Owner 2026-10-25: improvements 1–10 adopted** (each
now written into the phase that builds it, shown in brackets); **11 and 12 kept for later.**

### 15.1 Verdict

**Disruptive in design, unproven in practice.**

What genuinely is different:
- **Grounded and connected.** Standalone AI coaches give advice from what you type. This one reads
  the workspace and can change it through the assistants, with a click. That gap ("the advice stops
  at the advice") is real.
- **Honest by construction.** Sources only from real searches, maths in code, "not enough data"
  instead of invented trends, and it never sees or acts on secrets. Most AI coaching products don't
  hold themselves to this.
- **Included, not sold.** A coach on every plan, including the £0 trial, removes the
  price objection the market charges for.

What weakens it today:
- **The data is thin.** Prod has **9 workspaces** (read 2026-10-25), and the strategy-agent plan found
  1 lead ever decided. "Grounded in your data" means little where there's little data. At launch, its
  real value is **getting people set up and active**, not data-driven strategy.
- **Every current customer is an existing subscriber.** The launch audience is the §13 path, but the
  plan is ordered around the new-user path.
- **It's big.** Four phases, ~19 screen/chat pairs, three new tables. With 9 workspaces, feedback
  should come before most of that is built.
- **No measure of success.** The plan says how to build it, not how you'd know it worked.
- **Unverified competitors.** The Gemini list (MentorMe, Foundra, GhostCoach…) still hasn't been
  checked; the "disruptive" claim is relative to a market we haven't looked at.

### 15.2 Improvements (1–10 adopted; 11–12 later)

Where each adopted item now lives: 1 → §3.0a and §10; 2 → §3.0a; 3 → §8.2; 4 → §5.3; 5–8 → §3.13;
9 → §4.6; 10 → §8.6.

1. **Ship a thin "Phase 1a" first:** the existing-subscriber health check (§13.2), gap cards, the
   support card, the "What I can see" panel and the model-picker entry. That's enough to put in front
   of the 9 prod workspaces and learn, before building the set-up field card, critique and the rest.
2. **Lead with the existing-subscriber path** (§13) in Phase 1, since that's every current customer;
   the new-user path follows straight after.
3. **Define success up front**, and show it on Admin ▸ Mentor activity (§8.2):
   - proposals accepted ÷ proposals shown (is the advice any good?);
   - gaps closed in Business Information (is it getting people set up?);
   - goals that moved after an accepted proposal (does it make a difference?);
   - workspaces still active 30 days after meeting the Mentor (does it keep people?).
4. **"What changed because of your Mentor."** Each accepted proposal is remembered, and the weekly
   review shows what happened afterwards (e.g. "you shortened the posting schedule; engagement rose
   12%"). Extends the existing "Requested by" pills to *Requested by: Mentor*. A coach that shows its
   own track record, honestly including when a change didn't help, is the most disruptive part and
   costs little.
5. **Show the evidence on every proposal.** A "Why?" line on each card naming the numbers and records
   it's based on, each linking to the screen it came from. Builds trust and makes invented reasons
   obvious.
6. **Dismiss with a reason.** Each proposal can be dismissed with a reason from a short fixed list
   (*not relevant*, *already done*, *disagree*, *not now*). Fewer repeats; the Mentor learns what this
   user won't do. Same pattern as `template_feedback`.
7. **Approve several at once.** "Review all 3" opens the proposals together, each with its preview and
   its own tick; one click applies the ticked ones. Fewer clicks, still nothing without the user's
   say-so.
8. **At most 3 proposals a week** (weekly review plus audits combined), so it never becomes another
   inbox to clear.
9. **Curated playbooks per kind of business.** For each of the six offer-profile kinds (§1), a short,
   human-reviewed, sourced playbook (what good looks like, typical first 90 days). The Mentor coaches
   from it instead of from general knowledge: more expert, fewer invented facts. Start with the kinds
   the 9 prod workspaces actually are.
10. **Check the competitors** before any public claim of being disruptive, and write the result into
    this plan.
11. **Later, with consent and enough workspaces:** anonymised comparisons ("businesses like yours
    usually post 3 times a week"). A real data advantage, but not with 9 workspaces, and it needs the
    privacy policy and DPA updated first.
12. **Later:** a voice weekly check-in, using the existing SwanSpeech microphone (not yet working in
    Edge).
