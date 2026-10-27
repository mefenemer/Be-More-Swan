# Lead Generator — one-pass contact search plan

**Status:** 2026-10-27. **§5.1–§5.8 BUILT, not deployed.** ⚠️ Needs `COMPANIES_HOUSE_API_KEY` on staging and prod (without it step 2 is skipped) and the help SQL applied. Not yet run against live Hunter / Companies House. Extends `docs/lead-generator-completeness-plan.md`
(§0's principle: a search goes as deep as it can in one run). Cite from code as
`docs/lead-search-one-pass-plan.md §N`.

## §0 What the owner asked for (2026-10-27)

> The initial search should return as much information as possible, so extra buttons are not needed.
> Read the website fully and Companies House first; Hunter is the LAST option — to save cost without
> lowering the quality of the search.

The goal for every company a search keeps: **a named decision-maker, their job title, an address to
write to, and the source of each** — or a plain statement that none of it is published anywhere we
can check.

## §1 What a search does today (the gaps)

`enrichBatch` in `netlify/functions/process-discovery-jobs.ts`, 5 leads at a time:

| Step | Today | Gap |
|---|---|---|
| Website | `enrichLeadContact` reads homepage + up to 4 linked pages + fixed paths, **stops at the first address** | Stops at `info@` and never looks for a person; team/about pages are only read by the Research button |
| Names | None during the search | People are only found by **Research this lead** (`deepEnrichLead`), per lead, by hand |
| Companies House | Not used anywhere | — |
| Hunter | Domain Search on a website miss, `target_business` only, prefers a role address | **Names and positions it returns are discarded**; never asked for a named person's address |
| Company news / re-score | Only by the Research button | Rating stays on one search snippet |

Hunter is already only called on a website miss, so §2's cost saving comes from the website and
Companies House steps answering more leads before Hunter is reached — not from a change to how
Hunter itself is called.

## §2 The new order (the waterfall)

Each step only runs for what the earlier steps did not find. Free steps first, paid steps last.

1. **Website, fully (free).** One crawl, shared by contact and people: homepage, the site's own
   contact / about / team / policy links (`discoverSitePaths`), then the fixed guesses. Collect **all**
   addresses (not the first) and every named person with a job title. Stop when the page budget runs
   out, not at the first address.
2. **Companies House (free, UK only).** Match the company by name + postcode/town; read active
   officers (directors, LLP members) and the registered office. Names only — Companies House holds
   no email addresses. A match must agree on name AND location, or it is not used.
3. **Pick the person.** Prefer a person named on their own site whose title reads as an owner /
   director / founder / manager; else a Companies House director whose name also appears on the
   site; else the sole active director.
4. **Match person ↔ address from what we already have (free).** If step 1 found an address whose
   local part matches the chosen person (`debbie@`, `d.smith@`), use it.
5. **Hunter Email Finder — only if we have a name but no address for that person.** One call, name +
   domain. Hunter charges only when it returns an address (to be re-checked against our account
   before build — see §6).
6. **Hunter Domain Search — the last resort.** Only when steps 1–5 produced **no address at all**.
   Keep the names and positions it returns (today they are thrown away).
7. **Company news, in the same run.** The four signal searches the Research button runs today
   (funding, hiring, expansion, news) + the re-score, for every lead that is hot/warm or a
   `target_business`. The button stays for re-checking a lead weeks later.

**Never guessed.** No `firstname@domain` patterns, and the fabrication guard stays: a name is kept
only if it appears on a page we opened or in the Companies House record.

## §3 What the user sees

- The lead row shows **Name · Job title · Address**, each with where it came from (their website /
  Companies House / Hunter).
- A lead with a role address and no named person says so ("info@ — no named person published").
- A lead with nothing says "Not published on their site, Companies House or Hunter" — so the user
  knows there is nothing a button would find.
- The search's finish notification counts: named people found, addresses found, by source.

## §4 Rules that do not change

- **Named addresses** keep `emailKind: 'personal'` and the existing personal-inbox confirmation
  before any send (UK GDPR/PECR — a sole trader is an individual). `emailSource` gains
  `'companies_house'` only for names, never for an address.
- **Paid gate:** Hunter (both calls) stays limited to companies the scorer called `target_business`,
  and inside `maxEnrichmentCallsPerRun` (200). A Hunter `error` is still not a miss
  (`ProviderOutcome`), and is retried next run.
- **Both tables move together** (`discovered_leads.signals` and `assistant_records.data`) through the
  one writer, `recordEnrichment` in `src/utils/lead-enrichment.ts`.
- **Erased leads** are never re-collected.
- Robots.txt and `safeFetchText` (SSRF guard) apply to every page, as today.

## §5 Build order

| § | What | Notes |
|---|---|---|
| 5.1 | One shared crawl: contact + people from the same pages; collect all addresses | `discovery-enrich.ts` + `lead-intel.ts` share pages instead of fetching twice |
| 5.2 | Companies House client + company matcher | `src/lib/companies-house.ts`; env `COMPANIES_HOUSE_API_KEY`; 600 requests / 5 min limit |
| 5.3 | Person picker + person↔address match | Pure function, unit-tested |
| 5.4 | Hunter Email Finder + keep Domain Search names | `discovery-enrich-provider.ts`; same three-outcome contract |
| 5.5 | Waterfall in `enrichBatch` and `enrichOneLead` | Same order for the search and the per-lead buttons |
| 5.6 | Company news + re-score inside the run | Time and token budget per slice; cap per run |
| 5.7 | Leads tab: Name / Title / Source; finish notification counts | GUI and chat read the same fields |
| 5.8 | Help article + chat prompt say what a search now finds | Dated help SQL file, never the retired seed |

**As built:** the waterfall is `runContactWaterfall` (src/utils/lead-enrichment.ts), used by the
worker's `enrichBatch` and by `enrichOneLead`. The research pass is `researchBatch` in
process-discovery-jobs.ts, inside the same `enriching` stage (no new stage or column): it runs once
every lead's contact step is done, stamps `signals.researchedAt`, and calls `researchAndName`, which the
"Research this lead" button also uses. A found role inbox stays `contactEmail`; the person's own address
is `contactPersonEmail` beside it. Tests: tests/lead-person.test.ts.

**Known gaps:** the research model call is not counted against `maxTokensPerRun`, and its time is
bounded only for gathering (`deadline`), not for the model call itself — a slice on the 10-minute cron
path can run long. The outreach draft is not yet told the chosen person's name.

## §6 Open decisions and checks

1. **Companies House API key** — owner registers (free) at the Companies House developer portal and
   adds `COMPANIES_HOUSE_API_KEY` to staging and prod. Check the reuse terms for a commercial product.
2. **Hunter credit rules** — Hunter's help articles disagree on Domain Search pricing; read the
   account's `/v2/account` usage before and after a staging run to measure real credits per lead.
3. **Named person when the site already gives `info@`?** Default: yes, run steps 2–5 for hot/warm and
   `target_business` leads, so the user gets a person to address even when an inbox exists.
4. **Company news for every kept lead** — adds a model call per lead; default limited to hot/warm and
   `target_business`.
5. **Non-UK leads** skip step 2; their order is website → Hunter, as today.
