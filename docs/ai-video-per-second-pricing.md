# AI Video Priced by the Second — Switch-on Plan

Decided by the owner 2026-11-01: an AI clip costs **4 tasks a second** of clip, replacing the flat
20. The models bill by the second, and Kling 3.0 Pro (the bake-off winner,
[ai-video-bakeoff-2026-11-01.md](./ai-video-bakeoff-2026-11-01.md)) costs about $0.112 a second, so
a 10 s clip at a flat 20 tasks lost money.

| Clip | Today (flat) | By the second |
|---|---|---|
| 3 s | 20 | 12 |
| 5 s | 20 | 20 |
| 6 s (Brand Designer) | 20 | 24 |
| 10 s | 20 | 40 |

## Why it isn't on in production yet

Terms clause 5.2 states the weights ("an AI-generated video as 20 tasks") and says they change "on
at least 30 days' notice under clause 20". Clause 20.2 says notice is by email, in-app, or both.
So production keeps the flat 20 until the notice has run.

## What's built (staging, 2026-11-01)

- `aiVideoTasks(seconds)` in `src/config/task-weights.ts` is the one rule. It's flat
  `TASK_WEIGHTS.ai_video` unless Netlify env **`AI_VIDEO_PRICED_BY_SECOND=on`**.
- It charges the **billed** length (`billedSecondsFor` in `src/lib/fal-gateway.ts`: Kling 2.5 makes
  5 or 10 s, Kling 3 any 3–15 s).
- Every AI clip goes through it:
  - Video Producer: the estimate on **Make the video**, the hold and the charge.
  - Brand Designer: the round's hold and charge.
  - Post editor **AI video** and autopilot media jobs: hold and charge.
  - In-flight capacity reads (`work-metering.ts`, `task-balance.ts`).
- Generated copy follows the setting (`aiVideoPriceText()`): the Video Producer chat prompt, the
  plan snapshot every chat reads, and the Brand Designer's source cost line.
- Pinned by `tests/task-weights.test.ts`.
- Staging has `AI_VIDEO_PRICED_BY_SECOND=on` (branch `staging` only).

## Switching it on in production

1. **Send the notice** (clause 20.2) at least 30 days before the effective date. Use email and the
   in-app notice, the same route as the 17 October task-allowance notice
   (`notification-templates-catalog.ts`). Suggested wording:

   > From [date], an AI video clip counts as 4 tasks for each second of video, instead of 20 tasks
   > for any clip. A 5-second clip stays at 20 tasks, a 10-second clip becomes 40, and shorter
   > clips cost less. Your assistants always show what a video will use before you make it.
   > Nothing else changes.

2. **On the effective date,** in one release:
   - Terms 5.2: "an AI-generated video as 4 tasks for each second of video". Bump the terms version
     and update the "What changed" modal (see the terms-version rule: the login prompt).
   - `pricing.html`: lines 246, 404 and 536 ("An AI video — 4 tasks a second").
   - `faq.html`: lines 174 and 369.
   - `billing.html` 69, `checkout.html` 135, `assistant-detail.html` 1459, `my-content.js` 157,
     `explainers.js` 408, `workspace.html` 387 and 22010 (the 402 message).
   - `db/assistant-showcases.json` (three answers), then `node scripts/build-showcase-sql.mjs`.
   - Plan feature descriptions: a dated `db/z-pricing-copy-<date>.sql` updating
     `monthly_task_limit`, `ai_video_generation` and `video_producer`, plus `db/seed-plan-features.ts`.
   - Help articles: a dated `db/help-articles-<date>-video-per-second.sql`, `REPLACE`-ing the AI video
     line in "What Counts as a Task", the Brand Designer cost line, and the "Each AI clip" row in
     "Making a Video: From Storyboard to Finished Post". Never the retired seed.
   - `TASK_WEIGHTS.ai_video` stays 20. It's the price of a clip whose length is unknown.
3. **Set `AI_VIDEO_PRICED_BY_SECOND=on` for production,** then redeploy. Env changes only reach
   functions on a new deploy.
4. **Then** set `FAL_I2V_MODEL=fal-ai/kling-video/v3/pro/image-to-video` for production (or with
   step 3), and redeploy.

Until step 3, switching production to Kling 3 alone keeps the flat 20. A 10 s Kling 3 clip
($1.12 + frame) would then cost more than the 20 tasks bring in.
