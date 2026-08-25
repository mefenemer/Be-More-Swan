# Lead Generator — completeness plan

**Status:** 2026-08-25. **§2–§6 are all BUILT.** ⚠️ §5 needs `db/discovery-enrichment-cap-raise.sql` applied to staging AND prod — the code alone leaves every existing campaign capped at 25.
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

## §3 "Complete" means complete — BUILT 2026-08-25

### §3.1 Item 1 was already satisfied

The plan said `publishSignals` should "gate on all stages terminal". It already did: line 791 is the
**only** `status: 'completed'` write in the worker, it is gated on `remaining === 0`, and it is the
same statement that fires the notification. `finishJob` is only ever called with `'failed'`. No
notification could precede a terminal stage. Recorded rather than deleted — the plan overstated the
defect, and the next reader should not go looking for it.

### §3.2 The evidence now reaches the user

`stopReason` and `Coverage` were computed slice by slice, persisted on `discovery_jobs.cursor`, and
read by nothing. They now render into the notification through
`src/config/discovery-run-summary.ts` — a pure module, so the copy is testable directly and has one
definition.

Three merge variables **added** to `search_signals_published`:

| Variable | Carries |
|---|---|
| `search.ending` | "finished running" vs **"stopped early"** |
| `search.coverage` | searches run of those planned, results read, and what the newness rate means |
| `search.outcome` | what happened and the next action, branched on the stop reason |

⚠️ **Added, never renamed** — renaming a merge variable blanks every tenant override that used the
old key. `search.name` and `search.companies` keep their keys.

**A capped run no longer reads as a finished one.** The old message said "Approve the ones worth
pursuing" whether the run had worked its whole plan or stopped at a cap with the market half-read.
Each cap now quotes its **own** number — a `search_cap` run says "your limit of 15 searches", never
the lead cap, because quoting the wrong one sends the user to change the wrong setting.

**`remaining` is derived, not stored.** The cursor already holds the plan (`flat`) and the position
(`queryIndex`); a second persisted copy is a number that can disagree with the plan it describes.

### §3.3 A zero-result run notifies, instead of saying nothing

⚠️ `publishSignals` returned early on `leadsFound === 0`. A user who started a search and waited was
told **nothing** — silence reads as "still running" or "broken", and it is the cheapest support
message this product can generate. A search that found nothing is a result.

The copy distinguishes the two zero cases, which have opposite meanings: a run that worked its whole
plan and matched nothing is evidence the description is too narrow; a run that stopped at a cap
having found nothing is **not a verdict on the market** and must not blame the description.

### §3.4 The copy collisions the tests caught

- The newness reading said "companies", beside a lead count that could read "found no companies" —
  nothing matched, yet we had "already found" most of them. Both true of different things
  (domains resolved vs leads qualified), which is precisely the sentence a user brings to support.
  It says **"sites"** now.
- The zero-result outcome repeated "worked through every search it planned", which
  `coverageSentence()` had just said in the same paragraph.
- The Searches tab named itself in the template copy, and the call to action moved into
  `search.outcome`. The invariant moved with it: **every branch** of `outcomeSentence()` names the
  tab, enforced across the whole cross-product in `tests/discovery-run-summary.test.ts`.

### §3.5 The finished-run sentence — FIXED 2026-08-25

The old copy — preserved verbatim through the first pass of §3, so this was never a regression —
had three errors in nine words, in the one notification a user definitely reads:

> Approve the ones worth pursuing on the Searches tab and they become leads.

Against `leadGeneratorSurfaces()` in `chat-orchestrator.ts`, which the assistant is held to:

1. **"they become leads"** — every company is already a lead the moment it is scored, whatever it
   scored. The prompt says outright: never tell a user their results are waiting to *become* leads.
   The notification was contradicting the assistant that sent it.
2. **"Approve"** — the button is **"Move to Outreach"**. Approving is a separate act on the Outreach
   tab, and it SENDS; telling a user a lead is approved would have them believe an email is on its
   way.
3. **"on the Searches tab"** — leads live on the **Enrichment** tab; the Searches results view is
   read-only.

Now:

> They are already in your Enrichment tab — open it and move the ones worth pursuing to Outreach.

**The invariant widened rather than loosened.** "Every branch names the Searches tab" became "every
branch names a REAL tab, and the RIGHT one for that outcome" — a finished run goes to Enrichment
where the leads are; a capped or empty one goes to Searches where Start and Edit are. ⚠️ Naming the
wrong tab is worse than naming none: the user goes where the thing is not, and the notification has
spent its one chance.

`NAMED_TABS` is checked against the `label:` values in `assistant-dashboard-registry.js`, so
renaming a tab fails CI — the same coupling `tests/lead-prompt-surfaces.test.ts` already defends for
the assistant's own prompt. All three errors are pinned individually, because each reads as natural
English and would otherwise come straight back.

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

### §4.2 The guarantee — BUILT 2026-08-25

**1. Blank batches are halved and re-scored.** `scoreCandidates` detects blank cards and retries
them as two smaller batches, recursing to `MAX_RESCORE_DEPTH = 3`.

⚠️ **Halving IS the mechanism.** Re-issuing the identical batch would truncate at the same point —
a retry that cannot work. The same prompt over fewer candidates needs strictly fewer output tokens,
so each level is a genuinely different request. Recursion bottoms out at one candidate, the
smallest request this prompt can make; a single candidate that still comes back blank has a cause
the ceiling cannot explain and no further splitting will help.

Two things the retry must not break, both pinned:
- **Token accounting survives the recursion**, or a retried run under-reports its spend against the
  cost guardrails.
- **Retried cards land on their ORIGINAL indices.** The caller aligns cards to candidates by
  position, so a misplaced retry stamps one company's verdict onto another.

**2. `isBlankCard()` keys on the ABSENCE of a verdict, not on score 0.** A rejected lead always says
why, so the test requires no reasons AND no prospect type AND no exclusion AND no do-not-contact.
That is what keeps a genuine cold verdict out of the retry path — retrying one pays twice for the
same answer, and relabelling one erases a judgement that was made.

**3. Whatever is still blank is marked, never filed as cold.**
- The card carries `scoringFailed: true` (jsonb — no migration).
- The worker writes **NULL** to `discovered_leads.rating` and `score`. Unrated is an existing,
  supported state; `cold` is a verdict, and writing one nobody made is the entire defect.
- `reasons` says outright that the lead has **not** been judged a poor fit, and
  `suggestedNextStep` gives an action. A blank reasons array beside a cold rating reads as a terse
  verdict.

⚠️ **It is PROMOTED, not withheld.** "Never promote an unscored lead as cold" does not mean hide it
— a lead quietly held back is the same silence in a different place, and the user cannot act on what
they cannot see.

### §4.3 The surfaces had to learn the difference

An unscored lead is not enrichment-eligible, correctly — nothing should be spent looking up a
company nobody has judged. But it lands in the same `notAttempted` bucket as a directory, and the
chip there said *"This is not a company you could sell to"*. That is a **false statement** about a
lead the scorer never reached, and it is exactly the shape that let 132 blanks pass for rejections.

- New **`unscored`** chip ("Not scored") over the same bucket — precedent: `role` and `personal` are
  two chips over `reachable`. Its copy denies the rejection outright.
- `contactState()` tests `scoringFailed` **before** eligibility, or the false chip wins.
- The Searches aggregate covers both causes in one clause: *"N were not companies you could sell to,
  or were not scored, so were never checked."* ⚠️ One clause rather than a sixth bucket — the counts
  partition the total, and a bucket that is nearly always zero would add a clause to every search's
  summary to serve a residual case.
- ⚠️ No second em-dash in that clause: the lead-in already uses one and the clauses are
  comma-joined, so a dash inside a clause reads as a nested aside.

## §5 Contact details for every company — BUILT 2026-08-25

### §5.1 Rating is out of the rule entirely

> Emails should be found for all leads irrespective of cold or not, as the user can then determine
> themselves whether to contact a cold lead. This is not for us to decide.

Agreed for **cold**. Not agreed for **not-a-company**: an aggregator, a news article or a Wikipedia
page has nobody to email. So rating drops out and prospect type is the whole of the rule.

⚠️ Conflating those two was the original defect. `rating = cold` stood in for "not worth
contacting" and silently included 89 companies the scorer had itself classified `target_business`.

### §5.2 TWO gates, because one is free and the other is not

| | Who | Why |
|---|---|---|
| `ENRICH_ELIGIBLE_SQL` | Everything except the five disqualifying prospect types — **including leads with no type at all** | Reading a site costs seconds and might hand the user an address |
| `PAID_ENRICH_ELIGIBLE_SQL` | Confirmed `target_business` only | Buying costs money, and `paidLookupAt` is stamped on a MISS too — it counts money SPENT |

An unclassified lead is either legacy (scored before the type gate shipped 2026-08-12) or unscored
(§4.2). Scraping one is free; **paying** for one is a blank cheque against a lead nobody has judged.

⚠️ `ENRICH_ELIGIBLE_SQL` is generated from `PROSPECT_TYPES`, so a new disqualifying type reaches the
rule on the next deploy with no second edit to forget.

⚠️ **The on-demand path deliberately differs.** `enrichOneLead` (Look again / Send back for
enrichment) has no prospect-type gate on the paid tier: it is one lead, chosen by a human who
pressed a button on it. Refusing because the scorer never classified it would be the pipeline
overruling the user on the one lead they actually asked about. The refusal that does apply is
`look_again`'s, which turns down the types no address can help.

### §5.3 The cap had to move or it became the new gate

`maxEnrichmentCallsPerRun` **25 → 200**. At 25, §5 would have done almost nothing — prod job 23
found 120 leads and made **nine** paid lookups, because so little was eligible. 200 × £0.008 ≈
**£1.60** a run, against ~£0.20 today. A ceiling, not a target: the waterfall only pays for what the
free scrape missed, which has been about one in three.

⚠️ **`db/discovery-enrichment-cap-raise.sql` MUST be applied — the schema default alone is not
enough.** A column default reaches only rows inserted after it, and every existing campaign holds a
literal 25. Without the UPDATE the change reaches new campaigns and silently rations every campaign
a customer already has — exactly the population it was built for. The UPDATE is guarded on the old
value, so it is re-runnable and does not overwrite a hand-tuned campaign.

### §5.4 The surfaces, again

§5 changed a state §4.2 had introduced one commit earlier, and both moves were right at the time:

- **The `unscored` CONTACT chip is gone.** Under §4.2 an unscored lead got no lookup, so the column
  had to explain why. Under §5 it *is* read like any other possible company, so a "no lookup" chip
  would be a lie in the other direction.
- **The unscored fact moved to the RATING column**, which is where it always belonged. Its status is
  NULL, and `cellValue` would render an em-dash — indistinguishable from a rating that had not
  loaded. It now reads **"Not scored"** with a tooltip that denies the cold verdict outright.
- **The aggregate clause narrowed back.** `notAttempted` now has exactly one cause again, so it says
  "N were not companies you could sell to, so were never checked" — no hedge needed.

## §6 The nightly sweep is about staleness — DONE 2026-08-25

Re-scoped in `lead-enrichment-sweep.ts` itself, where someone about to enable it will read it.

**What it is not, in the file:** a rescue for an unfinished run, and it must never be enabled as
one. That was a real role it quietly played while a run could report "complete" having scored only
some of its leads and looked up a fifth of them. §3, §4.2 and §5 fix that at the source.

**The tell, written into the candidate-ordering comment:** the "never enriched at all" cohort should
be nearly **empty** for any lead found after 2026-08-25, because the run reads every company's site
itself. A large one is evidence a run is failing to finish — check the run before turning this on.

⚠️ Unchanged and still true: `LEAD_ENRICH_SWEEP_ENABLED` is unset on production and staging, so it
has **never run anywhere**; `MAX_LEADS` is 25 per run **across all tenants**; and it is
operator-wide — enabling it for one customer enables it for every one. Exercise it on staging via
`run-lead-sweeps.ts` with a small `LEAD_ENRICH_SWEEP_MAX_LEADS` and read the cost of one run first.

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

### §8.2 Per-run enrichment budget — DECIDED
Raised to **200** (≈ £1.60 a run at £0.008 a lookup). ⚠️ Still a flat constant, not a plan-tier
property — a customer on the entry tier and one on the top tier get the same ceiling. Making it
tier-aware is the follow-up, and it stays operator-only by existing policy, never a user-facing
setting. **Owner: commercial.**

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
| §3 completion gate | §2.1 | ✅ **BUILT.** Stop reason + coverage now reach the user |
| §4.2 scoring guarantee | §4.1 | ✅ **BUILT.** Blank batches are halved and re-scored; survivors are marked, never cold |
| §2.2 budget hand-off | — | ✅ **BUILT.** A run of any length now completes in one chain |
| §5 contact for all companies | — | ✅ **BUILT.** Rating out of the rule; two gates, free and paid |
| §6 sweep re-scoped | §3, §5 | ✅ **DONE.** Re-scoped in the file itself |

⚠️ §5 before §2 makes runs *slower*, not better — 100 enrichment slices at ten minutes each. The
ordering is not a preference.
