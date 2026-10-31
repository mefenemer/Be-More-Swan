# Video Producer — Plan

Added 2026-10-31, from an owner discussion of a "faceless YouTube" AI video stack (ChatGPT +
Midjourney + Leonardo + ImageFX + Veo + Runway + Suno + CapCut, roughly $100–$245/month at verified
2026-10-31 prices) and what Be More Swan would need to do the same job as one assistant.
Status: **proposed, not started.** Nothing below exists yet unless marked ✅ (already built, reused).

Related: [brand-designer-plan.md](./brand-designer-plan.md) (visual briefs: stock / AI image / AI
video / brand-card options — the sourcing engine this plan reuses),
[video-editing-plan.md](./video-editing-plan.md) (the `video_edit` model and the post editor),
[ai-media-generation-plan.md](./ai-media-generation-plan.md) (fal, credits),
[remotion-render.md](./remotion-render.md) (render deploy runbook),
[campaign-orchestrator-plan.md](./campaign-orchestrator-plan.md) (orders and hand-offs).

---

## 1. Requirements (from the owner)

1. One assistant that does the whole video job end to end: research and script → pictures → video
   clips → music → edit → publish. Working names were "Video Creation Assistant" or "Video Producer
   Assistant".
2. Know what is already built and what is left.
3. Answer whether there is a need for it at all.

## 2. Is there a need? — and for which video

**Yes, but not for the video that prompted the question.** The example was a 73-minute 4K ambient
YouTube video, made from a few dozen AI clips looped and crossfaded. That is a creator /
faceless-channel market. It does not match our customers (small businesses on £29–£349 plans), it
hits render-time and cost limits, and it does not fit the "digital employee" positioning.

What our customers need is **short-form promotional video: 15–60 seconds, 9:16, for Instagram
Reels, YouTube Shorts and Facebook (TikTok later — §7 Phase 8)**, built from their own products,
offers and brand, with a voiceover and captions, published on the same calendar as their posts.

Evidence that already exists in our own data:
- A prod user (Limi DJ) asked the Social Media Manager to "create a reel with these 4 videos I
  uploaded" — the request that started [video-editing-plan.md](./video-editing-plan.md).
- YouTube is video-only, so every connected YouTube account sat idle until the weekly Short was
  built. Every assistant we have drafts stills.
- Instagram and Facebook are pushing Reels distribution over static images.

How we would be different from CapCut, Canva, InVideo AI, Pictory, HeyGen or Opus Clip: those are
tools the owner drives. The Video Producer **already knows the business** (Business Info, products,
offers, Brand Knowledge, voice profile, hooks, brand kit), writes its own brief, makes the video,
and schedules and publishes it beside the Social Media Manager's posts. ⚠️ **Do a competitor check
before any public claim** (same rule as the Business Mentor plan) — several of those tools have
added "script to video" features, and our claim must be the business knowledge plus publishing,
not "AI makes videos".

**Recommendation: build it, short-form only.** Most of the parts are worth building anyway — four of
the eight phases (§7) improve the Social Media Manager and the Brand Designer even if the role never
ships.

## 3. What already exists — reuse, do not rebuild

| The job | Already built ✅ | Where |
|---|---|---|
| Research, script, hooks, CTA | Every drafter reads Business Info, products, offers, Brand Knowledge, voice profile, hooks + CTA | `voice-profile.ts`, products/team-activity prompt blocks, hooks setting |
| Per-scene visual sourcing | **Visual briefs**: stock photo, stock video, AI image (4 for 1 credit), AI video, brand card, upload, Canva import | `src/utils/visual-briefs.ts`, `visual_briefs` / `visual_brief_options` |
| AI images | fal FLUX 1.1 Pro, no-text rule, `visualisePrompt` rewrite | `src/lib/fal-gateway.ts`, `src/lib/image-prompt.ts` |
| AI video clips | fal Hailuo 2.3 text-to-video, 6 s or 10 s, 5 credits, £79+ plans | `generate-ai-video.ts`, `process-media-job-background.ts` |
| Stock footage | Pexels photos + videos, de-duplicated | `src/utils/pexels.ts`, `media-sources.ts` |
| Music | 40-track curated CC0 library + Stable Audio 3.0 generation | `music-library.ts`, `generate-ai-music.ts` |
| Edit model | Ordered multi-clip list, trim (`inS`/`outS`), per-clip gain, target ratio, per-platform crop — phases 1–4 | `src/lib/video-edit.ts`, `save-post-video-edit.ts` |
| Timed text and audio | Text overlays + audio overlays (fades, mute camera audio under music) | `overlay-geometry.ts`, `audio-overlays` |
| Render | Remotion Lambda, async, publish gated on `render_status`; webfonts fixed | `render-post-video-background.ts`, `remotion/PostOverlay.tsx`, `src/lib/post-render.ts` |
| Still → video | Image branch of the composition (used by the weekly Short) — static, no motion | `remotion/Root.tsx`, `trigger-youtube-short.ts` |
| Publish | Instagram, Facebook, YouTube (resumable, background, resume state); Review Queue, slots, approvals | `social-publish.ts`, `publish-youtube-background` |
| Safety | AI media never auto-publishes; video platforms always route to review | `publish-policy.ts`, `gateAutonomousDraft` |
| TTS (internal only) | OpenAI TTS for the guided tour, cached | `tour-narration.ts` |

So the engines exist. What is missing is a **planner** (brief → storyboard), an **assembler**
(storyboard → `video_edit` + overlays + audio, with no human dragging), **voiceover**, **captions**,
a **better clip model**, and the **role** around them.

## 4. Who does what — Video Producer vs Brand Designer vs Social Media Manager

| Assistant | Owns | Video work |
|---|---|---|
| Social Media Manager | Posts, captions, the calendar | Edits **the user's own footage** into a reel (video-editing plan). Unchanged. |
| Brand Designer | Single visuals from a brief | One picture or one clip per brief. Unchanged. |
| **Video Producer** | **Finished videos made from scratch** | Script, storyboard, sources every scene, voiceover, captions, music, assembly, publish |

- The Video Producer **calls the visual-brief engine directly** (`visual-briefs.ts`) to source each
  scene. It does **not** hand off to the Brand Designer: a workspace may not have hired it, and an
  assistant must never point at an unhired or paused teammate
 . Same engine, no dependency on the role.
- The Social Media Manager can **hand a post to the Video Producer** ("make a video version of this")
  when both are active. The hand-off artifact is decided by the **target** role
 , so the Video Producer's route must produce a
  video project, not a social draft.
- A finished video is an ordinary `scheduled_posts` row with a `video_edit`, so it shows in the same
  Review Queue, calendar and Results as every other post.

## 5. The design

### 5.1 The role

roleKey **`video_producer`** (snake_case, verbatim in `db/seed-catalog.ts`), display name **Video
Producer** — matches Blog Writer / Newsletter Editor (a job title, not a tool). `iconKey` /
`iconColor` from the existing set; icon colour stays user-set afterwards.

### 5.2 The video brief

What a video is for: purpose (promo / product spotlight / offer / tip / testimonial-style / event),
length (15 / 30 / 60 s), platforms (decide the frame — 9:16 default), message, the product or offer
it is about, CTA (the assistant's `ctaOffer` — binding, as everywhere), voiceover on/off and voice,
music mood, allowed sources (stock only / stock + AI / AI-first), and a due date.

Briefs come from: the user (button or chat), the schedule (autopilot cadence, §5.9), a Social Media
Manager hand-off, or a Campaign Orchestrator order (`commission_video`, priced and approved like
other orders).

### 5.3 The storyboard (the new core)

The model turns a brief into a **storyboard** — a strict JSON list of scenes:

```ts
interface Scene {
    id: string;
    beat: 'hook' | 'problem' | 'value' | 'proof' | 'cta';
    voiceover?: string;        // one or two sentences
    onScreenText?: string;     // short; the caption track is separate (§5.6)
    visual: {
        source: 'stock_video' | 'stock_photo' | 'ai_video' | 'ai_image' | 'brand_card' | 'product_photo' | 'upload';
        prompt?: string;       // for AI sources — no words on screen (NO_TEXT_RULE)
        keywords?: string;     // for stock
        assetId?: number;      // a product photo or library asset
        motion?: 'push_in' | 'pull_out' | 'pan_left' | 'pan_right' | 'none';  // stills only (§5.7)
    };
    targetS: number;           // planned length; the real length comes from the voiceover (§5.5)
}
```

Rules enforced in code, not only in the prompt:
- First scene is a hook and lasts ≤ 3 s; the last scene carries the CTA.
- Total within ±10 % of the requested length.
- Stock-first by default. AI video only where the brief allows it, capped per video (D4).
- Product scenes use the business's **own product photos** when they exist — never an AI picture of
  their product (it would invent the product).
- Every URL in voiceover or text goes through `groundLinks` (models invent URLs).

Storage: `video_projects` (org, assistant, brief JSONB, storyboard JSONB, status, `scheduled_post_id`,
credits held/spent) in `db/z-video-producer.sql` + `db/schema.ts`. ⚠️ **SQL before code on BOTH DBs**
— a new table read by a bare `db.select()` breaks the page until applied
.

### 5.4 Sourcing each scene

For each scene, call the visual-brief engine for that source and pick the top option automatically
(user can swap any scene in review, §5.8). AI video is submitted as **image-to-video**: FLUX makes an
on-brand frame first, then the clip model animates it. That gives:
- the right aspect ratio (Hailuo text-to-video has **no** aspect-ratio input, so it cannot make a
  reliable 9:16 — the reason the weekly Short avoided it);
- scenes that look like one video instead of five unrelated clips;
- a cheap preview (the still) before the expensive step.

Needs `submitImageToVideo` in `fal-gateway.ts` and a model choice (D3). Price per clip must be read
from the provider's page at build time — do not guess per-second rates.

### 5.5 Voiceover

New: customer-facing TTS. The voiceover is generated per scene, stored as a `content_assets` audio
row, and placed through the **existing** audio overlays — a voiceover is a new source of an assetId,
not a new pipeline (same move as the music library).

- **The voiceover sets the timing.** Each scene's real length = its voiceover length + a short tail;
  clips are trimmed (`inS`/`outS`) or stills held to fit. Music ducks under speech.
- Provider (D2): OpenAI TTS is already integrated (tour) but returns **no word timestamps**;
  ElevenLabs returns timestamps and sounds better but is a new key, bill and balance to watch.
  Without timestamps, captions need a transcription pass on the generated audio.
- Voice picked per assistant (a short list), previewable like the voice builder's "Hear it".
- No voice cloning in v1 (consent, impersonation).

### 5.6 Captions

Burned-in, word-by-word or phrase captions — most short-form is watched muted. A new `captions`
layer in `remotion/PostOverlay.tsx`, driven by the word timings from §5.5, styled from the brand kit
(font, colour, safe area). ⚠️ Every change to `remotion/*` needs `remotion:deploy-site` on **both**
staging and prod, and `npm run remotion:site-drift` to prove it — pushing does not update the
deployed bundle.

### 5.7 Motion on stills

Product photos and AI images need slow movement (push-in, pan) or the video looks like a slideshow.
Extend the composition's image branch with a `motion` prop (scale/translate over the scene). Also
useful to the weekly Short and the Brand Designer.

### 5.8 Assembly and review

The assembler is pure where it can be (`src/lib/video-assembly.ts`): storyboard + sourced assets +
voiceover timings → `VideoEdit` (clips, `targetRatio`, `frames`) + text overlays + audio overlays.
It writes the `scheduled_posts` row and queues the render through the existing `trigger-post-render`.

Review is the existing Review Queue card plus a **storyboard panel**: script per scene, swap a
scene's visual (re-source, shows credit cost first), edit a line (re-voices that scene only), change
music, re-render. The finished cut opens in the existing post editor for anything finer.
Rejection reasons feed the next storyboard (the reject → learn loop).

Never publish a generated cut without review in v1: video platforms already route to review via
`gateAutonomousDraft`, and AI media never auto-publishes.

### 5.9 Cadence

Optional autopilot: N videos a week (default 1), on posting days from the shared cadence config,
topics from content pillars / Inspo / products — the same slot logic as other drafters. Off until the
owner turns it on during onboarding.

### 5.10 GUI and chat parity

Every capability is a GUI action AND a chat action calling the same server action; chat proposes a
card, the user's click spends.

| Capability | GUI | Chat |
|---|---|---|
| New video from a brief | "New video" form | "Make a 30s video about our autumn offer" → brief card |
| See / edit the storyboard | Storyboard panel | "Show me the script" / "change scene 2 to …" → proposal card |
| Swap a scene's visual | Scene → re-source | "Use a stock clip for the hook instead" → card with cost |
| Change voice / music | Panel pickers | "Use a calmer voice" → card |
| Render / re-render | Button | Card |
| Approve / schedule | Review Queue | Card (never claims done before the click) |
| Cadence on/off, count | Settings | "Do two videos a week" → card |
| Hand a post over (from SMM) | "Make a video version" on a post | Hand-off card |

### 5.11 System prompt

Built through the existing prompt layers (`assistant-prompt-layers.ts`): date block, Business Info,
products + offers, Brand Knowledge, voice profile, hooks + **binding** CTA, safety benchmark. Role
expertise: short-form structure (hook in 3 s, one idea, CTA last), speaking-length scripts (~2.5
words per second), no on-screen text from the image model, own product photos for products.

## 6. Failure modes designed for up front

| Failure | Design answer |
|---|---|
| A provider runs out of balance (fal did 2026-09-28, AI dark for days) | Phase 0: fal + TTS on `check-provider-balances` and the prod watchdog **before** launch |
| A render never finishes | Every worker path reaches a terminal `render_status`; a stuck post is invisible to all publishers |
| Remotion site stale after a composition change | Deploy both sites + drift check in the release steps for Phases 3–5 |
| Partial generation (3 of 5 scenes made, then a failure) | Project keeps per-scene state; retry only failed scenes; credits held per scene, refunded on failure |
| Voiceover longer than the clip | Voiceover sets scene length; stills hold, clips trim or loop once, never cut speech |
| AI invents the customer's product | Product scenes use product photos only; refuse AI for `product_photo` beats |
| Fonts substitute on Lambda | Webfonts already loaded in editor + bundle; captions use the same set |
| Cost surprise | Estimated credits shown on the brief before generating; hard cap per video (D4) |
| YouTube uploads forced private | Confirm the Google upload audit before selling YouTube as a destination |

## 7. Build order

Phases 1–4 each ship on their own and improve existing assistants. The role comes last.

**Phase 0 — prerequisites (mostly no code)**
- Owner decisions D1–D7 (§8).
- fal + TTS balances on `check-provider-balances`; fal failure rate on the watchdog.
- Read both deployed Remotion `bundle.js` files and confirm they match the repo.
- Confirm the YouTube upload audit status.
- Competitor check (§2) — written down before any marketing copy.

**Phase 1 — image-to-video**
`submitImageToVideo` in `fal-gateway.ts`; `ai_video` options in `visual-briefs.ts` start from a FLUX
frame; aspect ratio honoured. Benefits the Brand Designer and My Content immediately.

**Phase 2 — voiceover**
TTS gateway + metering, `content_assets` audio, voice picker, "Add voiceover" in the post editor's
Sound inspector. Benefits the Social Media Manager's reels.

**Phase 3 — captions**
Word timings (from TTS or a transcription pass), `captions` layer in the composition, brand styling,
both Remotion sites deployed.

**Phase 4 — motion on stills**
`motion` prop on the image branch; weekly Short picks it up.

**Phase 5 — storyboard + assembly (the core)**
`db/z-video-producer.sql`, storyboard generation with code-enforced rules, per-scene sourcing,
`video-assembly.ts`, render, storyboard review panel. Tests: storyboard validator, assembler (pure),
per-scene retry, credit hold/refund.

**Phase 6 — the role**
Full assistant onboarding checklist pass: catalogue entry (`comingSoon: true`),
connection map (security — explicit entry), onboarding schema with one `operational` step, chat
route + prompt layers, surface registry flags (not social-shaped by default), dashboard (4 KPI cards,
Results tab), starter prompts, goal metrics, notifications, assistant features, help article (dated
SQL file), showcase page JSON, pricing row, Business Mentor + Ask Your Team routing, build manifest.

**Phase 7 — cadence and hand-offs**
Autopilot videos per week; Social Media Manager "make a video version"; Campaign `commission_video`.

**Phase 8 — later, separately decided**
TikTok publishing (OAuth scopes are scaffolded in `oauth-integrations.ts`, but there is no publish
driver and TikTok is not in the social catalogue — needs TikTok's app audit); long-form YouTube;
vision-based clip picking from user footage (named v2 in the video-editing plan); voice cloning.

## 8. Open decisions (the owner's)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Name | **Video Producer** |
| D2 | TTS provider | ElevenLabs if word timestamps + quality matter more than a new bill; else OpenAI TTS + transcription pass |
| D3 | Clip model for image-to-video | Compare Kling, Veo 3.1 (Fast) and Seedance on fal for 9:16 quality and price per 5 s; keep Hailuo as fallback. Decide on real renders of the same 3 prompts |
| D4 | Credits per video and per-video cap | Price per scene by source (stock free, AI image 1, AI clip by model cost, voiceover per minute), show the estimate first, cap AI clips per video (e.g. 3) |
| D5 | Which plans | Same as AI video today (£79 Busywork Buster + £349 Digital Employee) — use `hasFeatureByOrg('ai_video_generation')`, not a hardcoded tier list |
| D6 | Brand Designer go-live first? | Not required — the engine is shared — but launching both together tells one story ("pictures and videos, made for you") |
| D7 | Autopilot default | Off; 1 video a week when turned on; always reviewed |

## 9. Selling it — what can and cannot be claimed

Can claim (once built): writes the script from your business info, sources footage and pictures,
adds a voiceover, captions and music, edits it to length, and schedules it with your posts for your
review.

Cannot claim:
- That it **watches** or picks the best moments from your footage — it does not (no vision in v1).
- Long-form or TikTok — until Phase 8 ships.
- "Replaces $X of tools" — only with verified, dated prices and a fair comparison stack, and checked
  against what the system actually does today.
- That AI-made videos post on their own — they are always reviewed in v1.

## 10. Out of scope for v1

Long-form (> 60 s) and ambient/looped videos; avatars / talking heads; voice cloning; vision-based
footage selection; TikTok; per-platform different cuts (one cut, many frames — as the video-editing
plan).
