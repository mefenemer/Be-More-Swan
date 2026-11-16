# Buying triggers — PLAN (feature request #36)

2026-11-15. **Phase 1 built and LIVE on prod (engine + FSA feed, Admin only); nothing else built.** All nine owner
decisions taken 2026-11-16 (§10). UK first, then the US.
**Is it disruptive, is it worth building, will it bring leads?** See §9 (added 2026-11-15).

The ask: *"What are your thoughts on this? I want the biggest value items to consider building into Be More Swan
assistants"*, about a long list of buying-trigger signals and tools, plus the Autobound article on trigger tools.

Builds on two plans, and does not repeat them:
- **docs/new-business-alert-plan.md** (FR#30): daily new-incorporation feed, `new_companies` table, "New businesses"
  lead source, formation-agent flag, UK + US rules.
- **docs/lead-why-now-and-watching-plan.md**: `timing` + `whyNow` on researched leads, `lead_watch` table, Companies
  House filing history (AP01/TM01/AD01/MR01/status), SEC Form D, team page, careers page + ATS job boards, news.

---

## 1. Short answer

- **Most of the list is built for a different customer.** The Autobound article (written by a vendor, figures not
  independently checked) groups triggers into eight kinds (hiring, funding, technology, executive moves, expansion,
  contraction, regulation, product launches). Its main point is that a trigger loses value fast: funding is typically
  spent within 30 to 90 days, and a new senior hire makes buying decisions within about 60 days. The tools it covers
  cost $15k–$150k a year (Autobound, UserGems, Bombora, 6sense, ZoomInfo), apart from Apollo and Lead411. They track
  funded, mid-sized companies on LinkedIn. **Our customers sell to the café, the builder and the new Ltd down the
  road.** Those businesses never raise funding rounds and barely show up in those databases.
- **Our advantage is free public registers about local businesses.** That is where the value is for a small seller.
  It costs us almost nothing and no £15k tool does it.
- **Every trigger has two uses, and the plan builds both on one engine (§3):** *find* new leads because something
  happened (a new food premises, as #30 does with new companies), and *watch* leads and customers the user already
  has, raising an alert when something changes.
- **Top 5 to build:** (1) new food and drink premises from the FSA; (2) the Companies House change stream for watched
  leads **and customers**, including ownership changes; (3) a "website changed" bundle: new site, new tools, started
  advertising; (4) hiring, from ATS boards and the Reed API; (5) Google Maps listing signals (new listing, review
  spike, rating drop), depending on decision 5.

### Ranked table

Value = value to *our* customers (small service businesses selling locally). Effort: S < 1 week, M 1–3 weeks, L more.

| # | Signal | Source (UK / US) | Cost | Effort | Value | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **New food/drink premises** | FSA FHRS API: free, no key, Open Government Licence, refreshed daily. New registrations show as *Awaiting Inspection*, often **before opening** (businesses register 28 days ahead). US: city/county health-inspection open data (NYC, Chicago and others, on Socrata) | Free | M | **Very high**: sign makers, fit-out, cleaners, pest control, accountants, insurers, suppliers, web/social | **Build** |
| 2 | **Director / officer change, address move, new charge, ownership change** | Companies House **streaming API** (filings, officers, charges, PSC): free, same key. US: state registers (#30, why-now Phase 6) | Free | M | **High**, and new for *customers*: a new director is a new buyer, a new charge is cash, liquidation is a credit risk, an AD01 often means a new accountant | **Build** (extends why-now Phase 2) |
| 3 | **Website changed**: new domain or first site, new tools, started advertising (Meta Pixel / Google Ads tag appears) | Our own re-fingerprint (`PLATFORM_MARKERS` in `lead-intel.ts`) + Certificate Transparency (crt.sh) for leads with no site | Free (crt.sh is limited to about 5 requests a minute) | S–M | **High**: web designers, marketers, IT. Detecting the ad tag answers "new ad campaign" with no ad-library terms | **Build** |
| 4 | **Hiring**: first job, specific role, more jobs | ATS public JSON (why-now 2.2) for watching; **Reed Jobseeker API** (free key) to *find* local firms hiring X. US: ATS boards | Free (Reed terms to check) | M | **High** for recruiters, HR, payroll, accountants, trainers, workwear | **Build** (Reed after a terms check) |
| 5 | **Google Maps listing**: new listing, review spike, rating drop | Serper `/places`, which we already pay for (about £0.001 a query). Google's own Places API returns 5 reviews and **forbids storing** anything but the place ID | Pennies | M | **High** for local marketing, review management, web; "new on Maps with 0–3 reviews" = a new local business | **Build if decision 5 says yes** |
| 6 | Licences: premises/alcohol, taxi, HMO | UK: every council keeps a public register (Licensing Act 2003), no national feed, each in its own format. US: some state liquor boards on open data | Free but fragmented | L | High where it exists | **Later**: start with councils that publish open data |
| 7 | Planning applications | planning.data.gov.uk: England only, **flagged incomplete** (about 50 councils); London Datahub; paid aggregators (Searchland, Plota). US: city permit open data | Free / paid | M–L | Medium–high for trades | **Later**: re-check national coverage in 2027 |
| 8 | Trademark applications | UKIPO weekly Trade Marks Journal (XML; no API). USPTO daily bulk data (free) | Free | M | Medium: designers, printers, packaging, IP | **Later** |
| 9 | Grant winners | 360Giving GrantNav API: free, open licence. Mostly charities and community groups | Free | S | Medium, only for sellers to charities | **Later** (an option on the Watch list) |
| 10 | Seed/angel funding | US: SEC Form D (already planned). UK: no free source (Beauhurst, Crunchbase are paid) | Paid | — | Low for local sellers | **Skip** beyond Form D |
| 11 | Acquisitions | PSC changes (#2) cover small-company ownership changes; M&A databases are paid | — | — | Covered by #2 | **Skip** as a separate signal |
| 12 | Headcount growth | LinkedIn: no API, scraping is against its terms; Apollo/Lusha data is licensed per seat, not for passing on | Paid / ToS | — | Low (small firms have 2–20 staff) | **Skip**: hiring (#4) is the honest proxy |
| 13 | Meta Ad Library API | Commercial ads searchable only for ads shown in the **EU/UK**, kept 1 year (UK only from Jul 2025); developer identity check needed. US commercial ads not available | Free | M | Medium | **Later**: the ad tag in #3 covers most of it |
| 14 | Google Ads Transparency | No official API; the BigQuery set covers the EEA/Turkey only; the rest is scraping | — | — | Medium | **Skip** |
| 15 | US UCC filings | State by state; paid aggregators | Paid | L | Low | **Skip** (the UK equivalent, charges, is in #2) |
| 16 | Job aggregator **Adzuna** | Its developer terms name sales prospecting and lead generation as needing a written agreement | — | — | — | **Skip** unless they agree |
| — | Apollo, Clay ($149/mo+), Lusha, ZoomInfo | Data licences forbid passing data on to our customers; aimed at SaaS sales teams | £££ | — | — | **Don't buy**: copy the ideas, not the data |
| — | Visualping, Google Alerts | Page-change hashing (why-now 2.2) and Serper news (why-now Phase 3) do the same job inside the product | — | — | — | **Don't buy** |

## 2. How customers see it

- **Why now on leads.** Every trigger becomes a dated signal with fixed wording, written by code, never by a model:
  *"Registered a new food business at 12 High St — awaiting first inspection (3 Nov)"*, *"Added a Meta Pixel to
  their site (last week)"*. It feeds the planned `whyNow` / timing fade (why-now Phase 1), so the Leads table's
  **Why now** column and the "Has a reason now" filter work for every source.
- **New lead sources ("Find businesses when…").** In Lead Generator Settings, next to #30's "New businesses":
  *New food & drink premises*, *Hiring for…* (role words), and later *Planning / licence applications*. Each uses
  the same trades + area picker as #30. Matches arrive in Leads with a source pill and go through the **existing
  approval step**. Nothing is contacted without the customer's yes.
- **Watch list.** One list per Lead Generator: (a) saved leads (why-now 2.1), (b) **customers**, meaning leads marked
  won, and (c) any company the user adds by name, Companies House number or website. The user picks which kinds of
  trigger alert them. Customer triggers are worded as account news ("Acme Ltd has a new director: …", "Acme's
  register shows liquidation"), not as sales prompts.
- **Alerts:** one daily roll-up per assistant (why-now 2.6: Team Chat note, Inbox "Needs you", morning summary).
  Never one alert per signal, and never an automatic email to the prospect.
- **Chat parity** (owner rule): the Lead Generator chat can switch each source on or off, change trades and area, add
  or remove a company on the Watch list, and answer "what changed with my customers this week?" from stored signals.
  Chat proposes; spending tasks follows the usual confirm card.
- Other assistants can read the same signals later (e.g. Business Mentor: "3 customers changed directors this month").
  Out of scope here.

## 3. One trigger engine (reusing #30's feed)

Two kinds of source, one shape:

| Kind | Examples | How we read it |
| --- | --- | --- |
| **Feed** (one list for the whole country, read daily) | #30 new companies, FHRS, CH streaming, Reed search, US state/city open data | One scheduled poller per source, independent of tenants |
| **Per-subject check** (one company at a time) | Website fingerprint, crt.sh, ATS board, Serper place, team page | Due-date queue on `lead_watch` (why-now 2.5) |

- **`trigger_events`** (additive SQL, both DBs): `id, kind, source, country, subject_type ('ch_number' | 'fhrs_id' |
  'domain' | 'place_id' | 'us_entity'), subject_id, name, postcode/area, trade codes, occurred_on, payload jsonb,
  first_seen_at`, unique on `(source, source_event_id)`. #30's `new_companies` stays as it is: it is the "incorporated"
  feed, and its poller writes a `company_incorporated` event as well.
- **Adapters** `src/lib/triggers/<source>.ts`, each exporting `poll(since)` → events and a label map (fixed wording,
  direction positive/neutral/negative). FHRS and CH streaming come first. The US Socrata connector from #30 §7.4 gets
  health-inspection and permit datasets as extra adapters, using the same code.
- **Two matchers**, both pure and testable:
  1. *Find*: events × each opted-in assistant's trades + area → `discovered_leads` with source `trigger:<kind>`.
     FHRS premises are matched to Companies House by name + postcode (`chooseCompany` in `companies-house.ts`) so the
     company type is known (needed for §4).
  2. *Watch*: events joined to `lead_watch` on `ch_number` / `domain` / `fhrs_id` / `place_id` → signal on the lead
     (`data.intel.signals`, `source: 'watch'`) and `signal_captured` in the ledger.
- **CH streaming replaces per-lead polling.** why-now 2.2 calls filing history once per lead per week. One long-poll
  worker on the filings, officers, charges and PSC streams, matched against an index of watched company numbers, scales
  to every tenant with no rate-limit cost. Keep per-lead polling only as a catch-up after downtime (the stream allows
  resuming from a timepoint).
- **First look is silent** (why-now 2.3) for every source, Watch-list additions included.
- Erasure and export: `prospect-erasure.ts` deletes a subject's events and signals; `workspace-export.ts` includes
  them. Events with no matched tenant are kept 90 days, then deleted.

## 4. Rules (compliance)

- **UK GDPR.** Most of these events are about businesses, not people. Named directors and PSCs are personal data:
  lawful basis is legitimate interests, using the single LIA from #30 extended to cover these sources. Privacy
  information goes in the first message, and an objection to marketing is absolute (the suppression list).
- **PECR: who can be emailed.** Ltd, PLC and LLP are *corporate subscribers*: B2B email is allowed without consent,
  with sender identity and an opt-out. **Sole traders and partnerships are individual subscribers: no unsolicited
  email.** Many FHRS premises, Maps listings and hiring firms are sole traders. Rule: a trigger lead may be emailed
  only when its Companies House match shows a corporate type. Otherwise it is shown as "post, phone (after TPS) or
  visit", and the draft is a letter, not an email. Same check as #30 §5, now enforced for every source.
- PECR fines now go up to UK GDPR levels (Data (Use and Access) Act 2025), so the corporate-only rule is a hard gate
  in code (next to the do-not-contact gate), not a prompt instruction.
- **Wording.** Never imply official status ("Your food registration…"). New food businesses get scam letters, as new
  companies do. Say how we know ("from the FSA's public ratings list") and never mention an inspection outcome as a
  threat.
- **US:** CAN-SPAM (footer already compliant), TCPA (no automated calls/texts), CCPA wording; each city/state
  dataset's reuse terms checked before its adapter ships (as #30 §7.3).
- **Source terms:** Serper (decision 5), Reed (written check), crt.sh fair use (cache, back off), Meta Ad Library
  (identity check, UK/EU only). Adzuna, LinkedIn and Google Ads Transparency are excluded.

## 5. Build phases

**Phase 0:** #30 Phase 1 (the `new_companies` poller + Admin list) ships first and becomes the pattern. why-now
Phase 1 (`whyNow` + timing fade) is needed before any trigger shows in the table.

**Phase 1: engine + FSA (Admin only).** `trigger_events`, adapter interface, FHRS daily poller (diff by FHRSID, new
*Awaiting Inspection* = event), Admin ▸ Lead Generator ▸ **Triggers** list with counts by area and kind. Measure the
daily volume and how many match a Ltd before any customer sees it.

> **Built 2026-11-15** (branch `feat/buying-triggers-phase1`). `db/z-trigger-events.sql` (trigger_sources,
> trigger_seen, trigger_events; apply on both DBs), `src/lib/triggers/` (types + FSA adapter),
> `src/utils/trigger-engine.ts`, daily `dispatch-trigger-polls` (04:25 UTC) → `run-trigger-poll-background`,
> staging poke `run-trigger-poll-dispatch`, Admin ▸ Assistants ▸ **Buying triggers** (`admin-triggers.ts`).
> Built ahead of #30 Phase 1 and why-now Phase 1: Phase 1 is Admin only, so it needs neither.
> What it does: reads each of the 363 councils' *Awaiting Inspection* lists one at a time (the FSA firewall
> answers bursts with 403/429; ~2.5 min for all 35,593), diffs by FHRSID, and matches new premises to Companies
> House (name + postcode, up to 600 a day, only if `COMPANIES_HOUSE_API_KEY` is set). First look per council is
> silent; a council re-keying its records (more than max(50, 25%) new at once) is reported, not counted;
> "address published" needs a street line and a full postcode (home businesses show only "DE55").
> The page shows new premises per day, by council and kind, % reachable (address or company), % company
> (emailable under PECR), and the latest 200. Off switch: `TRIGGER_SOURCE_FSA_FHRS=off`. Events kept 90 days.

**Phase 2: Watch list + CH streaming.** Streaming worker (filings, officers, charges, PSC) matched to `lead_watch`.
Watch list gains customers (won leads) and manual additions (GUI + chat). PSC01/PSC07 changes become "New owner /
controller" signals. Needs `lead_watch` from why-now Phase 2, plus columns `fhrs_id`, `place_id`, `watch_kind
('lead' | 'customer' | 'manual')`.

**Phase 3: Find from triggers.** "New food & drink premises" source in Settings + chat, matcher, Companies House match,
corporate-only email gate, letter draft for the rest (letter sending = #30 Phase 3).

**Phase 4: Website changed.** Re-fingerprint watched sites on the per-subject queue; new `PLATFORM_MARKERS` entries
for ad tags (Meta Pixel, Google Ads/gtag conversion, TikTok Pixel) and booking/ecommerce tools; a crt.sh lookup for
watched leads with no website (the first certificate for their name = "launched a website", which also starts #30's
enrichment early instead of waiting for day 14/45).

**Phase 5: Hiring source.** Reed API (UK), once its terms are confirmed in writing: "Find local businesses hiring
{role}". Filter out recruitment agencies (Reed flags them). ATS boards keep doing the watching.

**Phase 6 (if decision 5 = yes): Maps signals.** Serper place lookup per watched local lead every 14 days; store our own
counts only (rating, review count, first seen). Signals: review spike (≥ 2× the 90-day rate), rating drop of 0.3 or
more, newly listed.

**Later:** council licence registers that have open data, planning (re-check national coverage), UKIPO/USPTO
trademarks, 360Giving grants, Meta Ad Library (UK), US health-inspection and permit adapters.

## 6. Costs

| Item | Our cost | Customer charge |
| --- | --- | --- |
| FHRS, Companies House, crt.sh, ATS boards, Reed, 360Giving | £0 | 0 tasks (as why-now "free sources") |
| Website re-fingerprint | Netlify time only | 0 tasks |
| Serper place check | about £0.001 per check | 0 tasks; capped per assistant |
| Enriching a found lead | existing research cost | existing research task (Admin ▸ Task costs) |
| Letters (#30 Phase 3) | about £0.70–£1.20 | per letter, to be priced |

All new keys go through `getTaskCosts()`; no constants.

## 7. Risks

| Risk | Answer |
| --- | --- |
| Most trigger leads are sole traders and can't be emailed | Shown honestly as letter/visit leads; measured in Phase 1 before any promise is made in copy |
| Alert fatigue | Daily roll-up only; the user chooses kinds; customers' triggers kept separate from sales leads |
| A source changes or vanishes (Reed, Serper, crt.sh) | One adapter each, switched off by env; other sources continue |
| False matches (wrong company) | Match on name + postcode or company number only; an uncertain match is not linked (same rule as EDGAR) |
| Public copy runs ahead of the build | Nothing on /connections, pricing or assistant pages until it is live on prod |

## 8. Order relative to other plans

#30 Phase 1 → why-now Phase 1 → this Phase 1 (FSA) → why-now Phase 2 together with this Phase 2 (one `lead_watch`
SQL file covering both) → Phases 3–6.

## 9. Is it disruptive? Is it worth building? Will it bring leads?

Added 2026-11-15 at the owner's request. **Short verdict: worth building in stages, and only past a measured gate.
The trigger data on its own is not disruptive. What we do with it can be.** The Watch list for *customers* is worth
building whatever happens. "Find new leads from triggers" has to prove itself on real numbers first (Phase 1), because
the hard part is reaching these businesses, not finding them.

### 9.1 Is it disruptive?

**Not the data.** Every source in §1 is public. Anyone can poll the FSA or Companies House, and ApprovalFeed already
sells the incorporation list as an email. Trigger-based selling itself is old news in enterprise sales (Autobound,
UserGems, 6sense). If we ship "a list of businesses that just did X", we are one more list. That is not disruptive.

**What could make it disruptive**, in order of strength:

1. **The whole loop, not a list.** Trigger → research → draft → the customer approves → sent (email or post) →
   follow-up → booking or reply logged → Results card. Today a small business gets a spreadsheet (ApprovalFeed) or
   a £15k tool built for a sales team. We would give a café's sign maker a finished, timed, approved action every
   morning. Nobody serves that customer with that workflow. This is classic low-end disruption: an enterprise
   technique made "good enough" and cheap for people the incumbents ignore. We already have most of the loop:
   lead research, drafting, approval, the Inbox, follow-ups, booking links, Results.
2. **Getting there first, by post.** An FSA registration often appears weeks *before* the premises opens. Most of
   these businesses can't legally be emailed (sole traders, §4), but a **letter or postcard** can be sent, and almost
   no competitor does post because it's a chore. A welcome card that arrives *before opening day*, with a QR code to
   the sender's own page (we already have `/card` QR pages and the Website Assistant) and a first-customer offer
   (we already have the intro offer setting), turns the PECR limit into an edge. Scans are trackable, so the sender
   can see it worked. This depends on #30 Phase 3 (letters).
3. **Learning what works, across all workspaces.** Every trigger lead ends as replied, won or ignored. Pooled and
   anonymised (counts by trigger kind × trade × region, never one workspace's leads shown to another), this tells
   each customer "accountants win 1 in 9 new-café leads; sign makers 1 in 4". It also ranks each morning's
   triggers by real outcomes. A rival copying the data feed doesn't get this, so this is the moat. It needs a privacy
   page line and a DPIA note before it starts.
4. **The same engine watching customers, not just prospects.** "Your client Acme Ltd has a new director / has moved /
   registered a charge / is entering liquidation" is account news that small firms never get today. For an
   accountant or IT support firm, that is retention and credit-risk warning in one. Cheap, because Companies House
   streaming is free and the contact details are already held.

What it should **not** claim: "AI finds you leads automatically" in public copy, before §9.3's gate is passed.

### 9.2 Will it bring leads? Real numbers checked today (FSA API, 2026-11-15)

| Check | Result | What it means |
| --- | --- | --- |
| UK premises at *Awaiting Inspection* | **35,593** | A big pool, but it's a *stock*: councils have inspection backlogs, so many have been waiting months. Only the daily *new* entries are triggers. Assuming a 3–6 month wait, that's roughly **1,400–2,700 new a week UK-wide** (estimate, measured in Phase 1). |
| Same, by council | Leeds 1,898 · Birmingham 1,491 · Manchester 1,255 · **Bristol 3** | Coverage depends on the council. Some don't publish unrated premises at all, so the source works by area, not everywhere. |
| Leeds sample (500): kind | Retail 29% · other catering 28% (largely home and event caterers) · restaurant/café 16% · mobile caterer 11% | Good targets for local suppliers, signs, insurance, accountants and web, but many are tiny. |
| Leeds sample: name says Ltd/PLC/LLP | **5%** (24 of 500) | Trading names hide some companies, so the Companies House match will find more, but **most look like sole traders: no email allowed (§4).** |
| Leeds sample: no address published | **50%** | Home-based businesses have their address withheld. Half can't even be written to from this source alone. |

So the honest picture for a typical customer (one trade, one city):

- **Finding:** plenty. In a large city, an accountant or sign maker filtering for relevant types might see
  **10–40 new premises a month** (estimate).
- **Reaching:** the bottleneck. Perhaps a quarter to a half can be contacted at all (address published, or a
  company/website found by enrichment), and only the corporate minority by email.
- **Converting:** trigger-timed, relevant messages do better than cold ones. Vendors claim 2–5× the reply rate, which
  is plausible but **not independently checked**. Illustration only: 20 relevant a month → ~8 reachable → 10–15%
  reply → about 1 conversation a month → a customer every 1–3 months.

**Whether that is worth it depends on the trade's deal size.** For an accountant (a client is worth £1–3k a year),
a sign or fit-out firm (£500–£5k a job) or an insurer, one win a quarter pays for the plan many times over. For a
low-ticket seller (a £30 service) it does not, and we should not market it to them.

**Companies House (#30) and website/hiring triggers** look better on reachability: companies by definition, and a
website or job advert means a published contact. The *Watch* list has no reach problem at all, since the customer
already knows them.

### 9.3 Worth building? Yes, staged, with a stop/go gate

| Part | Worth it? | Why |
| --- | --- | --- |
| Watch list for **customers** (CH streaming, Phase 2) | **Yes, regardless** | Free data, contacts already known, retention + credit warning, no PECR problem |
| Engine + FSA feed in **Admin only** (Phase 1) | **Yes: cheap test** | £0 data, about 1–2 weeks; tells us volume, Ltd share, address share, by council |
| Find-from-triggers for customers (Phase 3) | **Only if Phase 1 passes the gate** | Reachability is the risk |
| Letters (#30 Phase 3) | **Yes, if Phase 3 goes ahead** | It's what makes sole-trader leads usable, and it's the disruptive edge (§9.1.2) |
| Website changed (Phase 4) | Yes | Cheap (our own fingerprint), contactable leads |
| Hiring (Phase 5), Maps (Phase 6) | Later | Terms risk (Reed, Serper) and lower value |

**Gate after Phase 1 (agreed by the owner 2026-11-16):** in at least 3 large councils, for one realistic trade filter,
(a) at least 15 new premises a month, and (b) at least 35% reachable within 21 days (address published or company /
website found). Then a **6-week pilot**: Be More Swan's own marketing (#30 B) plus 3–5 friendly customers in
high-ticket trades, against a cold-list baseline. Go if trigger leads get **at least 2× the reply rate** and at least
one real meeting per pilot customer. If it fails, keep the Watch list and the Admin feed, and stop there: very
little is wasted.

## 10. Decisions for the owner — ALL TAKEN 2026-11-16

1. **Top five as ranked?** ✅ **Keep the order:** FSA premises, Companies House stream (leads + customers), website
   changed, hiring, Maps.
2. **Watch customers too?** ✅ **Yes.** Won leads and manually added companies are watched, with account-news wording.
3. **Sole traders:** ✅ **Agreed.** A trigger lead without a corporate Companies House match is never emailed, only
   offered as a letter or visit. Enforced in code, next to the do-not-contact gate.
4. **FSA first test:** ✅ **One area and one trade group first** (e.g. sign makers or accountants in one city) before
   general release.
5. **Maps signals via Serper:** ✅ **Skip until we have advice** on the terms. Phase 6 is not built until then.
6. **Reed:** ✅ **Ask Reed in writing first.** The owner sends the email; Phase 5's Reed search is built only on a
   written yes. ATS boards keep doing the watching.
7. **Plans:** ✅ **Every plan with a Lead Generator** gets the trigger sources and the Watch list (as why-now decision
   1). Finding leads is still paid per task as now.
8. **US:** ✅ **Yes, after each dataset's terms are checked:** health-inspection and permit datasets on the #30
   Socrata connector, CT, NY, CO first, after the UK.
9. **The §9.3 gate and pilot:** ✅ **Agreed as written:** ≥15 new premises a month and ≥35% reachable in at least 3
   large councils for one realistic trade; then a pilot needing ≥2× the reply rate and at least one meeting per pilot
   customer. Be More Swan's own marketing is the first pilot. Phase 3 only after the gate passes.
   ✅ **Pooled, anonymised outcome learning (§9.1.3): yes**, once there is enough data, after a privacy page line and
   a DPIA note. Counts per trigger type and trade only, never a workspace's leads or messages.

**What this means next:** Phase 1 collects data on Admin ▸ Assistants ▸ Buying triggers (prod live from 2026-11-16,
first new premises 2026-11-17). The gate is read after 2–4 weeks. Phase 2 (Watch list, including customers, + the
Companies House stream) is not blocked by the gate and can be built next.
