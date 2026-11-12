# Lead Generator: "Why now" and watching saved leads — PLAN

2026-11-12. Nothing built yet. Prompted by a review of zero.inc, whose main lead-finding pitch is
"see who's worth a conversation and why now": a timing reason on every row, and agents that keep
watching companies for buying signals.

Goal: turn the Leads tab from "here is a list" into "contact these five today, and here is why".

**Markets: UK and US from day one.** Every source below is marked with the market it covers. A
lead in a market without a free register still gets the sources that work everywhere (team page,
careers page / job boards, news), so watching is never UK-only.

---

## 0. What exists today (read before building)

| Piece | Where | What it does now |
| --- | --- | --- |
| First score | `src/lib/discovery-scoring.ts` `scoreCandidates` | One score 0–100 + hot/warm/cold from a search snippet. Fit only. |
| Research pass | `src/lib/lead-intel.ts` (gather, no model) → `rescoreWithIntel` (one model call) → `deepEnrichLead` in `src/utils/lead-enrichment.ts` (verify + save) | 4 Serper queries (funding / hiring / expansion / publication), team pages, careers page. Returns `signals[] {summary, url, direction}`, people, hooks. Saved on `assistant_records.data.intel`. |
| Evidence dates | `IntelForScoring.evidence[].date` | Evidence items carry a date; **signals do not** — the model's signal has a URL only. |
| Showing research | `assistant-data-hub.js` `intelBanner()` | Lead panel shows findings with links, people, hooks, careers page. Not in the table. |
| Refresh sweep | `netlify/functions/lead-enrichment-sweep.ts` | Re-runs the whole research pass on stale leads. **Default OFF**, 25 leads/run across ALL tenants, operator-only. A trickle, not watching. |
| Companies House | `src/lib/companies-house.ts` | Search + officers at enrichment time. Company number, name, URL and up to 8 officers are saved on the lead (`companiesHouse` in `discovered_leads.signals` and the record's evidence). Filing history and company status are never read. |
| Ledger event | `src/config/revenue-events.ts` `signal_captured`; label in `src/config/lead-activity-events.ts` ("Picked up a buying signal") | Exists; nothing on the lead side writes it. |
| Leads columns | `src/components/assistant-dashboard-registry.js` (~line 990) | Lead, Approval, Contact, Score, Rating, Next step, Deletes in, Updated. |
| Country | `src/lib/discovery-search-area.ts` `resolveSearchArea` | Works out the search's country (`gb`, `us`, …) and sends it to Serper as `gl` and to the scorer. Not saved per lead. |
| US email rules | `src/config/outreach-footer.ts` | CAN-SPAM already covered: opt-out link + postal address on every outreach email. |

So the data for "why now" is half there (signals + evidence dates), and the cheapest watching
source (Companies House, free, company number already saved) is unused.

---

## Phase 1 — "Why now" on every researched lead (no migration)

### 1.1 Keep fit and timing apart
`rescoreWithIntel` returns, in addition to today's fields:

```
"timing": <0-100>,          // how strong the reason to contact them NOW is
"whyNow": { "summary": "<one sentence>", "url": "<one of the evidence urls>" } | null
```

- `score` / `rating` stay exactly as they are (fit-led), so every existing reader keeps working.
  Timing is a second number, not a change to the first.
- **The date comes from our evidence, not the model.** Persist looks up `whyNow.url` in
  `intel.evidence` and copies that item's `date`. No date on the evidence → `whyNow` is dropped.
  Same idea as `verifyPeople`: the model may only point at what we gathered, and an undated
  page is not a reason to contact anyone *now*.
- Signals get the same treatment: each saved signal gains `date` (looked up by URL, never taken
  from the model).
- Leads that were never researched have `timing: null` — "not checked", which is shown
  differently from "checked, no reason". (Same rule as unrated ≠ cold.)

### 1.2 Timing fades
Stored: the evidence date. Worked out when read (one pure helper in `src/config/lead-why-now.ts`,
used by the table, the panel, chat and the roll-up):

| Evidence age | Shown as |
| --- | --- |
| ≤ 30 days | fresh — "3 weeks ago" |
| 31–90 days | cooling — greyed |
| > 90 days | gone — no Why now shown; still listed in the panel's findings |

Never store a "fresh" flag; it would be wrong a month later.

### 1.3 Show it
- **Leads table:** new synthetic column `whyNow` ("Why now") after Rating — the sentence + its age,
  linked to the source. Sorts by freshness; filter "Has a reason now". On phone cards it replaces
  Score (Score already has `phone: false`).
- **Lead panel:** the Why now line sits at the top of `intelBanner()`, above the findings.
- **First email:** the drafter's opener uses `whyNow` when it is fresh (it already uses hooks;
  this makes the strongest dated one the default).
- **Chat (parity rule):** the Lead Generator chat can answer "who should I contact today?" from the
  same helper and return the list as a card with "Open lead" / "Move to Outreach" buttons (the
  existing `leadAssistantStep` rules — research and move only, never send).

### 1.4 Existing leads
No bulk re-run (it costs money). Old intel has signals without dates, so it shows no Why now until
"Research again" is pressed or Phase 2/3 picks the lead up. Say so in the help article.

### 1.5 Tests
- Persist drops a `whyNow` whose URL is not in the evidence, or whose evidence is undated.
- Fade helper at 30/31/90/91 days.
- Column renders "not checked" vs "no reason now" vs a reason.
- Prompt ↔ surface coupling test still passes (`lead-prompt-surface-coupling`).

---

## Phase 2 — Watching saved leads: free sources (needs SQL)

Separate from `lead-enrichment-sweep.ts`. That one re-reads everything with a model; this one
**looks for changes**, cheaply, and only spends when something actually changed.

### 2.1 Which leads are watched
A lead is watched when all of these hold:
- the assistant's watching switch is on (2.6);
- not retention-deleted, not do-not-contact, no outcome recorded (same exclusions as the sweep);
- it has a domain or a Companies House number;
- **including** leads already emailed with no reply — a new reason is exactly what a follow-up needs.

Per-assistant cap (operator env `LEAD_WATCH_MAX_PER_ASSISTANT`, default 300), most recent first.

**Which country a lead is in** decides which register is checked. Worked out once, when the lead
is first watched, and saved on `lead_watch.country`, in this order:
1. matched on Companies House → `gb`;
2. the search's own country (`resolveSearchArea` on the job that found it);
3. the web address's country code (`.co.uk` → `gb`, `.us` → `us`);
4. otherwise unknown → only the sources that work everywhere.

A `.com` from a "plumbers in Texas" search resolves to `us` from step 2. Nothing guesses from the
company's name.

### 2.2 Sources in this phase (no per-lead charge)

| Source | UK | US | Elsewhere |
| --- | --- | --- | --- |
| Companies House filings | ✅ | — | — |
| SEC EDGAR filings (Form D = raised money) | — | ✅ | — |
| Team page: new people | ✅ | ✅ | ✅ |
| Careers page + public job boards | ✅ | ✅ | ✅ |

**Companies House (UK)** — one call per check: `GET /company/{number}/filing-history?items_per_page=10`,
plus `GET /company/{number}` for status every 4th check. Changes we turn into signals (fixed
wording, **no model**):

| Filing | Signal | Direction |
| --- | --- | --- |
| AP01 / AP02 / AP03 | "Appointed a new director: {name}, {date}" | positive (new decision-maker) |
| TM01 | "{name} stepped down as director, {date}" | neutral (contact may have left — check the named person) |
| AD01 | "Moved registered office, {date}" | positive (move / growth) |
| MR01 | "Registered a new charge (borrowing), {date}" | positive (spending) |
| Company status → liquidation / dissolution / administration | "Companies House shows {status}" | negative |

Rate limit is 600 requests / 5 min per key; the worker paces itself well under that.

**SEC EDGAR (US)** — free, no key, 10 requests/second. The US has no national company register
like Companies House (registration is per state), but EDGAR holds the filing that matters most
for a buying signal: **Form D**, which private companies file within 15 days of raising money.
- *Linking a lead to EDGAR* (once): EDGAR full-text search for the company name, `forms=D`. Link
  only when the name matches (same normalising as `companies-house.ts`) **and** the filing's
  business address is in the same state as the lead (from its site or the search). Anything less
  → not linked. A wrong match would tell a user a stranger raised money. Store the CIK.
- *Watching* (weekly): `data.sec.gov/submissions/CIK{10 digits}.json`, new accession numbers only.

| Filing | Signal | Direction |
| --- | --- | --- |
| D (new) | "Raised ${amount} (SEC Form D), {date}" — amount read from the filing's XML | positive |
| D/A | "Updated its fundraising filing, {date}" | neutral |
| 8-K (public companies only) | "Filed a material event with the SEC, {date}" | neutral (the model reads it in Phase 3) |

- ⚠️ SEC requires a User-Agent with a contact. Use an operator env `SEC_USER_AGENT`
  ("Be More Swan ops@…"), never the workspace's or user's email.
- Most US small businesses never file a Form D, so for many US leads EDGAR stays unlinked and the
  sources below do the work. That is expected, not a failure. Say so in the help article.

**Team page (everywhere)** — `lead-intel.ts` already reads team pages and `verifyPeople` already
keeps only names printed there. Watching stores the names seen; a new name with a decision-maker
title (`isDecisionMakerTitle`) → "New on their team page: {name}, {title}". This is the US (and
everywhere else) stand-in for the UK's director appointments. One fetch per page, up to 2.

**Careers page + public job boards (everywhere)** — paths already known (`CAREERS_PATHS` in
`lead-intel.ts`). When the careers page links to a hosted job board, read its free public JSON
instead of the page text:
- Greenhouse `boards-api.greenhouse.io/v1/boards/{token}/jobs`
- Lever `api.lever.co/v0/postings/{company}?mode=json`
- Ashby `api.ashbyhq.com/posting-api/job-board/{name}`
- Workable `apply.workable.com/api/v1/widget/accounts/{name}`

These give exact titles and posting dates, which makes "why now" dated. Otherwise store a hash of
the page text and the job titles found. A new title → "Now hiring: {title}"; a careers page where
there was none → "Started a careers page". One fetch per check.

### 2.3 First look is silent
The first check of a lead only records a baseline. Otherwise switching watching on would fire a
signal for every director appointed in 2014.

### 2.4 Storage — new table (SQL on BOTH DBs before deploy)

```
lead_watch (
  assistant_record_id  int primary key references assistant_records(id) on delete cascade,
  organisation_id      int not null,
  ai_assistant_id      int not null,
  next_check_at        timestamptz not null,
  last_checked_at      timestamptz,
  country              text,       -- 'gb' | 'us' | other ISO code | null (2.1)
  ch_number            text,
  ch_last_filing_id    text,       -- newest transaction_id seen
  ch_status            text,
  sec_cik              text,       -- US, only when the 2.2 link rule passed
  sec_last_accession   text,
  team_names           jsonb,
  careers_source       text,       -- 'page' | 'greenhouse' | 'lever' | 'ashby' | 'workable'
  careers_hash         text,
  careers_titles       jsonb,
  seen_urls            jsonb,      -- Phase 3: news URLs already judged
  paused_reason        text
)
index on (next_check_at) where paused_reason is null
```

A table rather than `data` jsonb because the worker asks "which leads are due?" across every
tenant, and that must be an index read. Signals themselves go on the lead
(`data.intel.signals`, with `source: 'watch'`) so the panel and Phase 1's helper read one list.

⚠️ `prospect-erasure.ts` must clear `lead_watch` and the watch signals on the record;
`workspace-export.ts` must include watch signals. Add both to the tests.

### 2.5 Worker
- New cron `lead-watch-sweep` (daily, 05:00 UTC) → background function, sliced like discovery
  runs (claim a batch by `next_check_at`, atomic claim, back-to-back drain).
- Fair share: round-robin across workspaces so one big tenant cannot starve the rest.
- Each source paces itself to its own limit (Companies House 600 / 5 min, EDGAR 10 / s).
- Check every 7 days; a lead with a fresh positive signal is checked again in 3.
- On a change: append the signal, update `whyNow` if it is positive and fresher, write
  `signal_captured` to the revenue ledger (lead activity feed shows "Picked up a buying signal").
- A **negative** status (liquidation etc.): pause that lead's follow-ups (halt reason — add
  `company_closed` to `SEQUENCE_HALT_REASONS` + label) and flag the lead. Do **not** set
  do-not-contact; that stays the audited path.
- Operator switches: `LEAD_WATCH_ENABLED` (default off until checked on staging),
  `LEAD_WATCH_MAX_PER_RUN`.

### 2.6 Telling the user — once a day, not per signal
- Sent in the workspace's own morning (its time zone, not UTC), so a US workspace isn't told at
  midnight. Dates are shown as "3 weeks ago", which avoids UK/US date-order confusion.
- One daily roll-up per assistant with new positive signals: Team Chat note + Inbox "Needs you"
  item ("3 leads have a new reason to get in touch") via `notify.ts`, linking to the Leads tab
  filtered to "Has a reason now". Same once-a-day rule as the assistant bubbles.
- Add a line to the existing morning summary.
- Nothing is sent to a prospect and nothing is moved to Outreach automatically.

### 2.7 Settings — GUI and chat
- Lead Generator Settings: "Watch my leads for reasons to get in touch" switch, with what is
  watched and how often.
- Chat card to turn it on/off, and "what changed with my leads this week?" answered from the
  signals (chat proposes, never spends).

### 2.8 Tests
- Filing → signal mapping for each type in 2.2 (Companies House and EDGAR); unknown types ignored.
- Country resolution order in 2.1, including a `.com` from a US search → `us`.
- EDGAR link refused when the name matches but the state does not.
- Each job board's JSON parsed from a saved sample; a changed board falls back to the page hash.
- First look writes no signals.
- Erasure clears the watch row; export includes watch signals.
- Excluded leads (deleted / DNC / outcome) are never claimed.
- Roll-up sends at most one note per assistant per day.

---

## Phase 3 — News watching + re-score on a real change (spends tasks)

- One Serper query per watched lead every 14 days, past month only, company name + domain, sent
  with the lead's country as `gl` (UK news for UK leads, US news for US leads; none when unknown).
- **US option, later: federal contract awards** (USAspending.gov API, free, no key). A new award
  to a lead is a strong "why now" for businesses that sell to government. Off by default, only
  worth adding if US customers target those businesses.
- Only results whose URL is **not** in `seen_urls` go to a model, in one small call that says
  whether this is about this company and what it means (same evidence-only rules as
  `rescoreWithIntel`). Most checks find nothing new and cost one search, no model.
- When Phase 2 or 3 finds a positive change on a lead rated cold, run one `deepEnrichLead`
  (budget permitting) so the score catches up. Today a cold lead never gets re-read.
- Costs go through the task system: new keys in Admin → Money → Task costs (`getTaskCosts()`,
  never a constant; defaults in `src/config/task-weights.ts`). Background work spends tasks under
  `unified_task_metering`. Agreed defaults:

| Key | Tasks | When it's charged |
| --- | --- | --- |
| `lead_watch_news` | **1** | only when the model reads a new article about a lead. A check that finds nothing new is free. |
| `lead_watch_rescore` | **1** | each re-research of a cold lead after a real change (same scale as `lead_search` and `mentor_research`). |
| Phase 2 sources | **0** | Companies House, EDGAR, team page, careers/job boards: no per-lead charge. |

  Why: our cost per news check is about £0.001 (one search); a model read is a few pence; a
  re-research is up to 4 searches + one model call. Charging only when the model actually works
  keeps a quiet month at zero.
- Ceiling per assistant per month (operator env `LEAD_WATCH_MAX_TASKS_PER_MONTH`, default 30). When
  it is reached, news checks stop until next month and Settings says so. Watching with the free
  sources carries on.
- Help/pricing copy uses `{{tasks.key}}` placeholders.

---

## Phase 4 — Prove it works

- Results tab line: reply rate for leads first emailed within 14 days of a fresh signal vs the
  rest (join `signal_captured` to `outreach_sent` / `replied` in the ledger).
- Per-source breakdown (Companies House / careers / news) so we can drop a source that never
  leads to a reply.

---

## Decisions (owner, 2026-11-12)

1. **Default for existing workspaces:** free sources (Phase 2) ON for every Lead Generator; news
   (Phase 3) OFF until tested. ✅ agreed
2. **Task costs:** news read 1, re-score 1, free sources 0, 30/month ceiling (table in Phase 3).
   ✅ left to Claude's recommendation
3. **A new positive signal restarts the 30-day deletion countdown.** ✅ agreed
4. **Company closed → pause follow-ups automatically and tell the user.** ✅ agreed. In the US this
   comes from news (Phase 3), as there is no free national status check.
5. **Leads already emailed with no reply stay watched.** ✅ agreed
6. **US included from day one.** ✅ owner, 2026-11-12. EDGAR + team page + job boards in Phase 2,
   US news in Phase 3, a named person for US leads (Phase 5), US status and officer changes
   (Phase 6).
7. **OpenCorporates licence** — OPEN. Decide after Phase 6.1 shows how many US leads fall outside
   the free states (6.2).

---

## Phase 5 — A named person for US leads (contact search)

### 5.1 The gap
The contact search (`runContactWaterfall` in `src/utils/lead-enrichment.ts`) runs: website →
Companies House → Hunter. For a US lead the middle step finds nothing, so a US lead gets a named
person only if their site prints one with a senior title, or Hunter's domain search returns one.
UK leads have a second chance from the register; US leads don't.

### 5.2 A US register step in the same place
US waterfall: website → **US register** → Hunter. Chosen by `lead_watch.country` / the same
country rule as 2.1 (the step is skipped when the country is unknown). It returns officers in the
same shape as Companies House (`CompaniesHouseOfficer`-like: name + role), so `lead-person.ts`
needs no new branch, just a second register source.

Sources, in order, all free:

| Source | What it gives | Coverage |
| --- | --- | --- |
| SEC Form D "related persons" (Item 3, `relatedPersonsList` in the filing's XML) | Executive Officer / Director names | Only companies that raised money. Uses the EDGAR link from 2.2 (same strict name + state rule). |
| State open data registries (Socrata APIs, no key) | Officers / principals / members / managers by name | Per state. Start with the ones that publish principals: **Connecticut** (data.ct.gov, principals dataset), **Colorado** (data.colorado.gov business entities), **New York** (data.ny.gov active corporations; check which officer fields it really has), **Florida** (Sunbiz free bulk files with officers; check terms and format). |
| OpenCorporates (paid, Phase 6 decision) | Officers for the other states | Only if the owner buys a licence. |

- One module `src/lib/us-registries.ts` with one adapter per state (same pattern as
  `site-builders/<key>.ts`), each read from a saved sample in its tests. Dataset IDs and field
  names come from each dataset's metadata (`/api/views/{id}.json`), not CSV headers, which differ.
- Adding a state = one adapter + one sample. The plan doesn't promise 50 states.

### 5.3 Matching rules (a wrong person is worse than none)
- **Legal name vs trading name.** US small businesses often trade under one name and are
  registered under another ("Joe's Plumbing" → "JPS Holdings LLC"). Look up the trading name
  first, then the legal name printed on their own site (footer "© 2026 JPS Holdings LLC", terms or
  privacy page). Never guess a legal name.
- Name normalising: extend `normaliseCompanyName` with US endings (LLC, L.L.C., Inc, Corp,
  Corporation, Co, PLLC, LP, LLP, DBA).
- A match needs the name **and** the same state, plus city or ZIP when the site shows one. Same
  "or nothing" rule as `chooseCompany` for Companies House.
- **Never use the registered agent.** Many US companies list a commercial agent (CT Corporation,
  Northwest Registered Agent, Registered Agents Inc, Incorp Services…). Agents are not the
  business. Use only officers / principals / members / managers, and drop any name that matches a
  known agent-company list.
- **Never keep addresses.** Some state datasets (Connecticut's principals) publish home addresses.
  Store name + role only; the address is used for matching in memory and then thrown away.

### 5.4 Who is chosen
`lead-person.ts` order becomes the same for both countries:
1. on their own site with a senior title **and** on the register (Companies House or US register);
2. on their own site with a senior title;
3. on the register with a senior role (UK director; US executive officer / director / managing
   member / president);
4. returned by Hunter with a senior title and an address.

A register-only person has a name but no address. Their email comes from Hunter's find-by-name
lookup (`email-finder`, already in `discovery-enrich-provider.ts`), which is a paid lookup and
already counted by the existing enrichment budget. No new charge to the user.

### 5.5 Privacy (US)
- Officer names on a public register are "publicly available information" under California's
  CCPA, but a prospect can still ask us to delete their data. The existing erasure path
  (`prospect-erasure.ts`) covers register names; add a test.
- The source is shown beside the name ("From the Connecticut business register"), like
  Companies House today.

### 5.6 Tests
- Each state adapter parses its saved sample; an unknown state returns "no register", not an error.
- Registered-agent names are never chosen.
- Name matches but state differs → no match.
- Legal name taken from a site footer; none found → trading name only.
- Erasure clears register names on US leads.
- Measure before/after on staging: share of US leads with a named person.

---

## Phase 6 — US company status and officer changes (watching)

### 6.1 Free states first
The same state datasets update daily, so Phase 2's watching can read them for US leads matched in
Phase 5 (`lead_watch.us_state`, `us_entity_id`, `us_status`, `us_principals`):

| Change | Signal | Direction |
| --- | --- | --- |
| New officer / principal | "New officer on the {state} register: {name}, {role}, {date}" | positive |
| Officer removed | "{name} is no longer listed as {role}" | neutral |
| Status → dissolved / administratively dissolved / revoked / withdrawn | "{state} register shows {status}" | negative → pause follow-ups (decision 4) |
| Status → delinquent / not in good standing | "{state} register shows a late annual report" | neutral — **does not** pause. Delinquent usually means a missed filing, not closing. |

First look is silent, as in 2.3. Each state's status words are mapped in its adapter; an
unmapped status is logged and ignored, never treated as closing.

### 6.2 OpenCorporates for the other states (owner decision, not built until decided)
- Covers officers and status across US states, but commercial use needs a paid key, and showing
  the data to our customers needs an **external distribution** licence (Enterprise terms), not
  just internal use.
- Price, from third-party sources (check the official pricing page): API plans from about
  £2,250/year (Essentials), £6,600 (Starter), £12,000 (Basic); Enterprise priced on request.
- Recommendation: build 6.1 first, then count how many watched US leads sit in states with no
  free register. Price OpenCorporates only if that share is large and US customers are using the
  Lead Generator. Until then, US closures outside the free states come from news (Phase 3).
- If bought: it becomes one more adapter in `us-registries.ts`, used last, so the free state
  sources always win.

### 6.3 Tests
- Status mapping per state, including delinquent ≠ closed.
- A closure pauses follow-ups with the `company_closed` halt reason and tells the user once.
- OpenCorporates adapter (if built) is never called while the switch is off.

## Order of work
1 → 2 → 3 as planned. 5 can start beside 2 (it shares the EDGAR link and needs no table). 6
follows 2 and 5 (it needs the watch table and the state matches).

## Release checklist
- `db/z-lead-watch.sql` applied on BOTH DBs before deploy (Phase 2).
- `COMPANIES_HOUSE_API_KEY` set on both sites (already needed by the contact search).
- `SEC_USER_AGENT` set on both sites (an ops mailbox, never a user's).
- Task cost rows `lead_watch_news` / `lead_watch_rescore` added on both DBs (Phase 3).
- Phase 6 adds `us_state`, `us_entity_id`, `us_status`, `us_principals` to `lead_watch` — one
  more SQL file on both DBs.
- Each state dataset's terms checked before its adapter ships (Phase 5).
- Help article SQL (both DBs) at release: "Why now" + watching.
- Do not add watching to public pages / pricing until it is live on prod.
