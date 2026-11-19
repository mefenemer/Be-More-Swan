# Long Voiceovers Count by Length

Written 2026-11-19. The owner agreed "1 task per 2,500 characters" for long voiceovers, which arrived
with Phase 4's 2-, 5- and 10-minute walkthroughs (scripts up to 15,000 characters).

## The rule

A voiceover counts as **`ai_voiceover`** (1 task) for its first 2,500 characters, **plus
`ai_voiceover_long` for each further started 2,500**. This is `voiceoverTasks()` in
`src/config/task-weights.ts`.

| Script | Today (`ai_voiceover_long` 0) | At 1 |
|---|---|---|
| A post's voiceover (≤1,200) or a short video | 1 | 1 |
| 2-minute walkthrough (~2,000–2,600) | 1 | 1–2 |
| 5-minute walkthrough (~5,000–6,500) | 1 | 2–3 |
| 10-minute walkthrough (~10,000–15,000) | 1 | 4–6 |

The quote and the charge count the same text: the cleaned script the build sends to the voice
(`voiceoverScript()`). Your own voice is never charged.

## What ships, and what doesn't change

- New cost key **`ai_voiceover_long`**, in the starting costs at **0**. **Nobody pays more** when
  this ships. SQL: `db/z-voiceover-long-cost.sql`, on both databases. It is safe to run twice.
- Admin → Money → Task costs lists it as "AI voiceover (each further 2,500 characters)".
- When the rate is above 0, the chat's video cost line mentions it.

## Turning it on (owner)

Raising it from 0 is a price rise, so it needs the **30 days' notice** in Terms 5.2. This is the
same path as the AI presenter's change 3:

1. Admin → Money → Task costs → new change. Set the date **at least 30 days after the day you
   announce**: announce 21 Nov, start 21 Dec or later. Move "AI voiceover (each further 2,500
   characters)" from 0 to 1.
2. Suggested reason: *A long video's voiceover, such as a 5- or 10-minute walkthrough, costs us more to
   make the longer the script is. The first 2,500 characters, about 3 minutes of speech, still count
   as 1 task. Each further 2,500 characters now counts as 1 more, so a 10-minute walkthrough's
   voiceover is about 6 tasks. Short videos and post voiceovers don't change.*
3. **Test**, then **Announce**.
4. On the start date, swap any typed help price for the token `{{tasks.ai_voiceover_long}}`. Today the
   help says "The voiceover | {{tasks.ai_voiceover}}", which stays true for short videos.

## Is 1 enough?

ElevenLabs lists speech at about $0.15 per 1,000 characters, so 2,500 characters cost about $0.38.
At the presenter's rate (2 tasks for $0.056), a task is worth about 3¢. So 1 task per 2,500 recovers
only a small part of a long voiceover's cost. It is still small next to the presenter itself, which is
about 1,200 tasks for 10 minutes. If you want it to cover cost, set the new value higher in step 1;
nothing in code needs changing.
