# Lead Generator — completeness plan

**Status:** 2026-08-25. §2 (both halves) and §4.1 are BUILT (uncommitted). §3, §4.2, §5, §6 are not.
**Supersedes nothing.** Extends `docs/lead-generator-discovery-plan.md` (the discovery engine) and
`docs/lead-triage-review-split-plan.md` (the tabs). Cite sections from code as
`docs/lead-generator-completeness-plan.md §N`.

## §0 The principle

> A search runs when the user asks. It goes as deep as it can in that one run. When it says it is
> finished, it is finished — nothing later deepens it, re-scores it, or finds the contacts it
> should already have found. If it will take time, the user is told how long and what is happening.

Everything below serves that sentence. The current pipeline violates it in five places, and four of
the five are the same defect wearing different clothes.

⚠️ **This is a support-cost plan as much as a correctness plan.** The trigger was a paying customer
messaging on WhatsApp to ask *"does that seem right?"* about a finished search. Every gap below
produces a question only a human can answer, and that does not survive contact with a hundred
customers.

---

## §1 The diagnosis: one root cause, five symptoms

### §1.1 Sliced runs, and the one path that never started them

⚠️ **CORRECTED 2026-08-25.** The first draft of this plan claimed every run crawled at one slice
per ten-minute cron tick, and derived 6h 20m for prod job 23. That derivation was wrong for
hand-started runs, and the correction is the whole of §2 — recorded here rather than deleted,
because the wrong number is the reason the plan first proposed building something that already
existed.

`process-discovery-jobs.ts` processes a **bounded slice** per invocation and persists progress on
`discovery_jobs.cursor`:

| Constant | Value | Effect |
|---|---|---|
| `QUERIES_PER_SLICE` | `1` | one search query per tick |
| `ENRICH_BATCH` | `5` | five contact lookups per tick |
| `[functions.process-discovery-jobs]` schedule | `*/10` | a tick every ten minutes |

At the cron cadence alone, prod job 23 — 14 queries, 120 leads — would need
`14 + 24 = 38 slices × 10 min ≈ 6h 20m`.

**But that is not what a hand-started run does.** `run-discovery-jobs-background.ts` already loops
`drainDiscoveryJobs` back-to-back until the queue empties, under a 12-minute budget and a 200-pass
ceiling. One poke carries a whole run, so those 38 slices run consecutively at ~10s each —
**about six minutes, not six hours.** Every hand-started surface pokes it:
`discovery-campaigns.ts` (create / approve_brief / run_now) and `lead-generation.ts`.

**The gap was `dispatch-discovery-runs.ts`.** The hourly scheduler INSERTed a queued
`discovery_jobs` row and returned, poking nothing. So the identical search finished in minutes when
a person pressed the button and took hours when the schedule fired it — and the slow path was the
unattended one, where nobody was watching to notice.

⚠️ **`CRON_TRIGGER_SECRET` and `BASE_URL` are both set on production and staging**, each pointing
at its own deploy, so the poke path itself was working. Only the caller was missing.

### §1.2 The slow cadence is deliberate, and it is load-bearing

`src/utils/trigger-drain.ts` states the reason: the aligned drainers leave a ~9-minute idle window
so Neon can autosuspend, and **an always-on minute-cron exhausted the project-wide compute quota on
2026-07-11**. The slow drain is protecting the database, not neglecting the user.

⚠️ Any plan that makes runs finish quickly must say what it does about database compute. §2 does.
A plan that ignores this re-creates a known production outage.

### §1.3 What the root cause produces downstream

| Symptom the user sees | Actual cause |
|---|---|
| A **scheduled** search takes hours; the same search started by hand takes minutes | §1.1 — the dispatcher never started the queue |
| "Complete" arrives while work remains | completion is defined over a subset (§3) |
| Leads appear with no score and no reason | scoring truncation, silent (§4) |
| 100 results, 14 emails | contact lookup gated to a fraction of leads (§5) |
| Things change after a search "finished" | nightly sweeps rescuing an unfinished run (§6) |

---

## §2 Every enqueue path starts its own work

### §2.0 Measured on prod, 2026-08-25

Twelve completed runs, and the population splits cleanly by DATE against the looper's arrival
(`run-discovery-jobs-background.ts`, added 2026-08-07):

| Population | Runs | Seconds per search | Reading |
|---|---|---|---|
| `on_demand`, before 2026-08-07 | 2 | 620, 757 | No looper existed — cron-paced at ~600s/slice |
| `scheduled`, after 2026-08-07 | 1 | 1184 | **The dispatcher never poked** — still cron-paced |
| `on_demand`, after 2026-08-07 | 9 | 16–28 | Poked; the looper drains back-to-back |

The best evidence for §2.1 is the middle row: the only scheduled run in the history of this table,
12 days after the looper shipped, running **~40× slower per search** than a poked run of the same
code. 2 searches and 12 leads took 39.5 minutes; on the same assistant five days later a poked run
did 28 searches and 120 leads in **8.7 minutes**.

⚠️ **Do not average across 2026-08-07.** Doing so produces a 25-minute mean that describes no run
that has ever happened, and invites exactly the wrong conclusion — that healthy runs are exhausting
the looper's budget. They are not: the largest run on record finishes in 8.7 minutes against a
12-minute budget. This plan's first draft made that mistake twice.

⚠️ **Nothing in this data is a backoff or a pause.** Every row carries `attempt = 0` and a NULL
`error_message`. Both were checked and both were wrong — recorded so the next reader does not spend
the queries again.

### §2.1 The dispatcher poke — BUILT 2026-08-25

`dispatch-discovery-runs.ts` now calls `triggerDiscoveryDrain` once per cycle after enqueueing.

- **Once, not per job.** The looper drains the whole QUEUE, and `drainDiscoveryJobs` claims up to
  five jobs per pass across all campaigns. A poke per row would start N loops competing for the
  same rows — harmless, since the claim is a single atomic `UPDATE … RETURNING`, but pure waste.
- **Guarded on an actual insert.** A cycle that enqueued nothing must not wake the queue.
- **Best-effort.** Every failure path in `poke` leaves the rows for the cron — the behaviour it
  replaces — so it can only make things faster, never break them.
- **No request headers.** A scheduled invocation has none; `resolveBaseUrl` falls through to
  `BASE_URL`.

Pinned by `tests/discovery-scheduled-runs-start-now.test.ts`, which enforces the invariant across
the whole functions directory rather than against a list of today's callers: **any file that
inserts a `discovery_jobs` row must import the trigger.** A new enqueue site that forgets is
invisible in testing — the cron still runs it, eventually — and surfaces only as a customer asking
why their daily search takes all morning.

### §2.2 Budget hand-off on long runs — BUILT 2026-08-25

`run-discovery-jobs-background.ts` now hands its remainder to a fresh invocation when `BUDGET_MS`
expires with work still queued, so "one poke carries the whole run" holds for runs of any length.

⚠️ **The three ways out of the loop are NOT equivalent**, and the whole correctness of this sits in
keeping them apart. Extracted as `decideLoopExit()` rather than left inline, because collapsing
them into "work remains, so chain" reads as obviously correct and turns a broken queue into an
unbounded chain of invocations:

| Exit | Meaning | Action |
|---|---|---|
| `queue_empty` | a pass claimed nothing | stop — a poke would find no work |
| `passes >= MAX_PASSES` | a queue burning passes without draining (every job erroring instantly) | **leave to cron** — `MAX_PASSES` exists to STOP this; chaining converts the safety net into a spin loop that outlives the process |
| budget expired | legitimate long work, cut off by a platform limit | **hand off** |

**`MAX_HANDOFFS = 4`, and the ceiling is not arbitrary.** Four hand-offs is ~48 minutes of
continuous draining, which keeps one chain inside the hourly dispatch window. A chain still running
when the next dispatch fires would overlap it — harmless for correctness (the claim is one atomic
`UPDATE … RETURNING`) but compute nobody asked for, and unbounded chaining is the shape that
exhausted the project-wide quota on 2026-07-11. Past the cap the cron takes the remainder, which is
the behaviour before this existed.

**Chain depth travels in the request body**, so `triggerDiscoveryDrain` gained an optional `extra`
payload — the count has to survive the invocation boundary and the body is the only channel that
does without inventing a table for it.

⚠️ **Depth is attacker-adjacent input**: this endpoint is reachable by anything holding the shared
secret. `parseHandoff` clamps every value DOWN — NaN and absent read as a first poke, anything
above the cap clamps to it. A test caught the one case that fell the wrong way: `Infinity` failed a
`Number.isFinite` guard and fell back to 0, which granted a forged body a *full* chain rather than
ending one.

Pinned by `tests/discovery-drain-handoff.test.ts`, which exercises the decision at every depth and
every exit rather than grepping the source.

### §2.3 What this does NOT change

The concern in §1.2 — that fast drains re-create the July compute outage — does not apply to
either half. The looper has existed and run on every hand-started search for as long as the poke
has; §2.1 extends it to the scheduled path, and §2.2 extends its duration. None of it is an
always-on cron: it runs hot only while a job exists and goes silent when the queue empties.

⚠️ §8.1 is therefore **narrower than first written**, but not closed: §2.1 raises the ceiling on
concurrent drains, because scheduled runs across many tenants now start on the hour together rather
than trickling. That is a burst to watch, not a new class of load.

**Acceptance.** A scheduled run and a hand-started run of the same search take the same time. No
run falls back to the cron partway through.

## §3 "Complete" means complete

**The change.** A run does not notify until every stage has finished for every lead it found, and
the notification states what the run actually covered.

**What exists already.** The worker computes `StopReason`
(`plan_complete | lead_cap | search_cap | cost_cap | token_cap | month_cap`) and a `Coverage`
record (`queriesRun`, `resolved`, `inserted`) on the cursor. Both were built because *"a 175-lead
sample of ~4,500 schools presented itself as a finished search"* — the same complaint this plan
answers. The evidence is computed and then not used by the notification.

**What to build.**
1. `publishSignals` gates on all stages terminal, not just enrichment of the eligible subset.
2. The notification carries the stop reason and the coverage numbers in the user's words: what was
   searched, what was found, what was contactable, and — if a cap stopped it — which cap, and what
   starting it again would do.
3. A capped run is reported as **capped, not complete**. Those are different outcomes and the user
   must be able to tell them apart without asking anyone.

⚠️ `search_signals_published` returns early when `leadsFound === 0`, so a run that found nothing
notifies nobody. That is a silent outcome the user asked a question about; a zero-result run needs
to say so, with the coverage that explains it.

**Acceptance.** No notification can be followed by further automatic work on that run. A user
reading the notification can answer "did it see my whole market?" without opening a tab.

---

## §4 Every lead is scored, and the score is real

### §4.1 The defect (fixed 2026-08-25, but the class is not closed)

`scoreCandidates` asks for one JSON object per candidate, each carrying a **complete outreach
email**, and ran with `max_tokens: 2048` — five or six candidates' worth against a SERP page of up
to ten. On truncation the array never closes; `parseModelJsonArray` correctly returns null rather
than a partial list; every candidate falls to `normaliseLeadCard(undefined)` → score 0, no reasons,
no `prospectType`, rating falling through to **cold**. Nothing detected it: the `catch` sees only
transport errors, and a truncation is a successful response.

**Measured on prod, 2026-08-25:** 132 of one tenant's 500 leads — **26%** — were filed this way.
All 132 scored exactly 0; 131 carried no reasons; and not one untyped lead in the workspace was
rated anything but cold, which is the blank card's signature rather than a verdict's.

Fixed: ceiling raised to 8192, `stop_reason` inspected, `warnIfTruncated` on all three model calls
in `src/lib/discovery-scoring.ts`. Pinned by `tests/discovery-scoring-truncation.test.ts`.

### §4.2 What still needs building

A raised ceiling makes truncation unlikely, not impossible — a longer prompt or a larger batch
reintroduces it. The guarantee is structural:

1. **Verify before promoting.** A lead whose card is blank (score 0, no reasons, no prospect type)
   is not a cold lead; it is an unscored one. Detect that shape and re-score it within the run.
2. **Re-score in smaller batches on retry**, so a retry cannot fail the same way.
3. **Never promote an unscored lead as cold.** If it cannot be scored after retry, it must be
   visibly unscored, not silently rejected.

⚠️ The reason this matters beyond wasted spend: an unscored lead is indistinguishable from a
rejected one, so it vanishes from every count, and `ENRICH_ELIGIBLE_SQL` will not look it up. One
silent failure becomes three.

**Structural option worth costing:** split the outreach draft out of the scoring call. The draft is
the bulk of the output tokens and is only wanted for hot/warm leads — which are not known until
scoring is done. Scoring every lead and drafting for a subset is both cheaper and untruncatable.

**Acceptance.** A completed run contains zero blank cards. The count is assertable in SQL.

---

## §5 Contact details for every company

### §5.1 The principle, and the one distinction that matters

> Emails should be found for all leads irrespective of cold or not, as the user can then determine
> themselves whether to contact a cold lead. This is not for us to decide.

Agreed for **cold**. Not agreed for **not-a-company**: an aggregator, a news article or a Wikipedia
page has nobody to email, and a paid lookup against one is spend with no possible return.

⚠️ Conflating those two is the original defect. `rating = cold` was used as a proxy for "not worth
contacting", and it silently included 89 companies the scorer had itself classified as
`target_business`.

### §5.2 The target rule

| Lead | Free scrape | Paid lookup |
|---|---|---|
| Any rating, `prospectType = target_business` | yes | yes |
| Any rating, `prospectType` absent | yes | yes — after §4 it means unscored, not dubious |
| `supplier_to_target`, `aggregator`, `media`, `content_page`, `platform` | no | no |

This widens `ENRICH_ELIGIBLE_SQL` (`src/config/lead-contact-state.ts`) — currently
`rating IN ('hot','warm') OR prospectType = 'target_business'`, itself a widening made 2026-08-25 —
to *every company, regardless of rating*. It remains the single definition, mirrored by the
Searches aggregate, the Contact column and the "Look again" gate.

### §5.3 What this costs, and why §2 is a prerequisite

- **Money.** ~£0.008 per paid lookup. A 500-lead run where most are companies is roughly **£4**
  worst case, against ~£0.20 today. `maxEnrichmentCallsPerRun` (default **25**) must rise or it
  becomes the new gate — on prod job 23 it never bound, because so little was eligible.
- **Time.** `LEAD_BUDGET_MS = 6000` per lead, five per slice. 500 leads is 100 enrichment slices —
  roughly **17 minutes** of consecutive work. That exceeds the looper's 12-minute `BUDGET_MS`, so
  it needs one hand-off. ✅ **§2.2 is built**, so this is no longer a blocker; a 500-lead run costs
  two links of a four-link chain.

**Acceptance.** Every company a run finds has either an address or a recorded attempt that found
none. "Not attempted" ceases to exist for companies.

---

## §6 The nightly sweep goes back to being about staleness

`netlify/functions/lead-enrichment-sweep.ts` currently serves two jobs: re-reading leads whose
intel has aged (legitimate), and rescuing leads the original run should have handled (a symptom of
§3–§5). Once a run completes properly, only the first remains.

**State today:** `LEAD_ENRICH_SWEEP_ENABLED` is unset on **production and staging**, so despite
being scheduled at 05:30 daily since 2026-08-15 it has **never run anywhere**. Its first execution
will be its first ever, across every tenant at once.

**Actions:**
1. Do not enable it as a fix for §3–§5. It is 25 leads per run across all tenants — a trickle, not
   a backfill, and it cannot make a run complete.
2. When it is enabled, exercise it on staging first through `run-lead-sweeps.ts` with
   `LEAD_ENRICH_SWEEP_MAX_LEADS` small, and read the cost of one run before prod sees it.
3. ⚠️ It is **operator-wide, not per-tenant**. Enabling it for one customer enables it for all.
4. Re-scope its documentation to staleness once §5 lands, so nobody reintroduces the rescue role.

---

## §7 The support-load test

§7 is not a feature. It is the acceptance criteria for §2–§6, written as the questions a customer
would otherwise send to a human. Each must be answerable **from the screen**:

1. *"Is it still running, and how long will it take?"* → a live stage and an estimate (§2, §3).
2. *"It says complete — is it?"* → yes, unconditionally (§3).
3. *"Why did it only find N?"* → the stop reason and coverage, in the notification (§3).
4. *"Why has this lead no score?"* → cannot happen (§4).
5. *"Why do only some leads have emails?"* → because those companies publish none, and we say so
   per lead (§5).
6. *"Why did my results change overnight?"* → they don't (§6).
7. *"How do I write a good search?"* → the assistant writes it in chat, and approving it saves the
   search. **This already works** and is the strongest candidate for a discoverability fix: a
   customer used an external AI tool because they never found it (see §8.3).

---

## §8 Decisions still needed

### §8.1 Database compute
⚠️ **Narrower than first written.** The looping drain is not new — it has carried every
hand-started search since it shipped, so the compute shape is already in production. What §2.1
changes is that scheduled runs across many tenants now start together on the hour instead of
trickling one slice per tick. That is a **burst** to watch, not a new class of load.

Open: does the hourly dispatch burst need spreading (a jitter, or a cap on concurrent drains) once
several customers hold daily schedules? Prod was re-provisioned 2026-07-11 after the outage that
set the ten-minute cadence, and this has not been load-tested at multi-tenant scale.
**Owner: operator.**

### §8.2 Per-run enrichment budget
What spend per run, per customer, is acceptable? §5 needs a number for
`maxEnrichmentCallsPerRun`, and it should be a plan-tier property rather than a constant.
⚠️ Discovery spend caps are operator-only by existing policy, never a user-facing setting.
**Owner: commercial.**

### §8.3 Discoverability of chat-authored searches
Not a code change to the engine. The assistant already writes and saves searches from chat; the
"Find New Leads" form is what users find first. Where should the chat route be surfaced?
**Owner: product.**

---

## §9 Sequencing

| Step | Depends on | Why that order |
|---|---|---|
| §2.1 dispatcher poke | — | ✅ **BUILT.** Scheduled runs now start like hand-started ones |
| §4.1 scoring ceiling | — | ✅ **BUILT.** Independent of everything else |
| §3 completion gate | §2.1 | "Complete" is meaningless while a scheduled run idles for hours |
| §4.2 scoring guarantee | §4.1 | Turns an unlikely failure into an impossible one |
| §2.2 budget hand-off | — | ✅ **BUILT.** A run of any length now completes in one chain |
| §5 contact for all companies | §4.2, §8.2 | Needs the throughput, and needs §4.2 so "unclassified" means unscored rather than unknown |
| §6 sweep re-scoped | §3, §5 | Only safe to demote once runs are complete |

⚠️ §5 before §2 makes runs *slower*, not better — 100 enrichment slices at ten minutes each. The
ordering is not a preference.
