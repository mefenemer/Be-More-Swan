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
| **Remotion Lambda** (renders) | `video-render.ts`, `render-post-video-background.ts` | **Partly.** Finished and fatally failed renders yes (both report `done`). Renders we gave up on, after a poll timeout or an error mid-render, logged nothing while Lambda kept spending | Yes | Remotion's `costs.accruedSoFar` | **Fixed:** both loops go through `RenderCostMeter` (`src/utils/render-cost.ts`). It logs each render once: when it reports done, or, when we give up on it, with what Remotion says it has spent (or the last figure we saw if Remotion can't be reached). An abandoned render may still be running, so that figure can understate the final bill. A worker killed outright is logged by the stuck sweeps (see "Killed render workers"). |
| **Gemini / OpenAI** (AI Visibility) | `ai-visibility-fetch-background.ts` | Claude part via gateway; Gemini/OpenAI not | **No, on purpose** | — | Admin-only monthly check of Be More Swan itself. System cost, not a customer's. |
| **Headless Chrome** (site import) | `site-js-render.ts` (`@sparticuz/chromium` inside our own function) | n/a | n/a | No outside vendor, no per-call charge (Netlify compute) | None. No Apify or browserless is used. |
| **Stripe** card fees | Stripe balance transactions | Separately (`card_fee_pence`) | Per payment | Stripe's actual fee | Not in `ai_usage_log` by design (PR #827) |
| Pexels, Companies House, Reed, social / CRM / Google APIs, R2 | many | n/a | n/a | Free APIs, or fixed / storage fees not per call | None |

## Edge cases (fixed 2026-11-24, after the #831 reviews)

- **Recall bot we can't follow and couldn't take back.** Recall accepted it, but its id never reached the row (`not_saved_bot_still_sent`), or the row closed while Recall was answering. Its events will never match a row, so it's logged at the most it can run (`untrackedRecallHours`): 10 min waiting room + its length limit in the call + 2 min alone, with the transcript for the length limit. This overstates, which is the safe error. If the take-back answers `'left'` instead, the bot ran for seconds and nothing is logged (fractions of a cent).
- **Recall bot withdrawn while the row still says `scheduled`** (a missed webhook). Recall refuses the delete once a bot has started joining, so we ask it to leave (`'left'`). `withdrawMeetingBots` now logs every bot that had to be asked to leave, timed from `join_at`, because our final `cancelled` hides its later events. A bot Recall answers `'deleted'` for never ran and costs nothing, so neither `removeMeetingBot` nor withdraw logs it. When Cancel gets `'left'`, the bot's own final event logs it.
- **Capped:** any Recall row is at most what a bot can run (waiting room + length limit + alone wait). A row left open long after its bot ended can't log days of time when it is finally withdrawn.
- **Recall withdrawal that fails** (`withdrawMeetingBots`). Already covered: the row stays open with its Recall id, so the bot's own final event logs it. The one exception is a deleted workspace. Its rows go with it, but there's no customer left to bill, and the partner sweep checks an orphaned referral at the minimum with no costs.
- **"Logged once" is tested by running the rule:** `recallCostDue` (meeting-bot.ts) runs against every real status path.

## Killed render workers (fixed 2026-11-24)

A worker killed outright (a deploy, a platform fault) can't log its render. Its job row is left `rendering`, with the render's id on it:

- **Video Producer:** the existing stuck sweep (`sweepStuckProjects`, run when the Videos tab or chat reads projects) now logs the cost of any render id left on a project it marks `render_failed`.
- **Post renders:** previously nothing swept a killed job, so its post stayed gated at `rendering` for good. Each worker run now first calls `sweepKilledPostRenders`. It fails jobs still `rendering` after 20 minutes, and their post's render gate, the same as a failed render, then logs the render's cost.
- **Once:** only the UPDATE that moves the row out of `rendering` logs. Every render's row carries its own session id (`<label>:<renderId>`), so a render the worker logged before dying isn't logged again. The cost is Remotion's own figure, read from the finished render's progress. A render Remotion can't report on logs nothing.
- **Timing:** the sweep runs when the next render starts (any workspace) or the projects are next read. So the row can be dated later than the render, and can land in the next month's partner check.
- **Only recent ones:** both sweeps log only renders cut off in the last 3 days. The post sweep only touches those jobs at all. Older stuck rows are a backlog from before this existed, so their costs would land in the wrong month, and failing old posts now would surprise their owners.
- **Not covered:** crosspost siblings that wait on a killed job's render stay held at `pending`, the same as with any failed render today. Also, `ai_usage_log.session_id` has no index, so the "already logged?" check reads the table. That's acceptable only because it runs just for a killed render; add an index if killed renders become common.

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
  - Remotion: every render is logged once, whether it finishes, fails, is retried or is abandoned (unit tests on the meter, plus checks that both render loops use it).
- `tests/ai-usage-coverage.test.ts` (existing) checks that every direct SDK call logs, that every Claude and media model has a price, and covers fal, Stability, Serper, Hunter and Voyage.
- `tests/usage-writes-awaited.test.ts` (existing) checks that every write is awaited.

## Not changed

- How existing rows are priced. All list prices stay as they were; only the missing rows were added.
- Old rows. Spend before this change is under-counted for the gaps above. The sweep only checks months that have
  ended, so a customer's November will still miss Recall and the unattributed Claude calls made before deploy.

Also: Recall is now listed in the System Map registry (`system-registry.ts`, category AI), and `system-map.ts` maps
`recall-*` and `resend-*` rows to their systems, so the new rows show up in the per-system totals.
