# Lead Generator: split triage from email review

Raised 2026-08-08 from prod (Zaphod): "a new search returned 15 leads, and there are also 15 leads
in the Review tab, which is not correct."

Status:
- **Phase 1 — built and DEPLOYED to prod + staging 2026-08-08** (items 1–3 and 5, plus the empty
  state from item 8). Item 4 deliberately deferred; see the note under it.
- **Two unplanned fixes built 2026-08-08 after prod diagnosis — see "What the prod data showed".**
  Not yet deployed at time of writing.
- **Phase 0 — BUILT 2026-08-08.** ⚠️ Needs `db/discovery-approved-brief.sql` applied to each
  environment BEFORE the code deploys; the column is additive and nullable, but the API writes it.
- Phases 2 and 3 scoped, not started.

## Why this exists

The complaint is not a data bug. Every discovered lead is promoted with
`approval_status: 'pending_approval'` (`process-discovery-jobs.ts:624`), and the Review tab *is* the
`pending_approval` slice (`_RQ_RECORD_STATE.review` in `assistants.js:1018`). Fifteen leads found
therefore puts fifteen leads in Review, by construction.

The user's model — "Review is where an email needs checking; until then it sits in Leads" — is the
better one, and the system does not implement it. One button is being asked two questions:

1. **Is this company worth pursuing?** Fast, scannable, high volume. Decided from a name, a score
   and a line of reasoning. Fifteen of these takes thirty seconds.
2. **Is this email OK to send to a stranger?** Slow, careful, low volume. A paragraph of prose and
   a recipient address.

Fusing them forces the careful task to run at the volume of the fast one.

## The volumes make the case

Enrichment only ever attempts `contact_email IS NULL AND rating IN ('hot','warm')`
(`process-discovery-jobs.ts`, `enrichBatch`). Measured hit rate on that subset is ~1 in 3, and the
staging audit found **3 of 101** lead records carrying an address at all.

So of fifteen leads, expect three to five hot/warm and **one or two with a usable address**. The
rest have nothing to review — no recipient, and cold leads carry `outreachDraft: null` by design
(`discovery-scoring.ts:126`).

An honest "emails awaiting sign-off" queue holds one or two items here, not fifteen. That gap is the
whole defect.

## ⚠️ Above this plan: we send cold email from the user's own inbox

Surfaced 2026-08-08 by a scan of eleven lead-gen tools (Apollo, Clay, Seamless, Cognism, ZoomInfo,
Leadzen, Outplay, Instantly, RocketReach, UpLead, Reply). **Not one of them sends from the user's
primary mailbox** — they all use dedicated sending domains, and Instantly's entire business is inbox
warm-up and deliverability management. We send via the user's connected Gmail/Outlook
(`outreach-email-connect`).

If we get a user's main business inbox flagged, we have not damaged a campaign — we have damaged
their invoices, their customer replies and their domain reputation. This is a safety issue, not a
feature gap, and it is **more urgent than anything else in this document**. Minimum viable response:
a hard volume cap per connected mailbox, an explicit warning at connect time, and a documented route
to a dedicated sending domain before any volume. Scoped separately; noted here so it is not lost.

## Where we sit against the market

The same scan sorts cleanly, and the sorting is the insight: **none of the eleven do what we do.**

| Category | Who | Their moat |
|---|---|---|
| Data providers | Apollo, Seamless, Cognism, ZoomInfo, RocketReach, UpLead | a pre-built, verified contact database |
| Sequencers | Outplay, Instantly, Reply | deliverability and multichannel cadence |
| Orchestrator | Clay | waterfall enrichment across 100+ sources |
| Outlier | Leadzen | visitor de-anonymisation, priced per meeting |

Everyone either **owns the data** or **owns the sending**. We do neither — we discover by live web
search and score with an LLM.

**What that means for this plan.** Our enrichment gap is not a gap in our execution; it is a
commodity the entire market has already solved (UpLead sells a 95% accuracy guarantee at $99/mo;
Clay's whole product is waterfall enrichment). Hand-rolling a worse version is the wrong use of
effort — hence the change to Phase 2 below.

**What we should not concede.** We find companies that are in no database at all: a small operator
with a website and no ZoomInfo entry is invisible to that entire category, and live search finds
them. And we take a business hypothesis (*"boutique hotels in Southern Europe with no booking app"*)
where every tool above requires an ICP already expressed as industry + headcount + title + geo. For
a non-specialist SMB user that difference is the product. The long tail is the defensible position;
data depth is not.

## Target model

Three surfaces, one question each.

| Surface | The question it answers | Volume | Actions |
|---|---|---|---|
| **Searches** | Is it looking for the right thing, and is it working? | a few campaigns | review/approve the brief (Phase 0); run / pause / edit; links into the leads it produced |
| **Leads** | Is this company worth pursuing? | ~15 per run | triage: approve / reject, batch-able, sorted by score |
| **Review** | Is this email OK to send? | ~1–2 per run | read, edit, send |

The load-bearing move: **triage lives in exactly one place.** Approval currently exists in Searches
(batch, `signal-inbox.ts` `approve`), in Leads (per-row) and in Review (per-row) — three surfaces
over the same rows, which is why they read as duplicates of each other. Leads owns it, because it
already carries the two columns the decision needs (Approval and Contact).

## Phase 0 — approve the brief before the search runs

Added 2026-08-08 after scanning hypefy.ai (an AI influencer-marketing platform — not a competitor,
but the same pipeline shape with creators in place of companies). Their first step is an AI-drafted
campaign brief covering strategy, audience targeting and content direction, **presented for user
approval before anything executes**. We have no equivalent: the ICP snapshot is resolved at
activation and stamped onto leads for attribution, but the user never sees it.

This phase is **first because it is the highest-leverage change in this document.** Every other
phase improves how you sort the output of a search. This one improves the input. The recorded
bottleneck is targeting quality, not enrichment — a live run once qualified tiktok.com, careers
pages and vendor blogs as hot/warm — and today the only lever on targeting is rejecting fifteen
leads *after* the search has spent its search calls and tokens.

**The brief is the query plan, not an abstract summary.** `discovery-query-gen.ts` already turns
`{ idea, targetPersona, icpSnapshot, negativeKeywords }` into concrete search strings across three
strategies (`niche_scrape`, `intent_signal`, `footprint`). Fifteen literal web searches are far more
checkable than a paragraph of strategy prose, and editing one is a deterministic lever — unlike
editing a prompt.

**It is nearly free, because the work already happens.** Query generation is one Haiku call, and the
worker skips it entirely when the cursor is already populated —
`if (!cursor || !Array.isArray(cursor.flat))` (`process-discovery-jobs.ts:173`). Moving generation
to campaign-creation time and seeding `discovery_jobs.cursor` with the approved
`{ flat, queryIndex: 0 }` **relocates the existing call rather than adding one**. No double spend.

The `draft` campaign status is already exactly "created but not yet running", and `run_now` already
promotes `draft → active` (`discovery-campaigns.ts:192`). No status vocabulary change.

1. **Generate at creation.** The "Find New Leads" modal (`assistant-discovery-campaigns.js`) gains a
   second step: after idea + cadence + guardrails, call query generation and show the result.
2. **Show what will actually happen.** The brief surfaces the generated queries grouped by strategy,
   the resolved ICP/persona being targeted, and the exclusions that will apply — negative keywords,
   excluded domains, and the deterministic blocklist in `discovery-domain-filter.ts`. The exclusions
   matter as much as the queries: "it will skip directories, job boards and social networks" is
   reassurance the current UI never gives.
3. **Make it editable.** Remove a query, edit its wording, add one by hand. This is where a user's
   domain knowledge beats the model's — they know the trade terms we don't.
4. **Approve, then run.** Approval persists the brief and seeds the first job's cursor, so the run
   executes exactly the queries that were on screen.
5. **Storage.** One new nullable `jsonb` column on `discovery_campaigns` — `approved_brief` —
   holding the approved queries plus the persona/exclusions they were approved against.
   ⚠️ Additive and nullable, so unlike a CHECK-constraint change this is low-risk DDL; it still needs
   a `db/*.sql` file, a matching `db/schema.ts` edit to stop a future `drizzle-kit push` reverting
   it, and a manual apply per environment. **Do not nest it inside `icpSnapshot`** — that column is
   an attribution key the revenue ledger reads, and overloading it would corrupt the meaning of
   every event stamped with it.

⚠️ **Recurring campaigns must not re-run the approved queries verbatim.** Identical queries return
substantially the same domains, and the `(campaign_id, domain)` dedupe
(`process-discovery-jobs.ts:279`) then discards all of them — a weekly campaign would find fifteen
leads once and nothing ever again. This is very likely the mechanism behind the complaint that
prompted this document. So: the approved brief is the **targeting contract** (persona, exclusions,
strategy mix), and each scheduled run generates fresh queries constrained by it. The approved query
list is the first run's concrete instance, and any edits the user makes become steering examples for
later generations. Show the brief as re-reviewable at any time rather than frozen.

## Phase 1 — make Review mean "emails awaiting sign-off"

**No DDL, no migration, no new approval state.** This is deliberate. `approval_status` already has
a working four-value vocabulary and a CHECK constraint that must be kept in sync with
`db/schema.ts` by hand or a future `drizzle-kit push` reverts it. Adding `untriaged` would cost a
prod DDL apply plus a backfill of live rows for no behaviour that a filter cannot deliver.

Instead: **Review filters, Leads holds everything.** A lead enters Review when it is
`pending_approval` **and** deliverable — it has a resolvable recipient and a non-null
`outreachDraft`. Everything else stays in Leads awaiting triage.

Recipient resolution must reuse the existing precedence verbatim —
`outreachDraft.to → contactEmail → lead.email` — which appears in `lead-generation.ts:251` and is
mirrored in `_rqRecipient` (`assistants.js:1627`). A third copy would drift; extract it instead.

1. **Server-side filter.** `assistant-records.ts` GET grows an optional `deliverable=1` param
   alongside the existing `approvalStatus` filter (~line 290). Server-side rather than client-side
   because the Review badge, the column count and the Overview shortcut all read `records.length`
   (`assistants.js:1683-1688`) and must not disagree with the list.
2. **Review calls it.** `_detailRqRenderRecords` appends `&deliverable=1` when
   `recordType === 'lead'` and `statusKey === 'review'` (`assistants.js:1677`). Other record types
   and other columns are untouched.
3. **Triage actions in Leads.** The hub tab currently writes edit / outcome / reject / delete — there
   is no approve. Add Approve and Reject to the row actions in `assistant-data-hub.js`, PATCHing
   `approvalStatus` through the same `assistant-records` seam the Review Queue uses.
   ⚠️ Approving a lead with no recipient must **not** attempt a send — it records the targeting
   decision only. The send stays exclusively in Review.
4. **Searches links instead of duplicating.** The batch-approve control in the Searches tab becomes
   a link into Leads filtered to that run, preserving the natural "it just finished, let me look"
   moment without a second approval surface.
   ⚠️ **DEFERRED 2026-08-08, deliberately — do not treat as an oversight.** Building items 1–3
   showed this step is mis-specified. It needs a Data Hub filter scoped to a campaign, which does
   not exist (`hubTab` has no filter concept at all), so it is materially larger than the sentence
   above implies. Worse, doing it as written would REMOVE a working batch action and replace it
   with per-row approval, which is a downgrade for the exact case triage is meant to serve — a
   user clearing fifteen leads at once. The right order is: give the Leads tab batch selection
   first, then retire the Searches control. Until then the duplication stands, and it is the
   lesser harm. **Ordering constraint: item 4 must not ship before Leads can batch.**
5. **Fix the lead count while here.** `leadsFound` is `SUM(j.leads_found)` over *every* job for the
   campaign, with no filter to the latest run — `signal-inbox.ts:312` and
   `discovery-campaigns.ts:152`. Re-runs only count newly-inserted domains
   (`onConflictDoNothing` on `(campaign_id, domain)`, `process-discovery-jobs.ts:279`), so a re-run
   that finds nothing new still displays the old total. The Searches tab at least says "found so
   far"; the campaign card says a bare `15 leads found` (`assistant-discovery-campaigns.js:178`),
   which reads as this run's result. Report both: this run, and total for the campaign.

**Migration: none.** The fifteen rows currently in prod Review are not rewritten — they simply
resolve to Leads or Review depending on whether they have a recipient. Reversible by dropping the
query param.

## What the prod data showed, and the two fixes it forced

Phase 1 shipped, then the prod rows were read. Zaphod held 14 pending leads, **0 deliverable** — and
the reason was not the filter. Every lead scored **cold**, every `outreachDraft` was present and
**null**, and `enrichAttemptedAt` was unset on all of them. Each of those is the system behaving
exactly as designed: cold leads get no draft, and `enrichBatch` only scrapes hot/warm.

The leads themselves were the problem. Of 35 discovered across two campaigns: adobe.com,
hubspot.com, salesforce.com, hootsuite.com, shopify.com, huffingtonpost.co.uk, digiday.com,
podcasts.apple.com, anchor.fm, feeds.libsyn.com, startup.jobs, builtinnyc.com. Vendors, media,
podcasts, job boards. **Not one was a sellable company.**

### Fix A — the query generator was asking for exactly what the filter throws away

`discovery-query-gen.ts` described `niche_scrape` as *"directories, maps, 'best X in Y' style"* and
`intent_signal` as *"hiring pages, tech-stack mentions, recent press, public reviews"* — while
`discovery-domain-filter.ts` blocks aggregators, media and job boards and rejects titles matching
`/directory/` and `/top \d+|best \d+/`. The model was not misbehaving; it did what it was told. The
run duly produced `site:trustpilot.com OR site:g2.com`, `site:linkedin.com/jobs`,
`inurl:careers OR inurl:jobs` and `best social media agencies UK ... directories`.

Rewritten so all three strategies aim at **the prospect's own website**, with the prohibition block
generated from the filter's own tables (a category added there reaches the prompt on the next run).
The prompt now also states the architectural *why*, because without it someone reasonably re-adds
"search LinkedIn for companies hiring X" — a good intent signal that yields a lead for linkedin.com.

⚠️ **Unresolved and worth a decision:** third-party intent sources are architecturally unusable.
The worker takes the SERP hit's domain as the prospect, so job boards and review sites — where
buying signals genuinely live — can never produce a lead for the company they describe. Fixing it
means rewriting a candidate to its root domain, which then feeds the scorer a title that describes
an article. The same trade-off is already recorded for a real prospect's blog post being dropped.

### Fix B — Delete was destroying the evidence that would have prevented all of it

21 of those 35 leads had been deleted by hand. Every one was a junk hit, so every one was evidence
the search was aimed wrong — and Delete captured none of it, while Reject captures a reason that
feeds `lead_reject_feedback`. Delete is also the button that makes a screenful of noise vanish
fastest, so the intuitive action was the lossy one.

Worse, `discovered_leads.assistant_record_id` is `ON DELETE SET NULL`, so each delete severed its
own provenance and left the discovery row reading `status='promoted'` — a state the lifecycle
vocabulary cannot describe.

Now: deleting a lead offers the reason vocabulary first, names Reject as the non-destructive
alternative, and marks the discovery row `discarded` whether or not a reason is given.
⚠️ **Both writes MUST precede the delete** — `recordLeadRejection` resolves provenance *by*
`assistant_record_id`, so anything collected afterwards attaches to nothing, silently.
`tests/lead-delete-evidence.test.ts` pins the ordering, and strips comments before doing so: the
first draft passed by matching the function name inside a comment sitting above the code.

### What this changed about priorities

**Phase 2 item 6 (paid enrichment) would have been money on fire here** — buying addresses for a
podcast feed and two news sites. It stays parked until targeting is fixed. **Phase 0 is now the
clear next build**, and the evidence for it is concrete: had the fifteen queries been on screen
before the run, `site:linkedin.com/jobs` and *"best social media agencies UK directories"* would
have been obvious in seconds.

## Phase 2 — make a lead reachable, and say so

Two scans changed this phase. hypefy.ai has no enrichment problem because creators opt into their
network — *"Only specific creators that have the audience that we're targeting get an invite"* — so
contact details arrive with the entity. The eleven-tool scan says the same thing from the direction
we can actually act on: **contact data is a commodity to buy, not a scraper to perfect.** Our
~3-in-101 rate is what hand-rolling it looks like.

So this phase now leads with buying the data, and the visibility work follows it. Enrichment is
currently visible in two places but never named as a step — the Searches running line
(`assistant-signal-inbox.js:237`) and the Contact column (`contactState()`,
`assistant-data-hub.js:107`). Under Phase 1 it stops being a background detail: it becomes the gate
deciding whether you have any work in Review at all.

6. **Waterfall the enrichment (highest impact in this phase).** Keep our free scrape *first* — it is
   free and hits ~1/3 on SMB sites — then fall through to one paid provider on a miss. This is
   Clay's core mechanic. Gate it with the `maxEnrichmentCallsPerRun` guardrail already contemplated
   in the original discovery plan, and env-gate the provider key exactly as `SERPER_API_KEY` is, so
   an unprovisioned environment degrades to today's behaviour rather than failing.
   **This is what makes the rest of the plan feel alive:** it moves Review from ~1–2 items per run
   to ~8–10. At typical per-lookup rates, fifteen leads a run is pennies.
   ⚠️ Purchased addresses must carry a distinct `emailSource` (not `'scrape'`, not `'manual'`) so
   the personal-inbox gate and the Contact column can reason about provenance, and so the revenue
   ledger can measure paid-vs-free hit rates separately.
7. **Capture social handles while we are already on the page.** `discovery-enrich.ts` already fetches
   `/`, `/contact`, `/contact-us`, `/about` with cheerio; footer links are plain `<a href>`; both
   storage columns are jsonb, so **no migration**. It is extraction, not inference, so it does not
   reopen the closed fabrication gap.
   ⚠️ **Nothing in this platform sends a DM** — `send_outreach` is Gmail/Outlook only and
   `lead-threads.ts` declares `channel?: 'email' | 'dm'` with nothing anywhere setting `'dm'`. A
   captured handle is therefore a link for a human to click and the copy must say exactly that.
   Cheap, honest, and it converts "None found, dead end" into "no email — here is their LinkedIn",
   which is the recovery Phase 2 was reaching for anyway.
8. **State the aggregate.** After a run, say "contact details found for 2 of 15 — 4 sites had none,
   9 were not attempted." Derivable entirely from existing fields; no new storage. This is what
   turns an empty Review tab from "broken?" into "expected."
9. **A recovery action on "None found".** Offer *Add address by hand*, writing `contactEmail` with
   `emailSource: 'manual'` — deliberately not `'scrape'`, which correctly leaves the personal-inbox
   gate off for a hand-entered address (the precedent is the manual-lead fix in
   `lead-generation.ts`). Under Phase 1 this promotes the lead into Review the moment an address
   exists.
10. **A "look again" action.** `signals->>'enrichAttemptedAt'` permanently suppresses re-scraping, so
    a company that publishes a contact page next month is never revisited. Clearing the stamp for a
    single lead re-queues it. Per-lead only — never a bulk re-scrape, which would be a spend and
    politeness problem.
11. **Stop "Checking…" from lying.** It is the fallback for any hot/warm lead with no stamp
    (`contactState()` line 111), including runs that have finished or died — the known accepted edge.
    Once the latest job is terminal, a lead with no stamp is *not* being checked; it should read
    "Not attempted" with the reason.
12. **Align the CSV export to HubSpot/Salesforce import shape.** Every tool in the scan integrates
    both; we ask users to adopt Contacts as their CRM instead, which is fine for an SMB with no CRM
    and a blocker for anyone who has one. We already ship `format=csv` on `assistant-records`
    (line 5) — matching the column headers is close to free and removes the objection without
    building or maintaining two integrations.

## Phase 3 — draft on demand, not on discovery (optional, highest saving)

The scorer writes a full personalised email body for every hot/warm lead at scoring time
(`discovery-scoring.ts:126`), before anyone has decided they want the company and before enrichment
knows the address. Reject twelve of fifteen and twelve drafts were written and binned; the survivors
were drafted without knowing the recipient (`to` is usually null).

13. Move drafting to the moment a lead is approved as a target **and** has a resolvable address.
14. Remove `outreachDraft` from the scoring prompt's output contract; `discovery-scoring.ts` keeps
    `doNotContact`, which still has to gate.

Payoff: stop paying to write mail nobody sends, and produce a better draft because it can use the
enriched contact. Cost: a new generation call on the approval path, and Review's contents then
depend on a model call succeeding — so this phase needs a visible failure state ("draft could not be
written — retry") rather than a lead that silently never appears. That is why it is last, and
separable.

## Risks and things this deliberately does not do

- **It makes the assistant look like it does less** — *until Phase 2 item 6 lands.* If ~90% of
  discovered leads cannot be emailed, Review is near-empty, which is the truth the current design
  hides by putting everything in Review. Item 8 makes that emptiness read as informative rather than
  broken; item 6 (paid waterfall) is what actually fixes it. **Sequencing matters here:** shipping
  Phase 1 alone converts a full-looking Review tab into an empty one and will feel like a
  regression, so pair it with item 8 at minimum.
- **Do not build a sequencer.** Outplay, Instantly and Reply own multichannel cadence and
  deliverability outright. Chasing parity means fighting three specialists on their turf while our
  discovery advantage — the long tail no database holds — goes unexploited. Single touch plus the
  existing chase reminder is the right scope.
- **Outcome pricing is parked, not rejected.** Leadzen sells $2000 for 10 meetings; it fits the
  revenue-engine direction and suits a product whose value is qualified meetings rather than seats.
  But we cannot bill on meetings we cannot observe — nothing in our system witnesses one, and
  outcome capture today is self-reported. Revisit only once that loop genuinely closes.
- **Intent data is a word we share with Apollo and Cognism, not a capability.** Our `intent_signal`
  strategy is LLM-guessed search strings; theirs is observed behaviour (job posts, tech installs,
  funding). Keep the strategy, but do not let the shared vocabulary imply parity in user-facing copy
  — that is exactly the failure mode recorded in the public-copy-vs-system audit.
- **No change to `promoteOne`'s upsert.** It keys on `(org, assistant, 'lead', title)` and
  deliberately does not touch `approvalStatus` on an existing row
  (`process-discovery-jobs.ts:602-618`), so a re-run cannot resurrect an approved lead into Review.
  Preserve that. The known wart — two different companies sharing a name collapsing onto one
  record — is out of scope here.
- **No fourth tab.** The four-tab template (Overview · Data Hub · Review Queue · Calendar) is a
  platform-wide convention; this plan re-stocks Review rather than adding a surface.
- **No new approval state in Phase 1**, for the CHECK-constraint and drizzle-sync reasons above.
  Revisit only if the filter proves insufficient in use.
- **Phase 0 adds a step to a flow people want to be fast.** "Describe your idea and go" becomes
  "describe, read fifteen queries, approve, go." That is the right trade when a run costs real search
  calls and produces leads you must then triage, but the brief has to be skimmable and pre-approved
  by default — a wall of JSON would make it worse, not better. If it proves unwanted for repeat
  campaigns, gate it to the first run of a new campaign only.

## Tests

Phase 0:
- Approving a brief seeds the first job's cursor, and the worker's `query_gen` stage is then skipped
  (assert no second generation call — this is what keeps the phase cost-neutral).
- Editing a query before approval changes what the worker actually searches.
- A campaign created but not approved stays `draft` and never dispatches.
- A scheduled re-run generates fresh queries rather than replaying the approved list verbatim.

Phase 1–2:
- `assistant-records` returns only deliverable leads under `deliverable=1`, and is unchanged
  without it (guards other record types).
- A `pending_approval` lead with no recipient appears in Leads and **not** in Review.
- Adding an address by hand moves that lead into Review.
- Approving a lead from Leads does not send.
- Recipient precedence is identical across the extracted helper and `_rqRecipient`.
- The campaign card reports this run separately from the campaign total; a re-run finding zero new
  domains reports zero for the run.
- The paid provider is only called on a scrape MISS, never before it, and never past
  `maxEnrichmentCallsPerRun`.
- With the provider key unset, enrichment behaves exactly as it does today (env-gate holds).
- A purchased address carries its own `emailSource`, and the personal-inbox gate still fires on a
  named-person address whatever its provenance.
- A captured social handle never reaches a send path — it is rendered as a link only.

Existing suites to keep green: `tests/lead-contact-column.test.ts` (pins the mirror-on-miss and the
`rating IN ('hot','warm')` scrape gate) and `tests/discovery-start-now.test.ts`.

## Open question

Whether the 15-lead run that prompted this was a fresh campaign or a re-run of the existing one.
It does not change the design, but it settles whether the count in item 5 was also wrong at the time
of the complaint.
