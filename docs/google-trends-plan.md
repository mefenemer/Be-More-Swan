# Google Trends — PLAN (feature request #31)

2026-11-15. **Nothing built.** Owner answered every §9 question on 2026-11-15 (§10): Phase 0 approved, DataForSEO chosen.

The ask: *"Look into whether we can connect to Google Trends to find out what people are searching about - this could
be useful to some of the assistants".*

---

## 1. Short answer

- **Yes, we can, but not straight from Google yet.** Google's official Trends API is still an **invite-only alpha**
  (announced July 2025; the developer page still says "accepting applications for alpha testers", no quotas, no price,
  no terms). Apply now (free), but don't build on it.
- **Buy the data from a provider in the meantime.** DataForSEO's Google Trends endpoint costs **$0.0027 per request**
  (up to 5 terms each, answer within 45 minutes). It suits us: our use is background and can wait. Expected cost is
  **under $30 a month** at today's scale (§6).
- **Don't scrape.** pytrends, the usual free library, was archived in April 2025, gets blocked by Google ("429") and is
  against Google's terms.
- **What Trends is good for here: seasons and rising questions.** It gives *relative* interest (0–100), not search
  counts. A local plumber's exact phrases are often "not enough data" at town level. Broad trade terms at UK, nation
  or US-state level work well: "boiler service peaks every October", "people are asking 'heat pump grant' more this month".
- **There is a free source we already half-use: Search Console.** `netlify/functions/ingest-gsc-metrics.ts` asks only
  for `dimensions: ['page']`. Adding `query` would show the **real searches that found the customer's own site**. That
  is more personal than Trends, costs nothing, and could ship first (§5, Phase 1b).
- **Start with the Business Mentor and the Blog Writer**, then Social and Email Marketing.

## 2. Data options

| Option | What it gives | Cost (Nov 2026) | Risk |
| --- | --- | --- | --- |
| **Google Trends API (official alpha)** | 5 years of history, daily to yearly, regions and sub-regions, values that stay comparable across many terms (the Trends website allows 8) | Free while in alpha; quotas and price not published | Invite only, could change or never open. **Apply; don't depend on it** |
| **DataForSEO** — Trends Explore | Interest over time, by region, related topics and queries ("rising") | Standard (wait up to 45 min): **$0.0027/request** of up to 5 terms; Live (~30 s): $0.011. Pay as you go from a prepaid balance | Reseller of scraped Google data; Google could break it. **Recommended** |
| **SerpApi** — `google_trends` engine | Same data types (interest over time, by region, related topics and queries) | Free 250 searches a month; $75/month for 5,000; $150 for 15,000. 1-hour cache is free | Same as above; dearer at volume, simplest to test |
| **"Trending now" RSS** (`trends.google.com/trending/rss?geo=GB`) | Today's top national searches with rough traffic ("500+") and news links | Free | Unofficial, can change without notice. Mostly sport, celebrities and news: rarely relevant, and risky to post about (§7) |
| Glimpse / Exploding Topics | "Trending topic" lists and forecasts | Glimpse: API price not published (quote only). Exploding Topics: from ~$39/month; higher tiers reported at $1,000/month for 1,000 requests | Their own curated lists, not Google's raw data. Not needed |
| pytrends / own scraper | Website data | Free | Archived 2025, blocked often, breaches Google's terms. **No** |
| **Search Console queries** (customer's own) | Real searches, impressions, clicks, position for *their* site | Free; customer already connects it in Blog setup | Only for customers with a site and Search Console; small sites have few queries |

## 3. Which assistants benefit, and how

**Business Mentor** (best fit: it already looks ahead and proposes work).
- New suggestion card on the Suggestions tab: *"Searches for 'wedding venues' in the UK climb from January and peak in
  March. Nothing is planned on it yet. Ask the Blog Writer and Social for three pieces?"* Built from the weekly review
  next to the code-only checks in `src/utils/mentor-content-checks.ts`. Accepting it goes through the existing proposal
  cards (`src/utils/mentor-proposal-cards.ts`).
- Its every-turn workspace block (`src/utils/mentor-snapshot.ts`) gains a short `<search_trends>` section.
- Chat: *"What are people searching for in my trade right now?"* → rising terms and the next seasonal peak, with the
  date range and "relative interest, not counts".

**Blog Writer**
- Autopilot topic choice (`src/utils/blog-topic-ideation.ts`) gets the rising related queries and upcoming peaks as
  *suggested angles*, kept separate from the business brief (it remains the main input).
- Blog setup (Blogs tab ▸ Blog setup, `src/components/blog-studio-modal.js`) gains a **"What people search for"**
  panel: each tracked term with a 12-month sparkline, its peak months and its rising questions. Each question has a
  "Write about this" button. Blog keywords (`netlify/functions/blog-keywords.ts`) show a ↑/↓ arrow when they are tracked.
- Chat: *"Which of my keywords are rising?"*, *"Write a post on the most-searched question about heat pumps"*.

**Social Media / Email Marketing**
- On a share of scheduled slots, a *timely angle* is offered when a tracked term is rising or near its peak. The
  machinery is the same as Inspo topics (`src/utils/inspo-topics.ts`, never/occasionally/often): stateless and
  hash-picked. It plugs into `src/utils/autonomous-draft-brief.ts` and `src/utils/newsletter-generate.ts`.
- Calendar: a faint "peak season: boiler service" marker on the weeks concerned.

**Website Assistant** (later): compare wordings for page titles. Example: *"'emergency plumber' is searched far more
than 'urgent plumber' in your region"*.

**Not a fit:** Lead Generator, Mystery Shopper, Brand Designer, Video Producer (beyond ideas reached through the Mentor).

## 4. How terms are chosen

- One **workspace list of tracked search terms** (5–10, at most 20), shared by every assistant, like Products & Services.
- **First fill is automatic.** A cheap model call (Haiku) suggests broad terms people actually type. It works from the
  industry, Products & Services (`src/utils/org-products.ts`), content pillars and blog keywords. The suggestions come
  back as a proposal for the owner to approve, not a silent save.
- **Editable in the GUI and in chat** (owner rule: every capability works both ways): Business Information gains a
  "What people search" tab. Any assistant chat can propose an add/remove card, and the user's click saves it.
- **Region:** country by default (UK or US, from the workspace), plus nation or state where the data holds up. No town level.

## 5. Build outline

**Phase 0 — test before building (about a day, ~£20).**
- Apply for the Google alpha (use case: small-business content planning).
- Top up DataForSEO with the minimum and use SerpApi's free 250. Run ~60 terms taken from real staging workspaces'
  industries at UK, nation and US-state level. **Go/no-go measure:** what share returns usable data, and are the rising
  queries sensible?

**Phase 1 — the engine (no customer UI).**
- `src/lib/trends-provider.ts`: one interface, DataForSEO first. The Google alpha can replace it later without
  touching callers.
- Tables (additive SQL, both DBs):
  - `search_trend_terms`: **shared across workspaces**, keyed term + region. Holds the weekly series, related and rising
    queries, peak months, `status` (`ok` / `not_enough_data`) and `fetched_at`.
  - `org_trend_terms`: org_id, term, region, source auto/user.
- Scheduled background function `refresh-search-trends`, weekly. It fetches only terms that are stale and tracked by an
  active workspace. Two workspaces tracking the same term cost one fetch.
- Spend is logged like other providers. A health row goes on Admin ▸ Systems, and an Admin list shows terms, status
  and cost.

**Phase 1b — Search Console queries (free, can go first).** Add a `query` dimension to `ingest-gsc-metrics.ts`
(one more call per property per day). Blog setup shows "Searches that found you". Blog ideation reads it too.

**Phase 2 — Mentor + Blog.**
- What is shown: the §3 panel, card and prompt blocks, and the terms tab plus chat cards.
- Chat: the `<search_trends>` block goes on the Mentor, Blog, Social and Email routes. The chat capabilities manifest
  is regenerated and its wording added, or CI fails (`scripts/chat-capabilities-manifest.ts`).
- Every new prompt block treats provider text as **data, never instructions**: related queries are third-party text.
- Help article and the Mentor's playbook wording.

**Phase 3 — Social + Email timely angles**, calendar markers, per-assistant never/occasionally/often setting.

## 6. Costs

- Assume 300 active workspaces × 10 terms ≈ 2,000 unique term/region pairs after overlap. Interest over time takes
  ≈ 400 requests (5 terms each). Related queries take ≈ 2,000 (1 term each). A weekly refresh is therefore ≈ 10,000
  requests a month, **≈ $27 a month** on DataForSEO Standard. SerpApi would need its $150 plan.
- A chat "check this term now" uses Live: $0.011 a time.
- **Tasks:** the shared weekly refresh is our cost, not the customer's. Reading cached trends inside a draft adds no
  task. Decided: an on-demand chat look-up is free under a daily fair-use cap (§10 Q5).
  Choosing terms is one small model call at set-up.

## 7. Risks

| Risk | Answer |
| --- | --- |
| Niche or local terms return "not enough data" | Track broad terms, country or nation level. Show "not enough searches to chart" plainly and never fill the gap with a guess |
| Relative index read as search counts | Every surface and prompt says "relative interest, 100 = the peak in this period". No volumes in copy |
| Provider breaks or Google blocks it | Provider interface; failure = a stale week, shown with its date. Google alpha as the long-term route |
| Data scraped from Google by a third party | DataForSEO/SerpApi carry that risk; we store only aggregates. Swap to the official API when open |
| Tasteless "newsjacking" (a death or disaster trending) | Only the customer's own tracked terms feed drafts. The daily national "Trending now" feed is left out (§9 Q7) |
| Instructions hidden in related queries | Fenced as data in prompts; short strings only |
| Public copy over-claims | Wording: "uses Google Trends data to spot seasons and rising questions". Never "live search volumes" or "what everyone is searching". `/connections` and help updated only when live |
| Privacy | Only search terms are sent, never personal data. Add the provider to the sub-processor list in trust/privacy anyway |

## 8. What this does not do

No keyword search volumes (that is Google Ads Keyword Planner, which needs an Ads account and developer approval; it
could be a later plan). No competitor tracking. No forecasting beyond "last year this term peaked in March".

## 9. Decisions for the owner

1. **Go ahead with Phase 0** (≈£20 and a day) and apply for the Google alpha?
2. **Provider:** DataForSEO (cheapest, pay as you go) or SerpApi (simpler, monthly plan)? *Recommendation: DataForSEO.*
3. **Who first:** Business Mentor + Blog Writer, then Social/Email? Or Social first, as the most-used assistant?
4. **Terms:** one workspace list (recommended), or a separate list per assistant? Auto-suggested then approved, as proposed?
5. **Tasks:** shared weekly refresh free to customers, on-demand chat look-up one task?
6. **Plans:** every plan, or from £79 up?
7. **Daily "Trending now" feed:** leave it out (recommended), or offer it to Social as an opt-in with a strict
   relevance filter?
8. **Search Console queries (Phase 1b):** do it first, since it is free and uses data customers already connect?

## 10. Owner decisions (2026-11-15)

| # | Decision |
| --- | --- |
| 1 | **Go ahead with Phase 0** and apply for the Google alpha |
| 2 | **DataForSEO** |
| 3 | **Business Mentor + Blog Writer first**, then Social and Email Marketing |
| 4 | **One workspace list** of tracked terms, **auto-suggested then approved** by the owner |
| 5 | **Both free** (owner asked for a recommendation; see below) |
| 6 | **Every plan** |
| 7 | **"Trending now" feed left out** |
| 8 | **Search Console queries (Phase 1b) go first** |

**Q5 — tasks.** Since the single task allowance went live (2026-10-17, both DBs), chat and editing helpers cost no
tasks; they sit under per-workspace daily fair use (`src/utils/fair-use.ts`). Charging one task for a chat look-up
would be the only chat action that does, and would contradict the pricing page's promise. So:
- The shared weekly refresh is our cost and free to customers (≈ $27 a month at 300 workspaces, §6).
- An on-demand chat look-up of a new term is **free**, but goes through `meterInteraction` and gets its own fair-use
  cap: `fair_use_trends_lookups_per_day`, **10 per workspace** in `platform_config`. At $0.011 (DataForSEO Live) that
  caps one workspace at 11p a day. Over the cap, chat says it will look the term up in the next weekly refresh and
  adds it to the tracked list for approval.
- A looked-up term lands in the shared `search_trend_terms` cache, so a second workspace asking the same thing that
  week costs nothing.
- Spend is logged per call like other providers, so Admin ▸ System Map shows if the cap needs changing.

**What this changes in the plan.** Phase 1b (Search Console queries) moves ahead of Phase 0/1, since it needs no
provider and no spend. §6's "on-demand look-up costs one task" is replaced by the fair-use cap above.

**Phase 0 kit (2026-11-15).** `scripts/trends-phase0.ts` + `scripts/trends-phase0-terms.json` (60 broad trade
terms × United Kingdom, Scotland, Wales, United States, Texas). It resolves regions through DataForSEO's free
locations endpoint, so nations or states it doesn't list are reported and skipped. The run uses Live calls,
≈ 300 calls, at most ≈ $3. It writes `docs/google-trends-phase0-results.md` (usable share per region, peak month,
rising queries per term); raw JSON goes to the gitignored `.tmp-trends-phase0/`. SerpApi's free tier is dropped from
Phase 0 now that DataForSEO is chosen. Sign-up (checked 2026-11-15): app.dataforseo.com/register gives a **$1 trial balance**; the minimum top-up is
**$50** (not ~£20), by card, PayPal or Amazon Pay, and it never expires. The API password is separate from the login
password and is shown only for the first 24 hours (later: "Send by e-mail" on API Access). Owner steps first: DataForSEO account, `DATAFORSEO_LOGIN` /
`DATAFORSEO_PASSWORD` in `.env`, and the Google Trends API alpha application.

**Phase 0 first read (5 terms × 5 regions, 2026-11-15, $0.36 of the $1 trial).** Raw replies in `.tmp-trends-phase0/`,
table in `docs/google-trends-phase0-results.md`.
- **Data holds up at country level:** UK and US 5/5 usable. Nations and states are patchier: Scotland 4/5, Texas 4/5,
  Wales 3/5 (it lost "emergency plumber" and "roofer"). Offer country by default, nation/state only where the term
  passes.
- **Peaks look right:** boiler service and roofer peak in October in the UK; US trades peak May–June.
- **Rising queries are noisy and need a filter before anyone sees them.** Examples: "oak furnitureland" under boiler
  service, "ford electrician fired" (news), "what is a double boiler" (cooking), other towns' plumbers. Phase 1 needs a
  cheap relevance pass (Haiku) that keeps only questions a customer could write about, and drops brands, news, people
  and other places. Without it the Blog "Write about this" buttons would suggest nonsense.
- DataForSEO names nations/states as "Scotland,United Kingdom"; the script now matches that.

**Phase 0 result (2026-11-15): GO.** Full table and verdict: `docs/google-trends-phase0-results.md`. 60 terms ×
UK/Scotland/US on the Standard queue. Phase 0 cost $0.81 in all, from the $1 trial, with no top-up. Usable: UK
60/60, US 57/60, Scotland 51/60. Conditions carried into Phase 1:
(1) country by default, nation/state per term only if it passes;
(2) report peak *months* (averaged), not a single peak week;
(3) a Haiku relevance filter on rising queries before they reach any surface. Only 5% are question-shaped, and the
rest include brands, news, trivia and other towns.
Standard answers came back in 1–4 minutes. The $50 top-up is needed before Phase 1's weekly refresh; $0.19 of the
trial is left.

**Phase 1b built (2026-11-15, branch `feat/gsc-search-queries`).** "Searches that found you":
- **Storage:** `search_console_queries` (`db/z-search-console-queries.sql`, apply to both DBs before deploy).
- **Daily ingest:** `ingest-gsc-metrics.ts` adds one call per property and keeps the top 100 by impressions.
  - It only uses the workspace's own properties, matched from its website, its blog widget's site URL and its posts'
    canonical URLs. A sole property counts as its own; a login with several unmatched properties counts as none.
  - A failed call keeps the previous list, and disconnecting Search Console deletes it.
- **Where it shows:** Blog setup ▸ Search performance lists it (10, then "Show all").
- **Blog ideation:** uses up to 15 as optional angles on an undirected slot.
- **Chat:** the Blog Writer and Business Mentor chats read it (`src/utils/chat-search-queries.ts`), fenced as
  third-party data. There is no card.
- Logic in `src/utils/gsc-queries.ts`; tests in `tests/gsc-queries.test.ts`.
