# Discovery: resolving a search hit to the company it's actually about

Scoped 2026-08-08, at the point where the query-generator fix landed. Requested as "the root domain
rewrite", which turns out to be two different features wearing one name — separating them is most
of the value of this document.

Status: **Case A BUILT 2026-08-08** (`resolveCandidateDomain` + `fetchSiteIdentity` + worker
wiring, `tests/discovery-candidate-resolution.test.ts`, 18 checks). Not deployed, not yet exercised
against a live search. **Case B remains scoped only** — see the decision points under it.

⚠️ **Building Case A turned up a bigger problem than Case A.** A test written to assert that the
prod noise stayed dropped failed, and the reason was that **none of it was ever being dropped**: all
20 sampled domains from the 2026-08-08 run passed `classifyCandidate` untouched. The deterministic
filter — the cheap pre-scoring floor — caught nothing, and every drop happened at the scorer, at
full token cost. `huffpost.com` was blocklisted while `huffingtonpost.co.uk`, the domain that
actually ranked, was not; there were no podcast hosts and no startup job boards at all. Fixed by
extending the media/jobs/aggregator lists: 10 of 16 sampled domains now drop before scoring, and
every known-good UK prospect fixture still passes. The five SaaS vendors (adobe, hubspot,
salesforce, hootsuite, shopify) are deliberately left to the scorer — that is the documented
two-layer split, and it rated all five cold correctly.

## What this is, and what it is not

The worker takes the **domain of a search result** and treats it as the prospect
(`process-discovery-jobs.ts`, candidate filter → `discoveredLeads.domain`). Every consequence
follows from that one line: a hit on someone else's site becomes a lead for that someone else.

⚠️ **This is a RECALL feature, not a fix for what went wrong in prod.** The prod run failed because
the queries were aimed at directories, job boards and press — already fixed by rewriting the
query-gen prompt. Nothing below would have saved that run. This work recovers prospects we
currently *discard*, and (in Case B) unlocks a class of query we currently cannot use at all.

## The two cases

They share a symptom and nothing else.

| | Case A — same company, wrong page | Case B — different company entirely |
|---|---|---|
| Example hit | `alofttrophyclub.com/blog/how-to-host-a-retreat` | `linkedin.com/jobs/view/123` for "Acme is hiring" |
| | `blog.foo.co.uk`, `careers.foo.co.uk` | `trustpilot.com/review/acme.co.uk` |
| The prospect is | **already in the URL** | **named in the page, not the URL** |
| Fix | strip to the root domain | extract an entity from content |
| Correctness | deterministic — same legal entity | inference — can be wrong |
| Cost | one HTTP fetch, no tokens | fetch + parse, often an LLM read |
| Unlocks intent queries? | **no** | **yes — this is the whole point** |

Calling both "the root domain rewrite" is what makes this look like one small change. Case A is
half a day. Case B is a feature with a spend decision attached.

## Case A — strip to the root domain

`classifyCandidate` already identifies these precisely, and the categories are the trigger:

- **`non_company`** — `labels[0]` is in `NON_COMPANY_SUBDOMAINS` (`blog`, `news`, `careers`,
  `jobs`, `support`, `community`, …). Strip that one label.
- **`content_page` on a domain that is NOT otherwise blocklisted** — the article lives on a real
  company's own site. Keep the domain, discard the path.

A `content_page` verdict on a *blocklisted* domain (a Digiday article, a Medium post) stays dropped:
stripping `digiday.com/some-article` yields `digiday.com`, which is still not a prospect.

### ⚠️ Four constraints found in the code, all of them load-bearing

1. **Never strip labels blindly.** `foo.co.uk` → last-two-labels gives `co.uk`. There is no
   public-suffix list in this codebase, and `.co.uk` is most of the UK SMB target market, so a
   naive apex extraction would corrupt the majority of real prospects. Strip **only** when
   `labels[0]` is a known publishing subdomain — the check `classifyCandidate` already performs.
   Nothing else is safe without adding a PSL dependency.

2. **Re-dedupe after rewriting.** The in-slice `seen` set and the `(campaign_id, domain)` unique
   index both run against the *pre-rewrite* domain. Two blog posts from one company, or a blog post
   plus that company's home page, currently pass `seen` as distinct and would collide only at
   insert. Rewrite must happen **before** dedupe, not after.

3. **The title becomes the company name** — `companyName: c.title || c.domain!`. Rewrite the domain
   and keep the article title and the lead is called *"How To Host A Corporate Retreat"*, with a
   snippet describing an article. That misleads the scorer, and it is exactly why this was
   deferred the first time. Options, cheapest first:
   - use the bare domain as the name — honest, weak, and free;
   - fetch the root page and read its `<title>` — one request via `safeFetchText`
     (`src/utils/safe-fetch.ts`), the SSRF-guarded helper enrichment already uses;
   - defer naming to the `enriching` stage, which already fetches `/` — but scoring runs *before*
     enrichment and needs the name, so this only works if scoring is deferred too. It isn't. Reject.

   **Recommended: fetch the root page title.** Anything less feeds the scorer a lie, and the scorer
   is currently the only part of this pipeline demonstrably doing its job well.

4. **Budget the fetches.** `RESULTS_PER_QUERY = 10`, so a slice can hold ten candidates, on a tick
   that must finish in ~10s. Enrichment's precedent is `LEAD_BUDGET_MS = 6000` per lead, set after
   four slow-but-not-timing-out fetches compounded to 11.4s. A whole-slice budget (~4s, fetches
   concurrent, skip the rewrite and keep the drop when it expires) is the shape to copy.

### Expected value — modest, and worth stating plainly

My notes on a staging campaign put this at roughly 4–6 of 31 `content_page` drops being genuine
prospects. In the 35-lead prod sample it would have recovered close to nothing: that noise was
vendors, media and podcasts, i.e. Case B or simply not companies. **Do this because it is cheap and
correct, not because it will visibly change lead counts.**

## Case B — resolve a third-party page to the company it describes

This is where intent data lives, and today it is architecturally unreachable: "companies hiring a
social media manager" and "businesses with poor reviews on X" are exactly the queries a lead-gen
tool should run, and every one of them produces a lead for the job board or the review site. The
query-gen prompt now tells the model to avoid them — an honest workaround for a capability we lack,
not a decision that they are bad queries.

Three sub-cases, sharply different in cost:

- **B1 — the domain is IN the URL.** `trustpilot.com/review/acme.co.uk`,
  `g2.com/products/acme/reviews`. Deterministic extraction from the path; no fetch, no tokens.
  Per-site patterns, so it only ever covers sites we have written a rule for.
- **B2 — the domain is in the page.** A job advert linking the employer's site. One fetch plus link
  extraction; cheerio is already a dependency and the outbound link is usually unambiguous.
- **B3 — only a company NAME is present.** A press article naming a company with no link. Requires
  an LLM read *and* a name→domain lookup. **This is a search problem wearing a scraping costume,
  and it is where the fabrication risk lives** — the hard rule from the enrichment work applies
  unchanged: extraction only, never generative. A model asked to guess a company's domain will
  produce one that resolves and belongs to someone else.

**Recommendation: B1 and B2 only, if Case B is taken at all. B3 is out of scope permanently** under
the existing anti-fabrication rule.

Case B also needs answers that Case A does not:
- **Provenance.** A lead discovered *via* trustpilot must record that, or the Leads tab implies we
  found the company directly. `discovered_leads.signals` is jsonb; no migration.
- **The blocklist becomes conditional.** trustpilot.com must stay blocked as a *prospect* while
  becoming allowed as a *source*. That is a new distinction in `classifyCandidate`, which today
  answers one question with one boolean.
- **Guardrails.** Every resolved candidate is an extra fetch on a run that already has a cost cap.

## Recommendation

**Take Case A now; hold Case B behind a decision.**

Case A is a contained change to one filter and one candidate mapper, needs no schema, no vendor and
no new spend, and makes the pipeline correct where it is currently wrong. Roughly half a day
including tests.

Case B is a genuine capability — it is what would make `intent_signal` mean what Apollo and Cognism
mean by it — but it is a feature, not a fix: a new source/prospect distinction in the filter, a
provenance model, per-site extraction rules, and a fetch budget. It should be scoped on its own
merits **after** Phase 0, because Phase 0 changes who decides what a search targets, and that
changes what intent queries are even worth resolving.

## Non-goals

- **No public-suffix-list dependency.** Constraint 1 is satisfiable with the subdomain list we
  already maintain; adding a PSL to strip apexes generally is a bigger surface than the problem.
- **No re-processing of existing rows.** The 35 leads already banked stay as they are; the
  `(campaign_id, domain)` dedupe means a rewrite cannot retroactively apply to them anyway.
- **No relaxation of the anti-fabrication rule** (B3 above).
- **Case A does not unblock intent queries.** If the reason for doing this is intent data, Case A
  is not it, and shipping Case A alone should not be reported as having delivered that.
