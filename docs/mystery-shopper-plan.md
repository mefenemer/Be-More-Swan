# Mystery Shopper Assistant — Plan

Added 2026-10-14, from an external proposal ("AI Mystery Shopper / Conversion & Positioning Critic")
reviewed against the code as built. Status: **steps 1–3 built 2026-10-14.** Step 1 = page reader + score (`site-extract.ts`,
`site-score.ts`). Step 2 = tables (`db/z-mystery-shopper.sql`, applied to staging 2026-10-14),
pipeline (`site-audit.ts`, `site-audit-prompts.ts`), worker, API (`site-audits.ts`), notification,
task kind. Step 3 = the hired role: catalogue row (`db/z-mystery-shopper-role.sql`, inserted
HIDDEN), set-up questions → audit bridge (`site-audit-setup.ts`, from update-assistant-context.ts),
chat route + snapshot + three cards, Website tab (`src/components/assistant-site-audit.js`), KPI
cards, dashboard strip, Calendar (past checks), Activity, goal metric `site_health_score`, Rules
reach chat AND rewrites (rulesScope 'audit'). Tests: `site-audit*.test.ts`,
`mystery-shopper-wiring.test.ts`. Step 4 built 2026-10-14: daily dispatcher (`site-audit-schedule.ts`; Netlify schedule
`dispatch-site-audits` 06:30 UTC on prod, `run-site-audit-dispatch` in staging-crons.yml) — due on
the audit's UK check day, or after 7 days without a check; competitor-change and goal-met
notifications; fixes verified only against their own page (`db/z-mystery-shopper-weekly.sql` adds
`site_audit_fixes.page_url`, **apply before deploy**); changing the page restarts its scores; hand-offs
open the other assistant's chat with the brief typed in (tab + `site_audit_handoff` card); stalled
accepted fixes (7 days) offer a social post meanwhile; next check on the Calendar. Not built from the
original proposal: an "emergency" competitor re-check between weekly checks (it would need hourly
polling of every competitor — a cost with no buyer yet). Step 5 built 2026-10-14: public
taster — `mystery-shopper.html` (footer link, sitemap, build list, 5 locales), `site-audit-public.ts`
(kill switch → honeypot → per-IP 5/h + per-email 3/day → 24h same-page cache → daily cap
`SITE_TASTER_DAILY_CAP`, default 300 → background run), `site-taster.ts` (token = HMAC of run id with
`SITE_TASTER_SECRET`, falling back to `CRON_TRIGGER_SECRET`), result email `site_taster_result`
(transactional, once). The email address is never stored (hash only); nobody is added to a list —
the page's button becomes "Join the waitlist" (role pre-picked) while sign-ups are locked. No new SQL.
Steps 6–7 (go-live, marketing) not started. Nothing else below
exists unless marked ✅ (already built, reused).

Followed by [website-assistant-plan.md](./website-assistant-plan.md) — the Mystery Shopper is the
front door; the Website Assistant is what fixes what it finds.

Related: [brand-designer-plan.md](./brand-designer-plan.md) (format this doc follows),
[campaign-orchestrator-plan.md](./campaign-orchestrator-plan.md) §9.0 (GUI/chat parity),
[form-builder-plan.md](./form-builder-plan.md), the onboarding checklist (memory
`assistant-onboarding-checklist`).

---

## 1. Requirements (from the user)

1. Very simple, highly sought after, buildable and marketable **immediately**.
2. Zero setup friction: a website URL (plus optional competitors) is enough for first value.
3. A wide, compelling marketing narrative — this assistant is primarily an **acquisition and
   awareness** engine, and secondarily a retained subscription.
4. Recurring value (weekly loop), not a one-off audit.
5. Hands work to the existing assistants instead of leaving the founder to fix things alone.
6. GUI and chat parity (memory `assistant-gui-chat-parity`).

## 2. What already exists — reuse, do not rebuild

| Proposal asks for | Already built ✅ | Where |
|---|---|---|
| "Simple HTTP scraper" | SSRF-hardened fetch (DNS pinning, redirect re-checks, size + time caps) | `src/utils/safe-fetch.ts` (`safeFetchText`) |
| Cheerio extraction | cheerio already a dependency; pure harvest-then-classify pattern | `src/utils/brand-extract.ts` (+ `brand-extract-fetch.ts`) |
| Brand palette from the site | Website → brand kit extraction | `brand-extract.ts`, `organisations.brand_kit` |
| Public endpoint rate limiting | Postgres sliding-window limiter | `src/utils/rate-limit.ts`, `netlify/edge-functions/rate-limit.ts` |
| Long model work without timeouts | `-background` function + 202 + poll pattern | memory `blog-ai-draft-never-worked-in-prod` |
| Charging for the work | Task metering: ask before, record after, fail open | `src/utils/work-metering.ts` |
| SMART goals + auto-tuning | Goal metrics registry, goal optimiser, telemetry | `src/config/goal-metrics.ts`, `autonomous-goal-optimizer.ts`, `manage-goals.ts` |
| Cross-assistant hand-off | Orchestration hand-offs; target role decides the artifact | `src/utils/orchestration.ts`, memory `orchestration-target-role-decides-artifact` |
| HITL approvals | `pending_actions` + approve endpoint + digest | `approve-pending-action.ts`, `get-pending-actions.ts` |
| Products the business sells | Org product library, one loader | `src/utils/org-products.ts` (`loadProductsBlock`) |
| Weekly schedule | Netlify scheduled functions (prod) + `staging-crons.yml` poke | `netlify.toml`, `.github/workflows/staging-crons.yml` |
| A competitor role in the catalogue | `competitor_intel_analyst` — comingSoon, **nothing built** behind it | `db/seed-catalog.ts` |

So the engine is mostly here. What is missing: page **extraction into a structured payload**, the
**scoring**, the **audit/run tables**, the **role wiring** (schema, route, dashboard), the **public
teaser**, and the **weekly loop**.

## 3. Where the proposal is changed — and why

1. **Scores are computed in code, not by the model.** The proposal has each sub-agent return
   `clarity_score: 0-100`. A model asked for a number twice on an unchanged page returns 61 then 70.
   A weekly score that moves eight points when nothing changed destroys the whole "watch your score
   climb" story the first time a founder re-runs it. Instead:
   - **Deterministic checks** (code): JSON-LD present + types, title/meta length, single H1, CTA verb
     class (passive "Learn more/Submit" vs outcome), pricing signals found, FAQ present, quantified
     proof (regex for numbers + units), HTTPS, mobile viewport meta, page weight.
   - **Judgement checks** (model): a fixed rubric of yes/no questions per lens ("Does the H1 say who
     it is for?", "Could a competitor paste this H1 unchanged?"), each answered with the quoted
     evidence. (Calls go through `ai-gateway.ts`, which sets no temperature; determinism comes from
     scoring in code and from not re-scoring an unchanged page, not from sampling settings.)
   - **Score = weighted sum in code** over both. Same answers → same score, always.
   - **Unchanged hash → no re-score.** The previous run's score carries forward (logged as a "no
     change" check, costs no model call, spends no task).
2. **The "AI Search" lens is labelled a simulation.** We do not query ChatGPT or Perplexity. The copy
   must say "how an AI assistant is likely to read your site", never "what ChatGPT says about you"
   (memory `public-copy-claims-vs-system`). An optional real signal later: a Serper search for the
   buyer's category query to show whether the site appears at all (Serper is already a sub-processor).
3. **Postgres, not MariaDB**, and two lean tables plus `assistant_records` for the Data Hub — see §5.
4. **No invented statistics in copy.** "97% leave without buying" needs a citable source or goes.
5. **"Approve" a fix does not change the website.** The Mystery Shopper cannot edit a site it does
   not host. Approve = "I'll make this change" (copy-to-clipboard + checklist). The re-scan verifies
   it. Once the Website Assistant exists, a fix on a Swan-hosted site becomes a real one-click apply.
6. **Competitor fetches are polite.** Homepage + at most 2 linked pages (pricing, about) per
   competitor, honour `robots.txt`, identify the user agent, no logged-in pages, no review-site
   scraping (the old `competitor_intel_analyst` copy promises G2 scraping — that is a ToS problem,
   not a feature).
7. **JavaScript-only sites are reported honestly.** `safeFetchText` gets server HTML. A client-only
   SPA returns an empty shell; we detect thin content (< N words, no H1) and say "we could only see
   a blank page — this is also what many AI crawlers see", which is itself a finding. No headless
   browser in v1.
8. **The "self-tuning pivots" become proposals, not autonomous sends.** Scenario A (stalled fix →
   draft a LinkedIn post) and B (competitor change → counter-brief) produce **drafts in the target
   assistant's queue** via hand-off. Nothing posts or emails on its own (publish policy is user
   consent — memory `publish-policy-is-user-consent`).

## 4. The design

### 4.1 The role

- `roleKey`: **`mystery_shopper`** (new; open decision D1 on `competitor_intel_analyst`).
- Name: **Mystery Shopper** · category Marketing & Sales · data pattern: internal/no-tool role.
- Output shape (Disruptive UI): a **`site_audit_card`** — overall score dial, three lens scores,
  top-3 fixes with before/after, competitor radar line, hand-off buttons.

### 4.2 Set-up (onboarding schema — 4 questions)

1. Website URL (required; pre-filled from `brand_kit.website` when present).
2. Who is your ideal customer? (one sentence)
3. What should a visitor do? (book a call / buy / start a trial / sign up / call / visit — select)
4. Up to 3 competitor URLs (optional). **Operational step:** weekly check day.

Every field must be read by code (`tests/assistant-surfaces-review.test.ts` fails otherwise).

### 4.3 Extraction payload (`src/utils/site-extract.ts`, pure, tested on fixtures)

Per page: `url, fetchedAt, finalUrl, status, contentHash, thin:boolean, seo{title, description,
ogTitle, canonical, viewport, lang, jsonLdTypes[]}, hero{h1[], subheadline, primaryCtas[{text,href}]},
structure{h2[], h3[], ctas[], pricingSignals[], proofSnippets[], faqQuestions[], forms:n}, bodyExcerpt
(≤3,500 chars, section order kept)`.

`contentHash` = SHA-256 over title + H1 + H2 + primary CTAs + pricing + proof (not the whole body,
so a rotating date or cookie banner doesn't count as a change). Competitors also get a
**field-level diff** vs last run, computed in code (no model) — "H1 changed from X to Y".

### 4.4 The run pipeline

`run-site-audit-background.ts` (background function; one row per run, polled by the client):

1. Fetch + extract user page and competitors in parallel (`Promise.allSettled`; a dead competitor
   never fails the run).
2. If every hash equals the last run → write a "no change" run, carry scores forward, stop.
3. `hasTaskCapacity` → else stop with `TASK_LIMIT_MESSAGE`.
4. Three lens calls in parallel (Skeptic / Comparison Buyer / AI-search reader), each a fixed rubric
   returning `{answers[{id, yes, evidence}], findings[{location, problem, currentText,
   suggestedRewrite}]}`. Every `currentText` must be a substring of the payload — code drops any
   finding that quotes text not on the page (anti-fabrication, same idea as brand-extract's
   "pick from the list").
5. Code computes scores (§3.1) and the diff vs last run.
6. One synthesis call: executive summary, top 3 fixes, hand-off briefs. Brand voice; includes
   `loadProductsBlock` + `SPECIAL_CATEGORY_RULE` + safety benchmark (memory
   `admin-assistants-one-status`).
7. Persist run + `assistant_records` rows; `recordCompletedWork` after the success latch; notify.

Cost: 4 model calls per changed run. Unchanged weeks cost nothing.

### 4.5 Weekly loop & goal

- Scheduled function (prod) + `staging-crons.yml` entry: each active audit whose check day is today.
- Goal metric `site_health_score` (objective `outcome`, source = latest run) in `goal-metrics.ts`.
  Default goal on hire: "Raise from baseline to 85 within 30 days". On reaching it the assistant
  **proposes** the next page (pricing/services) — the user accepts.
- Triggers that create proposals (never actions): fix approved but hash unchanged after 7 days →
  propose a social post carrying the new positioning; competitor hash changed + edge score drop ≥10
  → competitor alert + counter-brief draft.

### 4.6 GUI and chat parity

| Capability | GUI | Chat |
|---|---|---|
| Run / re-check now | "Check my site now" button | "check my site again" → proposes a run card; click runs it |
| Edit URL / ICP / competitors | Set-up tab | proposes a settings card |
| See fixes, mark done / dismiss | Audit tab | lists fixes, proposes status change card |
| Hand off to Social / Blog / Campaign | buttons on a fix | proposes the hand-off card |
| Explain a score | score tooltips list the failed checks | answers from the stored run (never re-scores) |

### 4.7 The public teaser (the acquisition hook)

`/mystery-shopper` marketing page (the five-place checklist in memory `blog-page-on-marketing-site`)
+ `site-audit-public.ts`:

- URL + email in → **homepage-only, no competitors, Skeptic lens only, deterministic checks** → a
  5-second clarity score and the single worst leak, shown on screen. Full report + weekly watch =
  "Hire the Mystery Shopper".
- Cost guards: rate limit per IP and per email, global daily cap (env), result cached by URL hash
  for 24h (the same URL twice costs nothing), honeypot field. No CAPTCHA solving is involved — we
  may add Turnstile ourselves.
- Email capture goes into the **Be More Swan org's own Audience** with consent text (Form Builder
  is the model — memory `form-builder-definition`).
- Respects `new_registration_lock`: while the waitlist is on, the CTA joins the waitlist.
- The teaser model calls are logged in `ai_usage_log` under the platform org.

## 5. Data model (SQL before code, both DBs)

`db/z-mystery-shopper.sql`:

- `site_audits` — `id, organisation_id, assistant_id, url, icp, conversion_goal, competitor_urls
  jsonb, check_weekday, baseline_score, current_score, target_score default 85, status
  (active|paused|goal_met), last_hashes jsonb, created_at, updated_at`. Org-scoped.
- `site_audit_runs` — `id, audit_id, organisation_id, kind (baseline|weekly|manual|public_teaser),
  status (queued|running|done|failed|unchanged), scores jsonb, checks jsonb, payload jsonb,
  report jsonb, diff jsonb, error, created_at, finished_at`.
- `site_audit_fixes` — `id, run_id, audit_id, organisation_id, lens, location, before_text,
  after_text, impact, status (open|accepted|done_verified|dismissed), verified_run_id`.
  Fixes need their own lifecycle (verified by a later run) — that's why they aren't just
  `assistant_records`.
- ~~`assistant_records.record_type` gains `site_audit`~~ — dropped: run history lives in
  `site_audit_runs`, and changing that CHECK is the DROP-then-ADD migration trap. Step 3 decides
  whether the Data Hub tab reads `site_audit_runs` directly.
- Public teaser runs: `site_audit_runs` with `organisation_id` = platform org, plus `email_hash`.

## 6. Build order

Built in step 2, beyond the plan: `src/lib/robots.ts` now serves both crawlers (`CRAWLERS`), and a
pre-existing parser bug was fixed — once our group matched, every LATER group's rules (another bot's
`Disallow: /`, a `*` group after ours) were applied to us too. Outcomes a run can end in: `done`
(charged), `unchanged`, `unreadable`, `failed` (all free). A fix is marked `done` only by a later
run that no longer finds its old text — never by the user.

1. **Extraction + scoring, no UI** — `site-extract.ts` + `site-score.ts`, fixtures of 6 real page
   shapes (Squarespace, Wix, WordPress, Webflow, a SPA shell, a bare HTML page). Prove: same input →
   same score.
2. **SQL + run pipeline** — background function, poll endpoint, metering, notifications.
3. **Role wiring** (self-audit matrix): catalogue row (hidden), `connection-map` (empty list — it
   connects to nothing, explicitly), onboarding schema, chat route, `site_audit_card` renderer,
   dashboard registry (4 KPIs: Health score, Fixes done, Competitor changes, Days to target),
   starter prompts, mandate chips, goal metric, notification prefs, build manifest, tests.
4. **Weekly loop + hand-offs** — cron, competitor diff alerts, proposals into Social/Blog/Campaign.
5. **Public teaser page** + rate limits + audience capture.
6. **Go-live** via Admin ▸ Assistants status (only `admin-assistants.ts` writes it).
7. Marketing: landing page, 3 narrative angles (§8), Swan Index article on its own findings.

Phases 1–3 are a usable hired assistant. Phase 5 is the growth engine and can ship the same week.

## 7. Decisions

Decided 2026-10-14 (the user):

- **D1. ✅ New `mystery_shopper` role; `competitor_intel_analyst` set Hidden** (via Admin ▸
  Assistants status — the only writer). Its competitor watching lives on inside the Mystery Shopper.
- **D2. ✅ Every plan tier, including £29.**
- **D3. ✅ Public teaser live at launch** — so build step 5 is part of the launch, not a follow-up.
- **D4. ✅ 1 task per run that re-scores**; a run where nothing changed is free.

Still open:

- **D5.** Name: recommended **"Mystery Shopper"** as the assistant's name, always introduced as
  "a mystery shopper for your website". It is the accurate term — a mystery shopper poses as a real
  customer and reports what the experience was like, which is exactly what the buyer lenses do.
  "Website Critic" describes an expert reviewer, which it is not. The one honesty limit: a real
  mystery shopper also tries the service; ours only *reads* the site. It never fills in forms,
  books, or buys, and the copy must not imply it does.

## 8. Selling it — what can and cannot be claimed

Can: "reads your homepage like a sceptical buyer", "compares you side by side with up to three
competitors", "tells you when a competitor changes their headline or pricing", "writes the
replacement copy", "re-checks every week and proves the fix landed".

Cannot (until built or sourced): "what ChatGPT says about you" (it is a simulation), "97% of
visitors…" without a source, "increases conversions by X%", "fixes your website" (it proposes;
the Website Assistant fixes).
