# Brand Designer — Plan

Added 2026-10-08, from a review of an external Brand Designer proposal against the code as built.
Status: **proposed, not started.** Nothing below exists yet unless marked ✅ (already built, reused).

Related: [ai-media-generation-plan.md](./ai-media-generation-plan.md) (fal generation, credits),
[canva-connector-plan.md](./canva-connector-plan.md) (import-only Canva),
[campaign-orchestrator-plan.md](./campaign-orchestrator-plan.md) §9.3 (campaign pictures) and §9.5
(human tasks), [blog-media-composition-plan.md](./blog-media-composition-plan.md),
[video-editing-plan.md](./video-editing-plan.md).

---

## 1. Requirements (from the user)

1. **Not dependent on Canva.** Be More Swan must be able to do everything natively. If a user
   *chooses* to bring in their own Canva designs, that is fine — Canva is an optional source, never
   a requirement.
2. **Royalty-free image AND video sourcing.**
3. **AI image AND video generation.**
4. **GUI and chat parity** (campaign plan §9.0): everything the Brand Designer does through its
   screens must also be achievable by chatting to it. Chat proposes a card; the user's click is what
   generates, spends credits or approves. Chat never spends on its own.

## 2. What already exists — reuse, do not rebuild

Most of the engine the proposal asks for is already in the product. The Brand Designer is the
**product around it**, not a second engine.

| Proposal asks for | Already built ✅ | Where |
|---|---|---|
| Royalty-free images | Pexels search + import | `src/utils/pexels.ts`, `netlify/functions/pexels-search.ts` |
| Royalty-free video | Pexels video, de-duplicated | `searchUniqueVideos` in `media-sources.ts` |
| AI images | fal **FLUX 1.1 Pro** (`FAL_IMAGE_MODEL` overrides) | `src/lib/fal-gateway.ts`, `generate-ai-image.ts`, `regenerate-post-media.ts` |
| AI video | fal **Hailuo 2.3** standard text-to-video | `generate-ai-video.ts` |
| Native designs (no Canva) | Typographic brand cards (satori + resvg) in the brand kit; text overlays baked on approve; Remotion video renders | `brand-card-lifecycle.ts`, `edit-brand-card.ts`, `save-post-overlays`, `suggest-overlay-text`, `render-post-video-background` |
| Sound | Curated CC0 music library + Stable Audio generation | `music_tracks`, `generate-ai-music.ts` |
| Canva optional | Canva is **import-only** (read scopes only: `design:meta:read design:content:read folder:read asset:read`) | `canva-browse`, `canva-import*` |
| Brand kit | `organisations.brand_kit`: primary/text/background colour, wordmark, logo, website, font, source, extractedAt | `src/utils/brand-kit.ts`, `brand-kit.ts` fn |
| Asset library | `content_assets` (with width/height/duration) | `db/schema.ts` |
| Campaign pictures | `campaign_assets` | campaign plan §9.3 |
| Social Media Manager waits for a human upload | Human tasks with hold-until, filed in Jira/Asana | campaign plan §9.5 |
| Human checks AI images before posting | AI media never auto-publishes unless the business turns it on (off by default) | `src/utils/publish-policy.ts` |
| Credits | Image 1, video 5 (video on `saver`/`employee` tiers only), music 5 / 3 shared — separate from the task allowance | `src/utils/ai-credits.ts` |

So requirements 1–3 are already met **in the engine**. What is missing is a single place where
visuals are briefed, generated, reviewed and approved — and an assistant that owns it.

## 3. Where the proposal is changed

1. **No `brand_guidelines` or `brand_assets` tables.** They would duplicate `brand_kit` and
   `content_assets` / `campaign_assets`. The product already has two asset tables (content and
   workspace) and that split already confuses. Guidelines are new **fields on `brand_kit`**;
   approved visuals are `content_assets` rows.
2. **No 1 / 3 / 10 task tiers.** That would be a second price list for the same thing next to AI
   credits. Keep AI credits (open decision D1). Stock stays free to search; importing costs nothing.
3. **"Generate 4, pick 1" costs 4× only for video.** For images it is already free of that problem:
   `generate-ai-image` charges **1 credit for a grid of 4 FLUX variations** (corrected 2026-10-08 —
   this line first said 1 credit per image). Built defaults (`src/config/visual-brief-vocab.ts`):
   stock 4 (free), AI image 4 for 1 credit, branded cards 2 (free). Video (Phase 4) stays 1 per
   round with a re-roll button, since four videos is 20 credits. The cost is on the button before
   the click.
4. **Midjourney is out** — no official API. **DALL·E 3 is out** — a second image provider adds a
   bill, a key and a failure mode for no clear gain over FLUX. **Runway / Luma / Sora** are revisited
   only if Hailuo quality is the complaint customers actually make (open decision D3).
5. **Unsplash is out for now.** Its API terms (as understood — re-check before relying on this)
   require hotlinking their URLs, firing a download event, and attribution — which does not fit
   copying into our private R2. Pexels is already integrated with looser terms.
6. **Provider outages must be visible before launch.** The fal balance ran out around 2026-09-28
   and AI images failed silently for days. An assistant whose headline is AI visuals needs the fal
   balance / failure rate on the prod watchdog **first** (Phase 0).

## 4. The design

### 4.1 The role

A new assistant, roleKey **`brand_designer`** (snake_case, added to `db/seed-catalog.ts` verbatim),
display name **Brand Designer**. It owns no generation engine; it orchestrates the ones in §2.

### 4.2 Briefs

A **visual brief** says what is needed: purpose (post / blog header / ad / email header / story),
format (aspect ratio, image or video, length), message, mood, must-include / must-avoid, due date,
and which sources are allowed.

Briefs come from four places:

| From | How |
|---|---|
| The user | "New brief" button, or chat |
| Campaign Assistant | New order action **`commission_visuals`**, priced and approved like every other order (campaign vocab + reconciler); delivered when the brief has its approved visuals |
| Social Media Manager / Blog Writer | A draft with no usable media can raise a brief instead of auto-picking stock |
| A person | "Someone on my team will make it" → a §9.5 human task (Jira/Asana optional); their upload answers the brief |

Storage (D2, decided 2026-10-08): own tables, `visual_briefs` + `visual_brief_options`
(`db/z-brand-designer.sql`). Options are deliberately NOT `content_assets` rows — My Content lists
every one of those, so a dozen candidates per brief would bury the user's real pictures; an option
becomes a library asset only when approved.

### 4.3 Sources per brief

Each brief produces **options** from the sources the user allows:

- **Stock** — Pexels images / video (free).
- **AI image** — FLUX, prompt built from the brief + brand kit guidelines (1 credit each).
- **AI video** — Hailuo (5 credits each, tier-gated as today).
- **Brand card** — native typographic design in brand colours, font and logo (free).
- **Brand card over stock/AI** — an option with baked overlay text (reuses the overlay bake).
- **Canva import** — optional, only shown when Canva is connected.
- **Upload / a person makes it** — native upload, or a human task.

### 4.4 The visual review queue

A grid per brief: approve, reject with a reason, re-roll (shows the credit cost first), or edit text
on a card. The rejection reason is fed back into the next prompt for that brief.

Approved option → a `content_assets` row (source + provenance recorded) and, if the brief came
from a campaign, a `campaign_assets` link. Rejected AI options are not kept in the library.

The Review sidebar badge counts briefs waiting on the user, like every other review queue.

### 4.5 Brand guidelines (`organisations.brand_guidelines`)

✅ Built 2026-10-08 (Phase 2). **Changed from the first draft, which said "fields on `brand_kit`":**
website extraction replaces `brand_kit` WHOLESALE (two writers — `brand-kit.ts` extract and the lazy
path in `brand-extract-fetch.ts`), so a guideline a person typed would be wiped the next time the
colours were re-read; and every branded card copies the whole kit into its `render_params`. So they
are a column of their own (`db/z-brand-guidelines.sql`) — still no new table — and saving them does
not mark the kit `manual`, so colour extraction carries on.

Fields (`src/utils/brand-guidelines.ts`): `photoStyle`, `mustInclude`, `mustAvoid`,
`secondaryColors[]` (max 4). `illustrationStyle` and `toneWords` from the first draft were dropped:
nothing generates illustrations, and tone of WORDS belongs to the writing assistants' brand voice.

Who reads them: every AUTOMATIC AI image — `generateAndPersistImage`, the one function the post
editor's regenerate, autopilot drafting and media suggestions all go through — and the Brand
Designer's art direction (Phase 1 setup answers only fill a guideline the workspace left empty).
NOT the manual "Generate with AI" box (the user wrote that prompt), NOT branded cards (the renderer
draws three kit colours), and NOT stock search (Pexels has no exclusion filter — the UI says so).

Edited on Business Information ▸ Brand Assets ▸ Picture guidelines, or from the Brand Designer's chat
(`brand_guideline_proposal` card, which replaces whole fields — the chat is shown the current text).
The Briefs tab shows them with a link straight to that tab. Guarded by `tests/brand-guidelines.test.ts`.

### 4.6 GUI and chat parity

| Capability | GUI | Chat |
|---|---|---|
| Create a brief | New brief form | "I need 3 options for the Black Friday post" → **brief card**, user clicks Create |
| Generate options | Source checkboxes + Generate (cost shown) | Card shows sources + cost; click generates |
| Approve / reject / re-roll | Review grid | "approve the second one" → **review card**; click writes |
| Edit brand guidelines | Brand kit screen | "never use stock handshakes" → **guideline card** |
| Commission from a campaign | Campaign Add work → `commission_visuals` | Campaign Assistant's plan card (existing flow) |
| Hand to a person | "Someone on my team will make it" | Task card (existing §9.5 flow) |

Chat never generates, spends credits, or approves without the user's click. The chat snapshot
lists open briefs and how many options are waiting for review.

### 4.7 System prompt

The Brand Designer's drafting prompt is built from: brand kit + guidelines, the brief, the platform
format rules, rejection reasons from this brief, and campaign tone (§9.3) when commissioned by a
campaign. It writes **image prompts and card copy only** — it never claims a visual exists before
generation returns.

## 5. Failure modes designed for up front

- **Provider down / balance exhausted** → option shows "AI unavailable — stock and cards still
  work", credit not charged, and the watchdog alerts (Phase 0). Never a silent empty grid.
- **Credits run out mid-brief** → stops, says how many were made, offers stock and cards (free).
- **A brief nobody answers** → due date passes → shown on the brief and in the campaign; a
  commissioned order is judged as not delivered, the campaign's waiting work stays blocked (as §9.5).
- **AI output auto-publishing** → unchanged: `publish-policy.ts` keeps AI media off autopilot unless
  the business opted in.
- **Licensing** → every asset records its source and licence; stock attribution is stored even
  where not required.

## 6. Build order

0. **Watchdog**: fal balance + AI media failure rate on the prod monitor. Before anything ships.
   ✅ **Built 2026-10-08.** The balance half already existed: `check-provider-balances` (every 6h)
   emails on a fal lock or a low balance (`FAL_ADMIN_KEY` is set on prod, so the low-balance warning
   works), and its heartbeat feeds `platform-watchdog` + `prod-watchdog.yml`. Added: AI image/video
   failures for ANY other reason — retired model id, rejected key, fal outage — and videos stuck in
   `queued`/`processing` over an hour, read from `media_generation_jobs` per media type. Alerts
   when ≥2 workspaces are affected (DOWN, or a warning if a fal asset has generated since); excludes
   the lock (own rule), `Superseded:` clean-up, policy-flagged prompts and deleted owners. Guarded by
   `tests/provider-balances.test.ts` (rules) and `tests/media-failure-evidence.test.ts` (the SQL, on
   real Postgres in the CI rls job).
1. **Role + briefs + review queue** (GUI and chat together), stock + AI image + brand card sources.
   ✅ **Built 2026-10-08.** `db/z-brand-designer.sql` (tables, catalogue row `coming_soon=true`,
   `ai_image_generation` grant — apply to both DBs BEFORE deploy). Engine `src/utils/visual-briefs.ts`;
   API `brand-briefs.ts` (list / create / edit / generate / decide / cancel / performance); worker
   `generate-brief-options-background.ts`; tab `assistant-briefs.js`; chat route `brand_designer` with
   `visual_brief_proposal` + `visual_option_review` cards; setup asks house photo style, "never show"
   and default sources. A round holds its AI credit at the click and is settled ONCE (worker, or the
   10-minute sweep on `list`) — proven on real Postgres in `tests/visual-briefs-db.test.ts`.
   ⚠️ A chat card may only start a round whose sources are all free; a brief with AI images is saved
   from chat and its round is started on the Briefs tab, where the cost is on the button.
   Not done in Phase 1: the sidebar Review badge does not count briefs (the tab badge does); stock
   search is not filtered by orientation; the chat sees options by id and source, not the pictures;
   AI options left undecided on a finished brief stay in R2 until the brief is cancelled.
2. **Brand guidelines** — ✅ built 2026-10-08 as `organisations.brand_guidelines`, not kit fields (§4.5).
3. **`commission_visuals`** campaign order + delivery judgement in the reconciler.
   ✅ **Built 2026-10-08.** `db/z-campaign-visuals.sql` (brief → campaign + order links, `origin`
   'campaign', artefact kind `visual_brief`, "works with" both ways). One brief per order, 1 task.
   Executor (`campaign-orders.ts`) creates the brief from the order's `show`/`headline` (else the
   objective), the campaign's tone as mood, and the designer's default sources; it starts a round
   ONLY when every source is free — a brief with AI images waits for "Make options" on the Briefs
   tab, so approving a campaign plan never spends an AI credit. Approving an option attaches it to
   `campaign_assets` and settles the order DELIVERED at once (releasing work waiting on it);
   cancelling settles rejected, or failed + refunded if nothing was ever made. The hourly reconciler
   judges the same way as the backstop (`src/utils/campaign-visual-order.ts`, proven on Postgres in
   `tests/visual-briefs-db.test.ts`). Chat: the Campaign Assistant can plan the order, and is now told
   which orders this workspace can run (an unhired assistant's order was refused only at placement).
   GUI: Add work → "Commission pictures". Guarded by `tests/campaign-visual-orders.test.ts`.
4. **AI video + human-made + Canva** as sources in the same queue.
5. **SMM / Blog Writer raise briefs** instead of auto-picking media when nothing fits.

Each step lands with: DDL in an idempotent `db/z-*.sql` applied to both environments **before** the
code, the drizzle mirror, the GUI control, the chat card and prompt text, explainers (`data-explain`
+ glossary entries), and tests.

## 7. Open decisions (the user's)

- **D1 — Pricing:** keep AI credits (recommended), or move imagery onto the task allowance?
- ~~**D2 — Storage of briefs**~~ — decided: own tables (§4.2).
- **D3 — Video provider:** stay on Hailuo, or add a premium option (Runway / Luma / Veo) at a higher
  credit price?
- **D4 — Options per brief:** built with the §3.3 defaults (4 stock, 4 AI for 1 credit, 2 cards) — change in `SOURCE_SPECS`.
- **D5 — Plans:** which tiers get the Brand Designer, and is it its own hire or part of a bundle?

## 8. Selling it — what can and cannot be claimed

Stock search, AI images and brand kits exist in Canva, Adobe Express and Buffer. The difference here
is that the designer is **wired into the campaign planner and the social scheduler**: the campaign
asks for the visuals, the user approves a grid, and the posts go out with them. That is the pitch.

Do not claim in public copy that it "replaces your designer", or anything about quality, until real
customers are approving AI options without editing them — see the public-copy-vs-system rule.
