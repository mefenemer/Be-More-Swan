# AI Visibility for customers — Plan

Added 2026-11-01, from a review of "Your Website Won't Matter in 2 Years" (Tim The SEO Guru,
4 Sep 2026, an Arvow affiliate video) against the code. Its step 5, "optimise for citations, not
rankings", is the one Arvow sells as an "LLM brand monitor" and we only run for ourselves.
Status: **plan only — nothing built.** D1, D2, D4, D5, D6 decided 2026-11-01; D3 (task cost) waits on
measuring the 1 Nov admin fetch (§6).

The idea in one line: once a month, ask ChatGPT, Claude and Gemini the questions the customer's own
customers ask ("best electrician in Bristol", "how much does a boiler service cost in Bristol"), show
whether the business is named, who is named instead and what the AI got wrong, and hand each gap to
the assistant that can close it (Blog Writer, Website Assistant, Business Information).

Related: [mystery-shopper-plan.md](./mystery-shopper-plan.md) (where this lives, and the format this
doc follows), memory `ai-visibility-admin-page` (the admin version this generalises),
`public-copy-claims-vs-system`, `assistant-gui-chat-parity`, `assistants-active-teammates-and-expertise`.

---

## 1. Requirements

1. A customer sees, without setting anything up beyond what the Mystery Shopper already asks, whether
   AI assistants recommend them for the questions that bring them work.
2. The trend over months is the product. A single run is noisy and must be presented as such.
3. Every gap ends in a next step another assistant takes, not a report the owner has to act on alone.
4. Nothing the page says is a claim the system can't back (memory `public-copy-claims-vs-system`).
5. GUI and chat parity: chat can read the results, edit the questions and propose a re-check.
6. The cost per customer is known before pricing it, and metered like other background work.

## 2. What already exists — reuse, do not rebuild

| Needed | Already built ✅ | Where |
|---|---|---|
| Ask ChatGPT / Claude / Gemini with web search, from the UK | `askChatGpt`, `askClaude`, `askGemini`, timeouts, model fallbacks, 6-at-a-time pool, 11-minute stop | `netlify/functions/ai-visibility-fetch-background.ts` |
| Read mention, list position, link, cited URLs off an answer | `detectMention`, `readOpenAiResponse`, `readGeminiResponse` | `src/utils/ai-visibility.ts` — **hard-codes Be More Swan** (`BRAND_RE`, `OUR_HOST_RE`) |
| Run summary: mention rate, unprompted rate, avg position, competitor tally | `summarise`, `stat` | `src/utils/ai-visibility.ts` |
| Suggested "Accurate?" against a fact sheet, kept apart from confirmed values | `suggestAccuracy`, `accuracySystemPrompt`, `parseAccuracyVerdict` | `src/lib/ai-visibility-accuracy.ts` — fact sheet is ours only |
| A hired role with website, competitors, weekly schedule, sub-tabs, hand-offs, briefs | Mystery Shopper | `site_audits`, `site-audit-schedule.ts`, `assistant-site-audit.js`, `site-audit-briefs.ts`, `site_audit_briefs` |
| The business's facts | Products & Services (prices), Hours & Location, offer profile, Brand Knowledge | `org-products.ts` (`loadOfferingsText`), `offer-profile.ts`, Brand Knowledge loader |
| Charging for it | Ask before, record after, fail open | `src/utils/work-metering.ts`, `src/config/task-weights.ts` |
| Monthly scheduling on prod + staging poke | Netlify schedules + `staging-crons.yml` | `netlify.toml`, `.github/workflows/staging-crons.yml` |

So the engine exists. What is missing: **per-business brand matching**, **per-business questions**,
**a per-business fact sheet**, **org-scoped tables**, **the customer UI + chat**, **the hand-offs**,
and **the monthly dispatch at customer scale**.

## 3. Shape — and why

1. **A section of the Mystery Shopper, not a new role (D1).** It already holds the website, the
   competitors, a recurring check, the Website tab sub-tabs and the brief/hand-off machinery, and
   "how do I look to someone deciding whether to buy" is its job. A new role would be a second hire
   for half a feature. It appears as a new sub-tab, **"AI answers"**, beside Checks.
2. **Monthly, not weekly.** AI answers move slowly and vary run to run; weekly would cost four times
   as much and show noise as movement. Runs on the audit's check day in the first week of each month.
3. **Questions are generated once, then fixed.** At setup the model drafts ~10 questions from
   Business Information (what they sell, where, who for): about 6 unbranded ("best X in <town>",
   "how much does X cost in <town>", a problem a customer would type), 2 comparison (named
   competitors from the Mystery Shopper), 2 brand ("Is <name> any good?", "How much does <name>
   charge?"). The customer can edit, retire and add. They stay the same month to month, because a
   trend needs the same questions. Retiring keeps history (as the admin table does).
4. **The location goes into the question AND the request.** Most customers are local; "best
   plumber" from "the UK" is meaningless. OpenAI's `user_location` takes a city; Claude's web search
   tool takes `user_location` (the gateway doesn't pass it yet — `src/lib/ai-gateway.ts:253`);
   Gemini has none, so the town in the question text is what carries it.
5. **Scores in code, never by the model** (same rule as the Mystery Shopper). Headline number =
   **"Named in X of Y answers"** on unbranded questions only (brand questions name them by
   construction). Shown with the last 3 months beside it. Position and "linked to your site" are
   secondary.
6. **"Who AI recommends instead"** has two parts:
   - **Sites AI trusts for this question**: the cited domains other than theirs, counted in code. Deterministic and often the most
     useful thing on the page: "Checkatrade, Yell and Which? are cited on 7 of 10 answers" tells
     them where to be listed.
   - **Businesses named instead**: one cheap extraction call per answer (names of businesses or
     products recommended, in order), labelled as read by AI. The admin version's
     case-sensitive known-competitor list doesn't generalise to every trade.
7. **Accuracy is suggested, and the customer can act on it.** The admin version leaves suggestions
   for an admin to confirm. Customers won't confirm a grid, so a suggested wrong fact shows as
   "ChatGPT said you open on Sundays — your Hours say closed" with **Fix it at the source** (deep link
   to the field, via the existing `FACT_LOCATIONS` links) or **That's right** (dismiss). The judge's
   facts come from the business's own records, never web search.
8. **Every gap is a brief to a teammate who is hired and active** (memory
   `assistants-active-teammates-and-expertise`):
   - Not named on an unbranded question → **Brief Blog Writer**: an article answering that exact
     question from the business's view, with the price range from Products & Services if they've
     published one. This is the video's whole loop, done for them.
   - Not named, and they have a hosted site → **Brief Website Assistant**: add the question to the
     site's FAQ (which already outputs FAQPage JSON-LD).
   - Wrong fact → the source field (above).
   - A directory cited everywhere they are not listed → a to-do in the tab (no assistant can list
     them on Checkatrade).
   - Not hired / paused → the idea says which assistant would do it, without a hand-off button.
   Briefs go through `site_audit_briefs` so they move to In progress / Done like the other ideas.

## 4. Build steps

**Step 1 — generalise the engine (no customer-visible change).**
- `src/utils/ai-visibility.ts`: `detectMention(text, urls, brand)` where `brand = { names: string[],
  hosts: string[] }` (business name and variants, website host, hosted-site host). Be More Swan's own
  page passes its constants, so the admin page behaves exactly as today. Same for `isOurUrl`.
- Move the three `ask*` functions out of the background function into `src/lib/ai-visibility-ask.ts`
  with a `location?: { city, country }` argument; pass `user_location` to OpenAI and Claude.
- `accuracySystemPrompt(facts, businessName)` and a per-org `loadOrgFacts(orgId)` (name, website,
  Products & Services with prices, Hours & Location, offer profile, service area).
- Tests: the existing `tests/ai-visibility*.test.ts` must pass unchanged; new cases for a business
  whose name is a common word ("Swift Plumbing", "The Kitchen") — matched whole-phrase, never a
  single word alone.

**Step 2 — tables (`db/z-ai-visibility-orgs.sql`, both DBs, apply BEFORE the code deploys).**
- `org_ai_visibility_questions` (organisation_id, site_audit_id, category, text, is_active, sort_order).
- `org_ai_visibility_runs` (organisation_id, site_audit_id, month DATE, status, started_at,
  finished_at, tasks_charged). One per org per month, UNIQUE (site_audit_id, month).
- `org_ai_visibility_answers` — same columns as `ai_visibility_answers`, plus `named_instead TEXT[]`,
  `fact_status` ('open' | 'fixed' | 'dismissed').
- Kept apart from the admin tables on purpose: the admin page reads `ai_visibility_*` with no org
  filter, and mixing them would put customer answers on our own report.

**Step 3 — the monthly run.**
- `run-ai-visibility-background.ts` — one org per invocation (≈10 questions × 3 assistants = 30 calls
  at 6 at a time ≈ 4 min, inside 15). `hasTaskCapacity` before, `recordCompletedWork` after the
  run finishes (memory `background-work-metered`); new kind `ai_visibility_check` in
  `task-weights.ts` with the weight from D3.
- The dispatcher is the existing daily `dispatch-site-audits`: an audit whose first check day of the
  month has passed and has no run for this month is started. **At most N orgs per tick** (env
  `AI_VISIBILITY_MAX_PER_TICK`, start at 20) so one morning doesn't hit the OpenAI or Gemini rate
  limits with every customer at once; the rest go the next day.
- A failed cell (timeout, rate limit) is retried once on the next tick and never charged twice.
- Notification when the run finishes ("ChatGPT now names you for 'best electrician in Bristol'"),
  only when something changed since last month.

**Step 4 — the "AI answers" sub-tab and chat.**
- Sub-tab in `assistant-site-audit.js`: headline (named in X of Y, 3-month trend), the questions with
  one row per assistant (named? position, linked?), "Sites AI trusts", "Named instead", possible
  wrong facts, and the ideas (§3.8) in the existing ideas list. Each answer opens in full, labelled
  "API answer" with what that means (§5).
- Edit questions: add, reword (which starts that question's trend again — say so), retire.
- Chat: the Mystery Shopper's snapshot gains the latest run's summary, and two cards —
  `ai_visibility_questions` (propose edits) and `ai_visibility_recheck` (propose a re-run now, which
  shows its task cost). Same server actions as the tab (memory `assistant-gui-chat-parity`).
- Results tab: goal metric `ai_mention_rate` in `src/config/goal-metrics.ts`.
- Setup: the Mystery Shopper's setup gains one optional question, "Which town or area do most of
  your customers come from?", prefilled from Hours & Location.

**Step 5 — public taster (later, after D4).**
"Do AI assistants recommend you?" on the Mystery Shopper page: business name + town + trade, 3
questions × 3 assistants, result by email. Strong acquisition hook (the video sells exactly this
fear), but each run costs real money, so the same guards as `site-audit-public.ts` (kill switch,
honeypot, per-IP and per-email limits, daily cap) with a lower daily cap.

**Step 6 — copy, legal, help (before go-live, not after).** See §5.

## 5. What has to change outside the code

- **Sub-processors.** `privacy.html` lists OpenAI only for moderation and voice narration, and
  Google/Gemini not at all. Customer business names, towns and trades would now go to both. Add both
  with this purpose before Step 3 runs on any customer, and check the DPA wording.
- **The Mystery Shopper's own copy.** Its plan (§3.2) and public pages say it does not query
  ChatGPT and that the AI Search lens is a simulation. That becomes half-true: the lens stays a
  simulation, the new tab is real answers. Update the showcase, FAQ and help article (dated files
  only — memory `help-articles-quoting-and-renames`), and the Ask Your Team help-centre article.
- **What an "API answer" is, in plain words**, on the tab and in help: the same AI models and the
  same web search, asked from their area with no account or chat history — not a screenshot of what
  ChatGPT shows them personally, which is shaped by their own history. Never "what ChatGPT says
  about you" as a bare claim.
- **No ranking promises.** "We'll get you recommended by ChatGPT" is not something we can deliver;
  "we show you where you're missing and write what's needed to fill the gap" is.
- `/connections` is unaffected (no customer account is connected).

## 6. Decisions for the owner

- **D1 — where it lives. ✅ DECIDED 2026-11-01 (owner): an "AI answers" sub-tab of the Mystery
  Shopper**, not its own role.
- **D2 — which plans. ✅ DECIDED 2026-11-01: every plan that has the Mystery Shopper**, £29 included.
- **D3 — what a run costs the customer.** Measure first: run the admin page's next monthly fetch (1
  Nov) and read its cost (SQL below), then divide by its call count. Rough guess before measuring:
  30 calls with web search ≈ £0.40–£1.20 a month per customer. If that holds, **1 task per monthly
  run**, with a re-run on demand costing the same. If it's well above, weight it in `task-weights.ts`
  and update pricing/FAQ/terms in the same change (the file's own rule).
- **D4 — public taster. ✅ DECIDED 2026-11-01: after the paid version has a month of data** (real cost
  and noise known first). Step 5 waits.
- **D5 — how many questions. ✅ DECIDED 2026-11-01: 10 on every plan.**
- **D6 — Copilot and Google AI Overviews. ✅ DECIDED 2026-11-01: left out, and the tab says so.** They
  have no API (the admin page fills them by hand). Google AI Overviews matter most for local
  search, so it's worth watching for an API (Serper or SerpAPI return AIO text, which is a
  sub-processor and cost decision of its own).

SQL to measure D3 after the admin page's next fetch (read-only; paste into the Neon SQL editor for
**prod**):

```sql
-- Set the two times to just before and just after the fetch ran (UTC).
SELECT model, count(*) AS calls, sum(cost_usd) AS usd, sum(input_tokens) AS input_tokens
FROM ai_usage_log
WHERE workspace_id IS NULL
  AND created_at BETWEEN '2026-11-01 08:00' AND '2026-11-01 08:30'
GROUP BY model ORDER BY usd DESC;
```

`ai_usage_log` has no feature column, so this isolates the run by time and by having no workspace,
and anything else running then is counted too. It only covers the Claude calls through the gateway
(answers plus accuracy checks), and whether `cost_usd` includes the web-search fee should be checked
in the gateway. OpenAI and Gemini spend is in their own billing dashboards for the same window.

## 7. Risks

- **Noise read as movement.** The same question can name them in March and not in April with nothing
  changed. Mitigations: monthly cadence, 3-month trend beside the headline, the tab says one month on
  its own says little, and notifications only on a change that held across two runs (after month 2).
- **Name collisions.** "Bloom" or "The Barber Shop" will match other businesses. Whole-phrase match
  on name + town, or the website host in a cited URL; when the only evidence is a bare common name, the
  cell says "possibly you" rather than "named".
- **Rate limits at scale.** The OpenAI and Gemini keys are shared by every customer. Capped per tick (Step 3); watch
  for 429s in the error column after the first month.
- **Wrong-fact suggestions that are themselves wrong.** The judge only checks against the business's
  own records and never marks unconfirmed claims wrong (same prompt rules as today); every one is
  dismissible.
