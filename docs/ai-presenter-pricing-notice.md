# Notice: AI Presenter, Free Until 19 December, Then 2 Tasks a Second

Updated 2026-11-18. The owner chose "Free now, charge 19 Dec" (decision D-A3 in
[video-producer-screen-walkthrough-plan.md](./video-producer-screen-walkthrough-plan.md)): the AI
presenter goes live for everyone straight away at no cost, and the price of **2 tasks for each
second the presenter is on screen** starts on **Saturday 19 December 2026**, after the 30 days'
notice that terms clause 5.2 requires (clause 20.2: by email, in-app, or both).

## What is done (prod, 2026-11-18)

| Step | State |
|---|---|
| Presenter cost 0 tasks from today | ✅ `task_cost_changes` id 2, status `baseline`, 18 Nov, `ai_presenter` 2 → 0 (a cost nobody had been charged, so it needs no notice) |
| 2 tasks a second from 19 December | ✅ change id 3, 19 Dec, `ai_presenter` 0 → 2, **announced by the owner 2026-11-18 07:04 UTC** (10 users, 0 waiting) |
| Flag `ai_presenter` | ✅ ON for every workspace (`enabled = true`, rollout 100) |
| Live check | ✅ the public task costs read `ai_presenter: 0` |

The screen-recordings part (A3) reaches prod when release #727 is merged. Until then, presenter
videos work without screens.

## Announcing it (done 2026-11-18)

The owner sent the test, then pressed **Announce** in Admin → Money → Task costs on 18 November 2026 at 07:04 UTC. All 10 users on a live plan got the in-app notice, and the audit log records emails going to customers. There's no email log table, so emails weren't checked one by one. Change 3 starts by itself on 19 December.

### What customers will receive

The built-in `task_cost_change` notice, filled in from change 3:

- **Subject:** Task costs change on 19 December 2026: please review
- **What changes:** the cost line from change 3 (AI presenter, 0 → 2 tasks a second)
- **Why:** *The AI presenter, a made-up person who speaks your video's script to camera in any
  language, is free to use until 19 December 2026. From then it counts as 2 tasks for each second
  the presenter is on screen (15 seconds is 30 tasks), because the AI model that makes it charges
  us by the second. It is optional: videos without a presenter cost the same as today, and stock
  footage, your own videos and screen recordings still use no tasks.*
- The rest is the standard wording: your assistants show what something uses first, you're never
  charged extra, there's a review-and-accept button, and you can cancel from Billing.

### Optional: a "new feature" announcement

The notice above is about cost. If you also want to tell customers about the feature, here is a
short in-app message or email:

> **New: an AI presenter for your videos.** Your Video Producer can now put a made-up presenter in
> your videos, speaking your script to camera, in a round bubble over your screen or full screen.
> Pick from 12 presenters, men and women, and change the language whenever you like. It's free
> until 19 December 2026, then 2 tasks for each second the presenter is on screen. Every video with
> an AI presenter is labelled as made with AI.

## Terms of Service change: Version 2.4

Clause 5.2's figures are written in the Terms, not filled in automatically. Built as `CURRENT_TOS_VERSION = '2.4'`, so every signed-in user is asked to accept at login. The presenter's figures are plain text, not `data-task-cost` spans: the live cost is 0 until 19 December, so a span would read "no tasks". After 19 December a minor update may switch them to spans.

Quoted exactly as shipped in `terms_of_service.html` and `workspace.html` (PR #733).

**Header:** Version 2.4 · Last updated: 18 November 2026 (clause 5.2: an AI presenter counts by the second) · The change to clause 5.2 takes effect on 19 December 2026

**Clause 5 note, added after the Version 2.3 sentence:**
> Clause 5.2 changed again in Version 2.4, effective 19 December 2026: an AI presenter counts as 2 tasks for each second the presenter is on screen. Before that date it uses no tasks. We gave notice of this by email and in-app on 18 November 2026.

**Clause 5.2, inserted after "…before 3 December 2026, 20 tasks for any clip),":**
> an AI presenter (a made-up person who speaks your video's script to camera) as 2 tasks for each second the presenter is on screen, rounded up to the next whole second (a 15-second appearance is 30 tasks; before 19 December 2026, no tasks),

**"What changed in Terms v2.4 (from 19 December 2026)" modal:**
- An AI presenter, a made-up person who speaks your video's script to camera, counts as 2 tasks for each second they are on screen (clause 5.2). A 15-second appearance is 30 tasks. Until 19 December it uses no tasks.
- It's optional. Videos without a presenter cost the same as before, and your assistants always show what a video will use before you make it.
- Nothing else changes. Version 2.3's change still applies: an AI video clip counts as 4 tasks for each second of video from 3 December 2026.

## On 19 December

1. Check that Admin → Money → Task costs shows change 3 in force, and that the public costs read
   `ai_presenter: 2`.
2. Make one real presenter video on prod and check the charge matches the quote.
3. Start A5 (help articles and public copy), which can now name the price.

## To undo

- Hide the feature: `UPDATE feature_flags SET enabled = FALSE WHERE key = 'ai_presenter';`
- Stop the price after announcing: **Cancel** on the same admin screen, before 19 December. It
  tells everyone it's not going ahead.
