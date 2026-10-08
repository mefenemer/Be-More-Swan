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
3. **"Generate 4, pick 1" is a setting, not a rule.** Four videos is 20 credits per brief. Defaults:
   stock 4–8 options (free), AI image 2 (max 4), AI video 1 with a re-roll button. The cost is shown
   on the button before the click.
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

Storage: open decision D2 — either a `visual_briefs` table, or `assistant_records` with
`recordType = 'visual_brief'` (which would also need adding to `READ_RECORD_TYPES`, see
`tests/campaign-tabs-load.test.ts`).

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

### 4.5 Brand guidelines (fields on `brand_kit`)

Added to `BrandKit`: `secondaryColors[]`, `photoStyle` (e.g. "bright, natural light, real people"),
`illustrationStyle`, `mustInclude[]`, `mustAvoid[]` (e.g. "no stock handshakes"), `toneWords[]`.
All optional; existing extraction keeps filling the current fields. Every AI prompt and every card
render reads them, so output is on-brand by default.

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
2. **Brand guidelines** fields on `brand_kit`, fed into prompts and cards.
3. **`commission_visuals`** campaign order + delivery judgement in the reconciler.
4. **AI video + human-made + Canva** as sources in the same queue.
5. **SMM / Blog Writer raise briefs** instead of auto-picking media when nothing fits.

Each step lands with: DDL in an idempotent `db/z-*.sql` applied to both environments **before** the
code, the drizzle mirror, the GUI control, the chat card and prompt text, explainers (`data-explain`
+ glossary entries), and tests.

## 7. Open decisions (the user's)

- **D1 — Pricing:** keep AI credits (recommended), or move imagery onto the task allowance?
- **D2 — Storage of briefs:** own `visual_briefs` table, or `assistant_records` rows?
- **D3 — Video provider:** stay on Hailuo, or add a premium option (Runway / Luma / Veo) at a higher
  credit price?
- **D4 — Options per brief:** the defaults in §3.3, or different?
- **D5 — Plans:** which tiers get the Brand Designer, and is it its own hire or part of a bundle?

## 8. Selling it — what can and cannot be claimed

Stock search, AI images and brand kits exist in Canva, Adobe Express and Buffer. The difference here
is that the designer is **wired into the campaign planner and the social scheduler**: the campaign
asks for the visuals, the user approves a grid, and the posts go out with them. That is the pitch.

Do not claim in public copy that it "replaces your designer", or anything about quality, until real
customers are approving AI options without editing them — see the public-copy-vs-system rule.
