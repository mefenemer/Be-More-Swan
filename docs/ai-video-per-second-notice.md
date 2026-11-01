# Notice: AI Video Priced by the Second

Draft, 2026-11-01. The 30 days' notice that terms clause 5.2 requires before the AI video weight
changes (clause 20.2: by email, in-app, or both). The switch-on steps are in
[ai-video-per-second-pricing.md](./ai-video-per-second-pricing.md).

## Effective date

**Thursday 3 December 2026.** That needs the notice sent by Monday 2 November. If it goes later, the
date moves to at least 31 days after sending, and every date below changes with it. If you'd
rather start on an allowance reset, use **1 January 2027** (send by 1 December).

## Who receives it

Every workspace with an active plan. Only Busywork Buster and Digital Employee make AI video
(`VIDEO_TIERS`), but sending to everyone is simpler and still true: the email says so. It covers the
Brand Designer and the post editor's AI video too, not only the Video Producer.

## Email

**Subject:** From 3 December, AI video clips count by their length

> Hello {{user.first_name | "there"}},
>
> From **3 December 2026**, an AI video clip will count as **4 tasks for each second** of video,
> instead of 20 tasks for any clip.
>
> | Clip length | Today | From 3 December |
> |---|---|---|
> | 3 seconds | 20 tasks | 12 tasks |
> | 5 seconds | 20 tasks | 20 tasks |
> | 6 seconds | 20 tasks | 24 tasks |
> | 10 seconds | 20 tasks | 40 tasks |
>
> **Why we're changing it.** The AI video models we use charge by the second. From 3 December your
> Video Producer also moves to a newer model that makes noticeably more lifelike clips. Counting by
> length means short clips use fewer tasks, and longer clips reflect what they cost to make.
>
> **What stays the same.**
> - Posts, articles, emails and lead searches are still 1 task each. An AI image is still 1, and
>   an AI music track 20.
> - Stock footage, stock photos, your own pictures and branded cards still use no tasks.
> - Planning a video is free, and your assistants show what a video will use before you make it.
> - If your tasks run out, work pauses. You're never charged extra.
>
> If your plan doesn't include AI video, nothing changes for you.
>
> We've updated clause 5.2 of our Terms of Service to match. The new version takes effect on
> 3 December. If you'd rather not continue under it, you can cancel at any time from Billing.
>
> Any questions, just reply to this email.
>
> The Be More Swan team

## In-app notification

Template `ai_video_per_second_notice` in `src/utils/notification-templates-catalog.ts`. Nothing
sends it automatically.

- **Title:** From 3 December, AI video clips count by their length
- **Message:** From 3 December 2026, an AI video clip counts as 4 tasks for each second of video
  instead of 20 for any clip: a 5-second clip stays 20, a 10-second clip becomes 40, and shorter
  clips use fewer. Stock footage, your own pictures and branded cards still use none, and your
  assistants always show what a video will use first. If your plan doesn't include AI video,
  nothing changes. The updated terms take effect the same day.

## Before sending, check

- [ ] The date in all three places (subject, body, in-app) and in `ai-video-per-second-pricing.md`.
- [ ] You're committed to moving production to Kling 3.0 Pro on that date. The email says so. If
      not, remove the "newer model" sentence.
- [ ] How it goes out. There is no send-to-everyone tool: `admin-send-notification.ts` messages one
      user at a time. Build a one-off broadcast (in-app plus email), or send the email from the
      mailing tool you use for customers.
- [ ] The terms changes (clause 5.2 wording, version bump, "What changed" modal) are ready to
      publish on the effective date.
