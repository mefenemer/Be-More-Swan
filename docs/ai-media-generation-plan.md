# Native AI Media Generation — Implementation Plan

Routing all generation through **Fal.ai**: **Flux 2** for images (1 credit), **Hailuo 2.3** for
video (5 credits). Three epics: (1) native image/video generation + library, (2) credit cost
management + autonomous generation, (3) AI autonomous approval pipeline.

## What already exists (reuse)

| Capability | Status | Reuse |
|---|---|---|
| AI gateway | `src/lib/ai-gateway.ts` — Anthropic-only (text) | Add sibling `fal-gateway.ts`; don't overload |
| Async job + poll | `contentGenerationJobs` + `generate-post.ts` (POST enqueue, GET poll) | Same pattern; new `media_generation_jobs` table |
| R2 object storage | `storage-request-upload.ts` / `storage-confirm-upload.ts`, `workspace_assets` (`generated_content` already in MIME allowlist) | Persist Fal output bytes here (Fal URLs expire) |
| Post media attach | `content_assets` (`provider`, `assetType:image\|video`) ↔ `scheduled_post_assets`; Pexels picker `pexels-search.ts` | Add `provider:'fal'`; AI tab beside Upload/Pexels |
| Prompt safety | `src/utils/moderation.ts` `enforcePromptModeration()` | US1/US2 safety errors |
| Quota enforcement | `usage_counters` + `atomic-cap-check.ts`; limits in `master_plans` | Credit deduction + autonomous cap |
| Approval queue | `scheduled_posts` (`pending_approval`, `isAutonomous`), `review-queue.html`, `get-social-drafts.ts`, `draft-horizon-fill.ts` | US5/6/7/8 build on this |
| Notifications + email | `notifications` table, prefs matrix, `sendTemplatedEmail` | US8 alerts + digest |
| DB migrations | Hand-written idempotent `db/*.sql`, applied manually as owner (no `db:push`) | All new tables |

Nothing exists for **Fal.ai**, a **credit system**, or actual **image/video bytes** — current
"Generate Post" only produces text + a `suggestedMediaDescription` string.

## Key decisions

1. **Credits = a real ledger.** New `ai_credit_ledger` (append-only) + `ai_credit_balance` (one row/org,
   atomically updated like `storage_usage`). Monthly grant from `master_plans.features.monthly_ai_credits`.
2. **Persist Fal output to R2 immediately** (Fal URLs expire). Worker downloads bytes → R2
   (`generated_content`) → creates `content_assets` row (`provider:'fal'`). One generation = one durable asset.
3. **Separate `media_generation_jobs` table** (not `contentGenerationJobs`): prompt, model, aspect ratio,
   duration, status, credit hold, Fal request id, result asset ids. Supports async video + image grids.
4. **Deduct on success, hold at submit.** Atomic hold prevents oversubscription on slow video jobs; release
   (refund) on failure/moderation block.
5. **Autonomous generation extends `scheduled_posts`** (`isAutonomous=true`, `pending_approval`, new
   `generation_reason`), routed to a new "AI Approvals" tab. No parallel system.

## Phases

- **Phase 0 — Foundations:** `src/lib/fal-gateway.ts`; `db/ai-credits.sql` + `src/utils/ai-credits.ts`;
  `db/media-generation.sql` (`media_generation_jobs` + `content_assets` prompt/aspect/job columns). Env
  `FAL_KEY`, `FAL_IMAGE_MODEL`, `FAL_VIDEO_MODEL`.
- **Phase 1 — US1 AI Image (manual):** `generate-ai-image.ts` (moderate → hold → Flux 2 up to 4 → R2 →
  `content_assets`) + composer "Generate AI Image" tab (prompt ≤1000, aspect dropdown, balance + cost,
  loading, 2×2 grid, click-to-attach, policy error).
- **Phase 2 — US4 Credits surfaced:** balance in modal, cost preview, disabled + upgrade CTA on
  insufficient balance, refund-on-failure, admin per-tier grant in plan catalog.
- **Phase 3 — US2 AI Video (async):** `generate-ai-video.ts` (enqueue ≤500ms) +
  `process-media-job-background.ts` (poll Fal, download mp4 → R2) + GET poll. Composer: video settings
  (prompt, aspect, 3s/5s), minimize-and-keep-writing, native preview, completion toast (5 credits), mp4
  meets social constraints.
- **Phase 4 — US3 Generated Media Library:** "My AI Uploads" tab in `assets.html`
  (`content_assets WHERE provider='fal'`), prompt on info hover, delete (soft-delete + R2 lifecycle).
- **Phase 5 — US5 Autonomous generation:** ✅ per-assistant "Autonomous Content Suggestions" toggle +
  monthly credit cap (assistant-detail.html → `set-autonomous-media.ts`); daily cron
  `autonomous-media-suggestions.ts` drafts copy (`gatewayGenerate`) + AI image (`media-persist.ts`)
  within the cap (`holdAutonomousCredits`), writing `scheduled_posts` (`isAutonomous`,
  `pending_approval`, `generation_reason`). SQL: `db/autonomous-media.sql`.
- **Phase 6 — US6/7/8 Approval pipeline:** ✅ "AI Approvals" tab + dynamic badge, card view (thumbnail,
  reasoning note, platform, suggested time), platform/type filters (US6 — `get-ai-approvals.ts`);
  Approve&Schedule (`approve-post`) / inline Edit (`scheduled-posts` PATCH) / Regenerate Media with
  credit-cost confirm (`regenerate-post-media.ts`) / Discard + feedback (`reject-post`) (US7);
  per-run in-app summary notification + opt-in daily/weekly email digest with zero-spam
  (`ai-approvals-digest.ts`, `organisations.ai_digest_frequency`) (US8). SQL: `db/ai-digest.sql`.

## Credit economics (decided 2026-06-24)

Basis: **1 credit ≈ £0.10 of Fal cost** — a Flux 2 generation produces **4 variations** @ ~$0.03/MP
≈ $0.12. Video = 5 credits (Hailuo 2.3 Pro ≈ $0.49). Allowances keep media COGS ≈ 10% of tier
revenue. Credits **roll over** month to month (top-up, not reset).

| Tier | Monthly credits | Video? |
|---|---|---|
| trial | **0** (no AI generation on trial — upgrade to use) | no |
| buster (£20) | 20 | no |
| saver (£50) | 50 | **yes** |
| employee (£100) | 100 | **yes** |

Wired into `master_plans.features.monthly_ai_credits` via `seed/data/master_plans.json` +
`db/seed-catalog.ts` (trial) + idempotent `db/ai-credit-grants.sql` (existing DBs). Video tier
restriction enforced in code via `tierCanGenerateVideo()` (src/utils/ai-credits.ts), applied in the
Phase 3 video function + UI.

### Still open
- Keep 4 variations/credit, or drop to 1–2 to stretch credits / cut COGS?
