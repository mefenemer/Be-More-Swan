# Audience research (SparkToro-style) — PLAN (feature request #32)

2026-11-15. **Nothing built.** For the owner to review and decide (§9).

The ask: *"Should we build a similar feature to Sparktoro https://sparktoro.com/ to include as part of the Business
Mentor? Thoughts"*

---

## 1. Short answer

- **Don't clone SparkToro, and don't put its name anywhere in the product.** What makes SparkToro special is
  **clickstream panel data**: anonymised browsing from tens of millions of devices, bought from Datos, plus public
  LinkedIn profiles and Google results. We can't buy that at a price that fits a £29 plan, and we must never imply we
  have it.
- **Do build an honest small-business version inside the Mentor**, called **"Your audience"**. It answers two
  questions: *who are my customers?* and *where do people like them read, watch, listen and ask questions?* It uses
  sources we already pay for or can get free: the workspace's own data, Search Console, AI web search with real
  links, Serper `site:` searches, the free Apple Podcasts search and the YouTube Data API.
- **The value is not the report. It is what happens next.** Every finding becomes a proposal card that changes
  something the assistants already do: a subreddit added to the Lead Generator's Discussions, five questions turned
  into blog ideas, the customers' own words in the marketing plan that every draft reads. SparkToro stops at the
  report. We can act on it. That fits the Mentor's rule: *"grounded in this workspace's real data and carried out by
  the assistants the user already has"* (docs/business-mentor-plan.md §0).
- **Partner later, only on evidence.** SparkToro's API is live and pay-as-you-go (about $1.75–$2.90 a report). An
  optional "deeper report" could come later for US or large national audiences, once the terms allow it (§6, Phase 4).

## 2. What SparkToro does (checked 2026-11-15)

| | |
| --- | --- |
| **What it answers** | For an audience described in plain words ("people who talk about sourdough"): demographics (age, gender, job title, location), social accounts they follow, websites and press they visit, podcasts, YouTube channels, subreddits, apps and AI tools, search keywords, words in their bios, AI prompt topics. Networks covered: LinkedIn, Instagram, Facebook, X, YouTube, TikTok, Reddit, Threads |
| **Where the data comes from** | Anonymised, aggregated clickstream panels (Datos, tens of millions of devices; 10m+ in the US), public social and LinkedIn profiles, Google results. UK depth not published; its own FAQ says *"very small or private accounts, sites, and shows may not appear"* |
| **Price** | Personal (annual only, 4 reports a month); Business $150 a month (25 reports, 10 users); Agency $300 a month (250 reports). Third-party listings disagree on the entry price ($50–$112 a month) |
| **API** | Live. Credits: $500 for 5,000, $3,000 for 50,000; a typical report is about 29 credits (about $1.75–$2.90); 200 free trial credits. There is also an MCP server for subscribers. Resale and embedding terms are not stated on the API page and need checking in its terms |
| **How a small business uses it** | Picks where to advertise, which podcasts to pitch, which influencers to approach, which communities to join, what words to use. In practice it suits marketers and agencies. A café or a bookkeeper rarely has an audience big enough to show up in panel data |

## 3. What we can get honestly

| SparkToro section | Our source | Honest version |
| --- | --- | --- |
| Who the customers are | Business Information target audience (`mentor-snapshot.ts` already shows it), won and lost reasons + reviews (`src/utils/mentor-customers.ts`), Audience contacts, enquiries | **Better than SparkToro for this business**: these are its real customers, not a lookalike panel |
| Search keywords | Search Console queries (`ingest-gsc-metrics.ts`, `src/utils/gsc-decay.ts`) where connected; AI web search for "people also ask" questions | Real queries for their own site, plus public questions |
| Websites, press, newsletters | `gatewayGenerateGrounded` (`src/lib/ai-gateway.ts`, Anthropic web search, up to 4 searches, URLs kept only from the search's own results) | "Publications that cover your trade and area", each with a link. **No visit counts** |
| Podcasts | Apple Podcasts / iTunes Search API (free, no key) | Shows matching the topic, with episode counts and recency. No listener numbers |
| YouTube channels | YouTube Data API `search` + `channels` (free quota: 10,000 units a day, and a search costs 100) | Channels with subscriber counts, which are public |
| Reddit, LinkedIn, forums | Serper `site:` searches, as the Discussions tab already does (`src/config/discussion-sites.ts`: Reddit's Data API needs a commercial licence, so snippets only) | Active communities and threads where the topic comes up |
| Social accounts they follow | Not available. No follower graphs without scraping, which breaks platform terms | **Gap.** We can list public accounts that post about the topic, not who follows them |
| Demographics | Instagram and Facebook post insights only (`ingest-instagram-insights.ts`, `ingest-facebook-insights.ts`: reach, saves, shares). Follower demographics would need extra Meta permissions | **Gap** for now; a later option for workspaces with Instagram connected |
| Trends | Google Trends has no general public API (an alpha exists, by application only) | Leave out; revisit if access opens |
| AI prompt topics | The Mystery Shopper "AI answers" plan (docs/ai-visibility-customer-plan.md) | Link to it rather than repeat it |

**The honesty rule for the screen and the chat:** findings say *"places that cover this topic, found on the public
web on 15 Nov"*, with a link and a reason. Never *"34% of your audience visits…"*. Where little is found (a very
local or niche business), the report says so and points to the customer data instead.

## 4. How it fits the Mentor

**GUI: a "Your audience" card on the Plan tab** (`src/components/assistant-mentor-plan.js`), above the business and
marketing plans:
- **Who they are**: a short profile pre-filled from saved data (target audience, won reasons, review excerpts,
  Search Console queries), editable, with an *Approve* button. On approval it fills the marketing plan's **Audience**
  section (`src/utils/strategy-documents.ts`: `audience`, `feedsDrafts: true`), so it reaches every draft through
  `business-knowledge.ts` and `recompileOrgBlueprints()`. No new loader.
- **Where they are**: grouped lists (Publications · Podcasts · YouTube · Communities · Local groups and events ·
  Questions they ask · Words they use), each row with its link, why it was picked and a "Use this" button. The date
  of the run is shown, with *Refresh* (costs tasks, §7).
- Settings ▸ *What I can see* lists the new sources (owner rule: the Mentor shows what it reads).

**Chat (same server actions, through a card):**
- *"Who are my customers and where do they hang out?"* → the Mentor shows the profile it would use and an
  `audience_research_proposal` card: *"Look this up for you: about 2 minutes, 2 tasks."* The click queues a
  `mentor_jobs` row of a new kind `audience_research` (`src/utils/mentor-jobs.ts`, today `research | strategy_draft`).
  The result lands in the chat and on the Plan tab, with a notification.
- *"Which podcasts should I pitch?"* → answers from the last run if there is one, otherwise offers the run.
- *"That subreddit is wrong for us"* → removes it (a dismiss reason, as with other Mentor suggestions).

**Where the findings go (each one a card the user approves, written through the owning assistant's own endpoint):**

| Finding | Goes to | Existing path |
| --- | --- | --- |
| Communities (subreddits, LinkedIn topics) | Lead Generator ▸ Discussions watched topics and forums | `chat-discussion-action.ts` `set_watch` |
| Questions they ask, search queries | Blog Assistant topic ideas; Social pillars | `blog-topic-ideation.ts`; `setup_field_proposal` for pillars |
| Words they use, what they care about | Marketing plan ▸ Audience and Messaging, so it reaches Social, Blog, Email, Website copy | `strategy-documents.ts` → `business-knowledge.ts` |
| Podcasts and publications to pitch | Mentor commitments ("Pitch 2 podcasts this month") | `mentor-commitments.ts` |
| YouTube channels in the trade | Video Producer reference styles; Social inspiration | Inspo items |
| Platforms they use most | A proposal to switch a Social platform on or off | `chat-platforms.ts` |

It also gives the Mentor's weekly review something new to check: *"You said your customers are on Instagram, but
your last 20 posts went to LinkedIn."*

## 5. Not doing

- No scraping of follower lists or profiles. No people-level data: we list publications, shows, channels and
  communities, and public accounts only where they are clearly businesses or public creators.
- No posting anywhere. Discussions stays listen-and-link.
- No "clickstream", "panel", "millions of profiles" or competitor names in any copy (memory: public copy never claims
  what the system doesn't do).

## 6. Phased build

**Phase 0 — measure before building (half a day).** Run the research prompt by hand for Be More Swan and for two
workspaces of different kinds (with the owner's OK to read them). Optionally put the same audience through
SparkToro's 200 free API credits for comparison: one UK local business, one national. Decide from that whether our
version is good enough and how many tasks a run should cost.

**Phase 1 — "Who they are" (small).** Pre-filled profile from data we already read; Plan tab card + chat card;
approval writes the marketing plan's Audience section. No outside calls, no task cost beyond chat.

**Phase 2 — "Where they are" (the main build).** `audience_research` job kind in `mentor-job-background.ts`:
grounded web search (publications, local groups, events, questions), Serper `site:` searches for communities, Apple
Podcasts search, YouTube search (needs a `YOUTUBE_API_KEY`; our YouTube publishing uses OAuth, not a key). The
model ranks and explains; code keeps only URLs the sources returned. Stored as a new strategy kind or a small
`audience_research` table (org, run_at, sections JSON, sources). Additive SQL on both databases before the code;
readers tolerate the missing table. Metered through `work-metering.ts` (ask before, record after).

**Phase 3 — findings into the team.** The "Use this" cards in §4, one per destination, each pinned in the prompt
and chat-capability tests (new card ⇒ regenerate the chat capabilities manifest). A quarterly *"refresh your
audience?"* suggestion (it counts toward the Mentor's 3-a-week cap).

**Phase 4 (optional) — deeper report via partner API.** A paid add-on button, "Deeper report (US and national
audiences)", calling SparkToro's API, *only* if its terms allow use inside another product and the Phase 0
comparison shows clearly better results. Shown under its own label, its source named honestly in the report.

## 7. Costs

| Item | Rough cost per run | Note |
| --- | --- | --- |
| Grounded web search (Opus 5.5, up to 4 searches, 2–3 calls) | about £0.15–£0.40 | Measure in Phase 0, as the Mentor plan §3.9 did |
| Serper `site:` searches (6–10) | under £0.01 | Already paid for (Lead Generator) |
| Apple Podcasts search | free | |
| YouTube Data API | free inside quota | About 90 runs a day on one key: watch it, cache per topic |
| SparkToro API (Phase 4 only) | about £1.40–£2.30 a report | Would need its own price to the customer |

Suggested price to the customer: **2 tasks a run** (decision 3). Phase 1 is free.

## 8. Risks

| Risk | Answer |
| --- | --- |
| Invented links or publications | Keep only URLs returned by a search; the `compliance-verification.ts` rule. Nothing found → say so |
| Thin results for local or niche businesses | Lead with "Who they are" (own data); say plainly when the public web shows little |
| Customers read it as SparkToro-grade data | Wording in §3; no numbers we don't have; run date on every report |
| Reddit or YouTube terms change, quota runs out | Same Serper-snippet approach as Discussions; cache; a source failing drops that section only |
| Personal data | Publications, shows and communities only; no named private individuals; nothing stored about people |
| Overlap with the Mystery Shopper "AI answers" | Keep AI-prompt questions there; link both ways |

## 9. Decisions for the owner

1. **Build our own version, partner, or skip?** *Recommendation: build our own inside the Mentor (Phases 1–3); park
   the partner API (Phase 4).*
2. **Name:** "Your audience" on the Mentor's Plan tab? (Never the competitor's name.)
3. **Price:** Phase 1 free; a "Where they are" run costs **2 tasks**? Is a refresh limited (e.g. one a month)?
4. **Plans:** every plan, since the Mentor is on every plan, or the research run from £69 up?
5. **Phase 0:** may we read two named workspaces' data for the trial run, and do you want to create a SparkToro API
   key yourself to use its free trial credits for comparison?
6. **YouTube:** OK to create a YouTube Data API key in our Google project (free quota)?
7. **Instagram demographics:** add asking for follower-demographics permission to the next Meta review, so
   "Who they are" can show age, gender and city for workspaces with Instagram connected? (Not before the current
   resubmission is settled.)
