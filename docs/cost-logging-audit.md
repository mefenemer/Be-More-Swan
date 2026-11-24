# Cost logging audit (2026-11-23)

**Why:** partner commission is now worked out after ACTUAL costs (docs/partner-actual-costs-plan.md §5, PR #827). The
nightly sweep adds up `ai_usage_log.cost_usd` for the workspaces each referred customer owns
(`customerCostUsd` in `src/utils/partner-costs-db.ts`). If a paid call writes no row, or writes one with no
`workspace_id`, the sweep can't see it. Only the 20% minimum then covers it, so a heavy user can cost Be More Swan money.

**How it was checked:** I listed every API key and outside host the code uses, found each provider's call sites, and
read whether each one writes to `ai_usage_log` (through `logAiUsage` / `logMessageUsage` / `logMediaCost` /
`logServiceCost` / `logRenderCost` / `logTranscriptionCost` in `src/utils/ai-usage.ts`, or the gateway's
`recordUsage`), and with which workspace. Every write has been awaited since d430869f (2026-11-12,
tests/usage-writes-awaited.test.ts), so writes that were started but never finished are no longer a gap.

## Providers

| Provider | Call sites | Logged | Workspace attributed | How cost is computed | Gap → fix |
|---|---|---|---|---|---|
| **Anthropic Claude, gateway** | `src/lib/ai-gateway.ts` (`gatewayGenerate`, `gatewayGenerateGrounded`), ~35 caller files | Yes, every call (`recordUsage`) | **Partly.** About 15 customer calls passed no `usage` | Tokens × `ai_model_pricing` row, else `LIST_PRICE_PER_1K` | **Fixed:** workspace now passed by Goals AI (4 calls), brand-colour pick (`brand-extract-fetch.ts`, both callers), stock-photo keywords (`pexels.ts`), rescheduling by instruction (`reschedule-post-chat`, `retry-failed-post`), the grounded compliance fact-check (`verify-compliance-warning-background`, which also attributes its web-search fees) and autonomous post drafts (`autonomous-media-suggestions`). |
| **Anthropic web search** | gateway `recordSearchFee` | Yes | Same `usage` as the call | $0.01 per search (`SERVICE_UNIT_PRICE_USD['anthropic-web-search']`) | Fixed along with the gateway rows above |
| **Anthropic Claude, direct SDK** | ~40 files (`messages.create`) | Yes (guarded by tests/ai-usage-coverage.test.ts) | **Partly.** `market-enumerability.ts`, `territory-split.ts`, `halt-tightening.ts` and `social-troubleshoot-chat.ts` logged no workspace | `logMessageUsage` → tokens × list price | **Fixed:** the Lead Generator passes `orgId` into `assessMarket` / `splitTerritories`, `proposeTightening` passes it to `modelTightening`, and social troubleshoot resolves the active workspace. |
| **Voyage** (embeddings) | `src/utils/kb-embeddings.ts` | Yes | Yes (callers pass `workspaceId`, tested) | $0.02 / M tokens | None |
| **fal**: FLUX images | `src/lib/fal-gateway.ts` `generateImages` | Yes (`logMediaCost`) | Yes (every caller passes `usage`) | Per megapixel, `MEDIA_LIST_PRICE_USD` | None |
| **fal**: video (Kling / Hailuo) | `process-media-job-background.ts`, `visual-briefs.ts`, `video-producer.ts` | Yes, on completion | Yes | Per clip length / per second | None |
| **fal**: AI presenter | `video-producer.ts` | Yes | Yes | $0.0562 / s | None |
| **fal**: background removal (BiRefNet v2) | `fal-gateway.ts` `removeImageBackground` | Yes | Yes | **Was unpriced** (a $0 row with a warning) | **Fixed:** priced explicitly. fal lists it at "$0 per compute second" (fal.ai/models/fal-ai/birefnet/v2, fal.ai/pricing, read 2026-11-23), so the row is a known $0. Raise it if fal starts charging. |
| **Stability** (Stable Audio) | `process-music-job-background.ts`, `video-music-asset.ts` | Yes, on success | Yes | $0.26 per track | None |
| **ElevenLabs** TTS | `voiceover-asset.ts` (voiceovers), `tour-narration.ts`, **`read-aloud.ts`** | **Partly.** Read Aloud logged nothing | Voiceover yes; tour = system | $0.15 / 1k chars (`tts.ts`) | **Fixed:** each fresh Read Aloud reading logs against the workspace (cached replays cost nothing). ElevenLabs is priced per character, OpenAI speech from the word count. |
| **ElevenLabs Scribe / OpenAI whisper** | `voiceover-asset.ts`, `own-voice.ts`, `footage-review.ts` | Yes | Yes | $0.20/h Scribe, $0.006/min whisper | None |
| **OpenAI** speech (gpt-4o-mini-tts) | `tts.ts` via `speakVoiceover` (voices without an ElevenLabs id) | Yes (through the callers above) | Yes | ~$0.015 / min | None |
| **OpenAI** moderation | `moderation.ts`, `content-assets.ts`, `swan-index/safety.ts` | n/a | n/a | Free endpoint | None |
| **Recall.ai** (Note Taker bot) | `src/utils/meeting-bot-recall.ts` (only caller), state in `meeting-bot-db.ts` | **No.** Tasks were charged to the customer, but Recall's cost to us was in no ledger | n/a | — | **Fixed:** when a bot reaches its first final state (`done`, `not_admitted`, `failed`, `removed`), or we withdraw it after it set off, two rows are written against its workspace (`logRecallBotCost`). `recall-bot-hour` ($0.50/h of recording) runs from the join attempt (the bot's `join_at`, when Recall starts joining) to leaving, so it **includes the waiting room**, a bot that was never admitted, and the empty-call wait our task charge leaves out. `recall-transcript-hour` ($0.15/h) covers only time in the call. Prices from recall.ai/pricing ("prorated to the second", read 2026-11-23). Env `RECALL_BOT_USD_PER_HOUR` / `RECALL_TRANSCRIPT_USD_PER_HOUR` override. Assumption: Recall bills waiting-room time too. If it doesn't, this overstates by cents, which is the safe direction. |
| **Resend** | `send-outbound-email.ts` (an assistant's email, per workspace); platform mail in `email.ts`, digests, admin, support | **No** | — | — | **Fixed for workspace-caused sends:** `send-outbound-email` logs one `resend-email` row ($0.0009, the Pro overage of $0.90 per 1,000, resend.com/pricing, read 2026-11-23; env `RESEND_COST_USD_PER_EMAIL`). Platform mail (sign-in, verification, notifications, digests) stays **unattributed**: it is the platform's own mail, covered by Resend's fixed monthly plan, and `sendEmail` carries no workspace. |
| **Serper** (search) | `discovery-search.ts` | Yes | Yes (tested) | $0.001 / search | None |
| **Hunter** (emails) | `discovery-enrich-provider.ts` | Yes | Yes (tested) | $0.0285 / credit | None |
| **DataForSEO** (Google Trends) | `search-trends.ts` | Yes | Live chat look-up: yes. Weekly refresh: **no, on purpose** | DataForSEO's own `cost` per task | Weekly refresh stays **unattributed**: one task serves every workspace that tracks the term (≈ $0.0027 a task). |
| **Remotion Lambda** (renders) | `video-render.ts`, `render-post-video-background.ts` | Yes, finished renders | Yes | Remotion's `costs.accruedSoFar` | Residual: a render that FAILS after spending compute isn't logged (`if (progress.done)`). Small; left as a follow-up. |
| **Gemini / OpenAI** (AI Visibility) | `ai-visibility-fetch-background.ts` | Claude part via gateway; Gemini/OpenAI not | **No, on purpose** | — | Admin-only monthly check of Be More Swan itself. System cost, not a customer's. |
| **Headless Chrome** (site import) | `site-js-render.ts` (`@sparticuz/chromium` inside our own function) | n/a | n/a | No outside vendor, no per-call charge (Netlify compute) | None. No Apify or browserless is used. |
| **Stripe** card fees | Stripe balance transactions | Separately (`card_fee_pence`) | Per payment | Stripe's actual fee | Not in `ai_usage_log` by design (PR #827) |
| Pexels, Companies House, Reed, social / CRM / Google APIs, R2 | many | n/a | n/a | Free APIs, or fixed / storage fees not per call | None |

## Left unattributed on purpose (system work)

These rows keep `workspace_id = NULL`. They count in the platform total on the COGS page, not against any customer:

- The public site taster (`site-audit.ts`, before any workspace exists) and the UI translation cache (`translate.ts`, shared by everyone).
- The product tour narration (`tour-narration.ts`, spoken once into a shared cache).
- Admin tools: Partner Ops and Systems chats, admin catalogue copy, admin test generation, AI Visibility, provider health probes.
- The weekly Google Trends refresh (shared per term).
- Platform email through Resend (see the table).

tests/cost-logging-audit.test.ts names each of these, so adding a new unattributed call fails the test until it is either given a workspace or listed there with a reason.

## Guards

- `tests/cost-logging-audit.test.ts` (new) checks:
  - Recall is logged once per bot, on its first final state or when withdrawn after setting off, with the workspace: recording from the join attempt (waiting room included), transcript only in the call, both to the second.
  - Read Aloud logs its cost, and every speech or transcription caller logs.
  - Nothing calls ElevenLabs or OpenAI audio outside `tts.ts`, and nothing calls Recall outside `meeting-bot-recall.ts`.
  - BiRefNet is priced.
  - Resend outbound email is logged.
  - **Every gateway call passes a workspace, or is on the system list.**
  - No direct log call is missing a workspace unless it is system work.
- `tests/ai-usage-coverage.test.ts` (existing) checks that every direct SDK call logs, that every Claude and media model has a price, and covers fal, Stability, Serper, Hunter and Voyage.
- `tests/usage-writes-awaited.test.ts` (existing) checks that every write is awaited.

## Not changed

- How existing rows are priced. All list prices stay as they were; only the missing rows were added.
- Old rows. Spend before this change is under-counted for the gaps above. The sweep only checks months that have
  ended, so a customer's November will still miss Recall and the unattributed Claude calls made before deploy.

Also: Recall is now listed in the System Map registry (`system-registry.ts`, category AI), and `system-map.ts` maps
`recall-*` and `resend-*` rows to their systems, so the new rows show up in the per-system totals.
