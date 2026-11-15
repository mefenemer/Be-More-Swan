# New Business Alert — PLAN (feature request #30)

> **⏸ ON HOLD (owner, 2026-11-15): undecided.** Nothing to build until the owner reopens it. Open concerns: most
> new companies are not real prospects, few can be reached by day 14 (contact rate unmeasured), and volume per
> customer is small (0–3 a day). If reopened, the suggested first step is Phase 1 only plus a ~200-company enrichment
> sample to measure the reachable share, then decide on Phase 2.

2026-11-14. **Nothing built.** Owner answered §8 on 2026-11-15 (decisions 2, 3, 6 agreed; 4 and 5 taken on the
recommendation below; 1 still open). UK first; the US is §7 (owner: "do something
similar for the US").

The ask: *"Review approvalfeed.com/products/new-companies and produce a plan to incorporate this into the lead
generator in some way. Every time a new company is set up we can introduce them to Be More Swan, it could be the
perfect time."*

---

## 1. Short answer

- **Don't buy ApprovalFeed. Go to the source.** ApprovalFeed is a daily email digest (company name, type and area,
  £28–£98 a month, no API) built on Companies House records. Companies House's own API is free, gives more (company
  number, SIC codes, registered address, directors) and we **already have a client and an API key**
  (`src/lib/companies-house.ts`, `COMPANIES_HOUSE_API_KEY` set in Netlify).
- **The timing idea is right**, and it is worth more as a **lead source for customers** than for Be More Swan alone.
  Accountants, bookkeepers, web designers, insurers, banks, sign makers, printers and business coaches all want "a
  company formed last week in my area, in my kind of trade".
- **The hard part is reaching them, not finding them.** Companies House gives no email or phone. A brand-new company
  rarely has a website yet. So the plan leans on (a) waiting a few weeks, (b) light enrichment, and (c) post as an
  option.

## 2. What the data gives us (Companies House, free)

| Source | What | Use |
| --- | --- | --- |
| Advanced company search (`/advanced-search/companies?incorporated_from=…&incorporated_to=…&sic_codes=…&location=…`) | Up to 5,000 per request: name, number, type, status, incorporation date, registered office, SIC codes | **Daily poll for yesterday's incorporations** (~2,500–3,000 a day UK-wide) |
| Officers (`/company/{n}/officers`) | Directors' names, correspondence address, month/year of birth (no home address, no email) | Only for companies that pass a customer's filter, to stay inside the rate limit |
| Streaming API | Near real time; no "new company" stream, we would filter it; forum reports missed events | Not needed: a day's delay costs nothing here |
| Rate limit | 600 requests / 5 min per key | One search call a day plus officer calls for matched companies only: well inside |

Fields we will **not** get: email, phone, website, turnover, employees.

## 3. Two ways to use it

### A. A "New businesses" lead source in the Lead Generator (customers) — recommended first
The customer sets **what kind of company** (SIC codes, picked from plain words such as "restaurants", "building
firms", "online shops"; we map them) and **where** (their area, as the Lead Generator already resolves it). Each day
new matches arrive in their **Leads** tab as a separate source, labelled *"New business — formed 3 Nov"*, with a
**Why now** line ("Formed 11 days ago") — this slots into the planned *Why now* column
(docs/lead-why-now-and-watching-plan.md).
- Leads still go through the **existing approval step**: nothing is contacted without the customer's yes.
- Enrichment runs **from day 14** after incorporation, when a domain or website is more likely to exist: the existing
  research pass (`lead-intel.ts`) looks for a site and a business email. No site found → the lead stays as "no contact
  yet", re-checked once at day 45, then dropped.
- The first email (only once there is a business address) says plainly who they are and why: "congratulations on
  setting up…". No look-alike-official wording (§5).

### B. Be More Swan introducing itself (our own marketing)
The same feed, run for Be More Swan as the customer: every new company whose SIC suggests a small service business
that would use assistants. Phase 2 below. Starts as a **list the owner reviews** (Admin), not automatic sending.

## 4. Build outline

**Phase 1 — feed + Admin view (no outreach).**
- `new_companies` table (number PK, name, type, status, incorporated_on, SIC codes, registered address, postcode,
  area, first_seen_at, formation_agent_address bool). Additive SQL.
- Scheduled function `new-companies-daily` (07:00 UK): advanced search for yesterday, page through, upsert. Flags
  addresses used by many companies that day (formation agents, virtual offices) so post is not wasted on them.
- Admin ▸ Lead Generator ▸ **New companies**: yesterday's list with filters (SIC, area), counts per day. Lets the
  owner judge volume and quality before anything is sent.

**Phase 2 — Lead source for customers.**
- Lead Generator settings: "Also find new businesses" (off by default), trade words → SIC codes, area.
- Daily matcher: `new_companies` × each opted-in assistant's filter → `discovered_leads` with source `new_business`,
  officers fetched for matches only; enrichment scheduled for day 14.
- Shown in Leads with its source pill and Why now; approval as today. Chat parity: the Lead Generator chat can turn it
  on/off and change the trades and area (owner rule: every capability = GUI and chat).
- Task cost (decision 4): each day's match counts as **one `lead_search` task** for the assistant, only on days it
  delivers at least one new lead (the same unit as a discovery run, read with `getTaskCosts()`); enrichment adds no
  task and runs inside the existing per-run enrichment cap (`maxEnrichmentCallsPerRun`). New-business leads are capped
  per assistant per day (start at 25) so the Hunter bill stays bounded.

**Phase 3 (optional) — post.** A "Send a letter" option on a new-business lead through a print-and-post API
(roughly £0.70–£1.20 a letter, e.g. Stannp / PostGrid — prices to confirm), addressed *"To the Directors"* at the
registered office. Needs a letter template per customer, a return address, and the formation-agent flag above.

**Phase 4 (optional) — Be More Swan's own outreach** from the Phase 1 list, once the owner has looked at it.

## 5. Rules (UK)

- **Email:** limited companies and LLPs are *corporate subscribers* under PECR, so B2B email needs no prior consent,
  but every message must say who it is from, give a contact address and an opt-out, and honour it (our existing
  suppression list and footer, `outreach-footer.ts`). Partnerships and sole traders are *individual subscribers*:
  **exclude any company type that is not Ltd / PLC / LLP** from email.
- **Named directors = personal data (UK GDPR).** Lawful basis: legitimate interests, with a short assessment (LIA)
  we write once; privacy information given **in the first message** (data from a public register, within a month);
  objection to marketing is absolute (suppression).
- **Being on Companies House is not consent** (ICO). Fine for B2B under the rules above, but we never claim it is.
- **Post:** outside PECR. Addressed to "The Directors" / the company, UK GDPR barely applies.
- **Scam look-alikes:** new directors are flooded with fake "Companies House" invoices (Companies House / IPO have
  warned about it). Our messages must be plainly branded, never mention fees or registration, never use official
  colours or wording.
- **Customers as senders:** when a customer uses the source, **they** are the controller. Settings show a one-line
  reminder and link a template LIA in Help; we keep the opt-out handling we already have.
- Calls are out of scope (no numbers in the data; TPS/CTPS screening would be needed).

## 6. Risks and how the plan deals with them

| Risk | Answer |
| --- | --- |
| No contact details for most new companies | Day-14 and day-45 enrichment; leads with no contact are shown as such, never guessed |
| Registered office is a formation agent | Flag busy addresses; never post to them |
| Looks like scam mail | Plain branding, a real reason ("formed on 3 Nov in Leeds"), no fees, wait two weeks |
| Volume (2,500+ a day UK-wide) | Customers only see their trades and area; Admin list is filterable |
| Companies House changes or rate-limits | One call a day for the list; officers only for matches; failure = a missed day, re-run next morning |

## 7. The US version

The US has **no Companies House**: companies are formed state by state, and each state publishes (or doesn't) in its
own way. Checked live on 2026-11-14 (state open-data APIs); sources in the research notes on FR#30.

### 7.1 Where the data comes from

| State | Feed | How fresh | What it gives | Cost / licence |
| --- | --- | --- | --- | --- |
| **Connecticut** | data.ct.gov Business Master (`n7gp-d28j`, Socrata API) | Daily | Name, type, registration date, office address, **NAICS code (trade)**, **business email** (on almost every new one) | Free, public domain |
| **New York** | data.ny.gov Daily Corporation Filings (`k4vb-judh`, Socrata) | Daily, rolling 30 days | Name, type, filing date, **county only**, filer and service-of-process address. No trade. ~700–950 a weekday | Free; reuse terms not stated (check) |
| **Colorado** | data.colorado.gov Business Entities (`4ykn-tg5h`, Socrata) | Daily (~4-day lag) | Name, type, formation date, **principal address**, registered agent. No trade. ~550–700 a weekday | Free, public domain |
| **Florida** | Sunbiz daily data file (fixed-width text) | Every work day | Large volume; principal address, agent, officers (field layout to confirm). No trade | Free, "as is" |
| Texas | SOS bulk order | Weekly ($20) or daily ($60/day) | New filings, JSON | Paid, cheap weekly |
| Oregon / Pennsylvania | data.oregon.gov / data.pa.gov | Weekly / monthly | Addresses, officers | Free — fine for slower alerts |
| **Avoid** | **Washington** (law bars lists of individuals for commercial use), **South Carolina** (bars commercial solicitation with SOS personal data). **California, Delaware**: no usable free bulk feed. | | | |

Paid aggregators exist (OpenCorporates API from £225/month, share-alike licence unless you buy out; Cobalt
Intelligence, verification only, from ~$1,000) — **not needed to start**: CT, NY and CO are all the same kind of
open-data API, so **one connector** (like the UK Companies House poller) covers them; Florida's file is a second, simple
one.

### 7.2 What is different from the UK

- **Trade:** only Connecticut records an industry code. Elsewhere the trade is guessed from the company name (a cheap
  model call per match, or keyword rules) and shown as a guess — customers filtering by trade get fewer, less certain
  matches outside CT.
- **Address:** about a quarter of new Colorado companies use a commercial registered agent (Northwest, Registered Agents
  Inc, CSC…), and New York gives only a county and a service address. Filter "where" on principal/office address and
  county, and **drop known agent addresses** (the same idea as the UK formation-agent flag).
- **Email:** Connecticut supplies one — usable straight away. Everywhere else, enrichment as in the UK (day 14, day 45).

### 7.3 US rules

- **Email — CAN-SPAM** (applies to B2B): no prior consent needed, but honest headers and subject, a clear "this is an
  ad", a **physical postal address**, a working opt-out honoured **within 10 business days**. Fines up to ~$53k per
  email. Our footer already adds the opt-out link and postal address on US sends (`outreach-footer.ts`).
- **Calls and texts — TCPA:** **no automated calls or texts to mobiles without written consent**, B2B included; new
  one-person LLCs mostly list a mobile. Out of scope, as in the UK.
- **California (CCPA/CPRA):** the B2B exemption ended in 2023, so business contacts there have rights to know, delete
  and opt out. Our opt-out and data-export paths cover it; add CA wording to the privacy notice.
- **States that restrict marketing use of their filing data:** Washington and South Carolina — excluded (§7.1).
- **Look-alike official mail:** many states (Colorado, Tennessee, Kansas, Mississippi, Rhode Island) warn new LLCs about
  official-looking letters selling "certificates of good standing"; Ohio now regulates such solicitations. Same answer as
  the UK: plainly branded, no fees, no official look.
- **Get US counsel to check** the TCPA position and New York / Oregon reuse terms before launch.

### 7.4 US build — fits into the phases above

- **Phase 1 US:** `new_companies` gains `country` and `state`; one Socrata connector for **Connecticut, New York and
  Colorado** (daily), then Florida's daily file. Same Admin list, filterable by state.
- **Phase 2 US:** the same "New businesses" lead source, with the area resolved to US state/county (the Lead Generator
  already works out `us` searches), trade from NAICS in CT and a name-based guess elsewhere, and the US footer.
- **Start with Connecticut** for the first customer test: trade + email out of the box, so it shows the feature at its
  best with no enrichment cost. Volume is small (~170 a day).

## 8. Decisions for the owner

| # | Question | Decision (2026-11-15) |
| --- | --- | --- |
| 1 | **Who first:** customers' lead source (A), Be More Swan's own marketing (B), or both? | **Open.** Recommendation: Phase 1 Admin list first, then A. |
| 2 | **Channel:** email only once enrichment finds a business address, or add post (Phase 3)? | **Agreed** (see note below). |
| 3 | **Wait before first contact:** 14 days? | **Agreed: 14 days.** Enrichment from day 14, re-check day 45, then drop. |
| 4 | **Plans and cost** | **Recommendation taken (below).** |
| 5 | **Trades for our own marketing (B)** | **Recommendation taken: the list in §9**, for the owner to trim once the Phase 1 Admin list shows real volumes. |
| 6 | **US:** CT, NY, CO first, Florida next, Texas later; US counsel before any US sending? | **Agreed.** No US email is sent until counsel has checked the TCPA position and the NY / Oregon reuse terms. |

Note on 2: the owner answered "Agreed"; this plan reads it as **email only, sent once enrichment finds a business
address**, with post (Phase 3) left optional and not built unless asked. Confirm if post was meant.

**Decision 4 — plans and cost.**
- **Every paid plan that has the Lead Generator** (`saver` £29, `buster` £69, `employee`, `enterprise`). **Not the free
  trial**: each matched lead can cost us a Hunter lookup, and a trial with a whole-county filter would burn the quota.
  Beta workspaces get it as a paid plan would.
- **Charged like a search run, not per lead:** one `lead_search` task per assistant on each day the matcher delivers at
  least one new lead; no task on empty days. Enrichment adds no task (as today), bounded by the per-run enrichment cap.
- **Daily cap per assistant: 25 new-business leads** (platform_config, so it can change without a release). Above that,
  the newest 25 by best SIC match are kept and the count of the rest is shown ("40 more matched today — narrow your
  trades or area").
- Why: it matches how customers already pay for lead work (one task per search run), keeps the price simple to explain,
  and the real cost to us (Hunter lookups) is controlled by the cap rather than by charging per lead.

## 9. Trades for Be More Swan's own marketing (decision 5)

Rule of thumb: a small business that sells to the public or to local firms, needs a steady stream of posts, reviews,
bookings or enquiries, and has no marketing team. Starting list (UK SIC 2007):

| Group | SIC codes |
| --- | --- |
| Food and drink | 56101 licensed restaurants, 56102 unlicensed restaurants and cafés, 56103 takeaways, 56210 event catering, 56302 pubs and bars |
| Stays (ties in with the holiday-lets work) | 55100 hotels, 55201 holiday centres, 55202 youth hostels, 55209 other holiday accommodation (holiday lets) |
| Beauty and wellbeing | 96020 hairdressing and beauty, 96040 physical wellbeing (spas, massage), 93130 fitness facilities, 85510 sports and recreation coaching |
| Health practices | 86230 dental, 86900 other human health (physio, therapists, clinics), 75000 vets |
| Trades | 41202 domestic building, 43210 electrical, 43220 plumbing and heating, 43320 joinery, 43330 floor and wall covering, 43341 painting, 43390 other building completion, 43999 other specialised construction, 81210 cleaning, 81300 landscaping |
| Property | 68310 estate agents, 68320 letting and property management |
| Professional services | 69102 solicitors, 69201 accountants, 69202 bookkeepers, 70229 management consultancy (noisy, see below), 74201 photography, 74100 design |
| Shops | 47710 clothing, 47760 flowers, plants and pets, 47789 other retail, 47910 online retail |
| Learning, care and events | 85590 other education (tutors, courses), 88910 childcare, 93290 other recreation (events, venues) |

**Leave out:** 64209 / 64205 holding companies, 70100 head offices, 68100 / 68209 buying, selling or renting own
property (mostly investment vehicles), 99999 dormant, 82990 "other business support" (the formation agents' default,
mostly noise), 62012 / 62020 / 73110 / 73120 software, IT and marketing agencies (competitors — but a candidate list
for the affiliate programme instead).

**Noise check:** 70229 and 74909 are common default picks; keep 70229 only for companies whose name also reads as a
real practice (a keyword rule in the matcher), and judge the whole list against Phase 1's real daily counts before any
Phase 4 sending.
