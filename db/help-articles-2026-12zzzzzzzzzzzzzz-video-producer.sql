-- db/help-articles-2026-12zzzzzzzzzzzzzz-video-producer.sql — Help Centre: the Video Producer (2026-10-31).
--
-- Sorts after db/help-articles-2026-12zzzzzzzzzzzzzz-mentor-sees-discussions.sql. Three articles
-- (docs/video-producer-plan.md §7.3, go-live copy):
--   Meet Your Video Producer                         set-up, what it makes, what it can't do, which plans
--   Making a Video: From Storyboard to Finished Post  the Videos tab, the storyboard, the cost, the Review Queue
--   Weekly Videos, Video Versions and Campaign Videos  autopilot, "Make a video version", commission_video
--
-- ⚠️ INSERTED UNPUBLISHED (is_published = FALSE). The Video Producer role is Hidden until go-live, and
-- Ask Your Team answers from PUBLISHED articles only (src/utils/help-knowledge.ts). Publishing now would
-- put copy ahead of the product. Publish them when the role's status goes Live, with the statement at
-- the foot of this file. A re-run never changes is_published, so it can't unpublish them after that.
--
-- Written from the code, not the plan:
--   New video form, buttons, captions copy — src/components/assistant-videos.js, workspace.html
--   15 / 30 / 60 s, 3–8 scenes, at most 3 AI clips, no words in AI pictures, own product photos only —
--     src/lib/storyboard.ts VIDEO_LENGTHS, MIN_SCENES, MAX_SCENES, MAX_AI_CLIPS, storyboardSystemPrompt
--   tasks: AI clip 20, AI picture 1, voiceover 1 — src/config/task-weights.ts, video-producer.ts buildTasks
--   part-way stops keep made scenes, 20-minute stop — video-producer.ts buildProject, STUCK_AFTER_MS
--   one post per platform, Review Queue, nothing posts unapproved — video-producer.ts buildProject
--   set-up questions — src/public/assistant-onboarding-schemas.js video_producer
--   autopilot 1–3 a week, spacing, waits while 2 wait, topics — src/utils/video-autopilot.ts
--   "Make a video version", one per post, platform rule — src/utils/video-handoff.ts, workspace.html
--   Commission a video, 2 tasks, delivered on approval — src/config/campaign-vocab.ts, campaign-video-order.ts
--   plans — src/utils/ai-credits.ts VIDEO_TIERS (Busywork Buster), video-projects.ts gate
--
-- Same rules as the other help files: bodies dollar-quoted, titles single-quoted with '' for
-- apostrophes, NO semicolons inside bodies (tests/video-producer-go-live.test.ts). Apply staging first:
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzzzzzzz-video-producer --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Your Assistants', 70, 'Meet Your Video Producer', $$
# Meet Your Video Producer

Your Video Producer makes short vertical videos for **Instagram Reels**, **YouTube Shorts** and **Facebook Reels**. Tell it what a video should say. It writes the script from your business details and **Products & Services**, plans the scenes, adds a voiceover and captions, and puts the finished video in your **Review Queue**.

You check the storyboard before anything is made, and you approve the finished video before it goes out. Nothing posts on its own.

## Setting it up

When you hire it, it asks:

- **Which voice should read your voiceovers?** Six voices, from Warm and friendly to Deep and confident.
- **How long should your videos usually be?** 15, 30 or 60 seconds.
- **What should viewers do at the end?** Optional. Used as the call to action unless you give a different one on a video.
- **Should it plan videos for you each week?** No, or one, two or three a week. See Weekly Videos, Video Versions and Campaign Videos.
- **Where should scenes come from by default?** Stock first with AI where stock won't fit, stock and your own pictures only, or lean on AI.

Every one of these can be changed on any video, and later from its **Assistant Profile**. You can also ask it in chat to change one.

## What a video is made of

Each video has 3 to 8 scenes. A scene can be stock footage, a stock photo, one of your own pictures, a branded card in your colours with your logo, an AI picture or an AI clip.

- **Your products are shown with your own pictures.** It never uses AI to picture your product. Upload product photos to **My Content** so it has them to use.
- **AI pictures and clips have no words in them.** Words go on screen as text over the scene, or on a branded card.
- **Still pictures move.** A slow push-in, pull-out or pan, so a photo doesn't sit still.
- **Captions** show the words as they're spoken, with the word being said picked out.

## What it can't do yet

- It doesn't watch footage you give it or pick the best moments from it.
- It makes videos up to 60 seconds. It doesn't make long YouTube videos.
- It doesn't post to TikTok.

## Which plans include it

Making videos is on plans that include AI video, the Busywork Buster plan. See **Pricing** for what each plan includes.
$$, FALSE),

('Your Assistants', 71, 'Making a Video: From Storyboard to Finished Post', $$
# Making a Video: From Storyboard to Finished Post

Everything happens on your Video Producer's **Videos** tab. You can start the same way in chat: tell it what the video should say and press **Plan this video** on the card it shows.

## 1. Ask for a video

Press **New video** and fill in:

- **What should it say?** A sentence or two, in your own words.
- **Length**, **Call to action**, **Voice** and **Pictures from**. These start from your set-up answers.
- **Post it as**: Instagram Reel, YouTube Short, Facebook Reel, or more than one.

Press **Plan this video**. Planning is free.

## 2. Check the storyboard

In about a minute the storyboard appears: each scene with its voiceover line, any words on screen, and where its picture or footage comes from. If it changed anything to keep to the rules, such as the length or the number of AI clips, a note under the title lists what it adjusted.

- **Change** on a scene lets you rewrite its line or words on screen, or change where its picture comes from.
- **Plan it again** writes a new storyboard. Say what should be different and it follows your notes. This is free too.
- **Cancel** drops the video.

## 3. Make the video

**Make the video** shows what it will use before you press it. Planning never uses anything. Making the video uses tasks from your monthly allowance only for:

| What | Tasks |
|---|---|
| Each AI clip (at most 3 in a video) | 20 |
| Each AI picture | 1 |
| The voiceover | 1 |
| Stock footage, stock photos, your own pictures, branded cards | none |

Making takes a few minutes and you can leave the page. If it stops part-way, the scenes already made are kept and you aren't charged for the rest. Press **Make the video** again to finish it. If something takes longer than 20 minutes, it is stopped and what wasn't made isn't charged.

## 4. Approve it

The finished video lands in your **Review Queue**, one post for each platform you chose, like any other post. Open it to watch it, change the caption or edit it further in the post editor, then approve it. The **Show captions** switch on the voiceover turns the captions off if you don't want them. Nothing goes out until you approve it.

Your Video Producer's **Results** tab counts **Videos Published**.
$$, FALSE),

('Your Assistants', 72, 'Weekly Videos, Video Versions and Campaign Videos', $$
# Weekly Videos, Video Versions and Campaign Videos

Besides the videos you ask for, a video can start in three other ways. Each one arrives on your Video Producer's **Videos** tab as a storyboard for you to check, marked with where it came from. None of them makes a video or uses any tasks until you press **Make the video**.

## Weekly videos (autopilot)

Answer **Should it plan videos for you each week?** with one, two or three a week, in set-up or on its **Assistant Profile**. You can also ask it in chat.

- It plans a storyboard about one of your **Products & Services**, the one featured least recently first. With none listed, it plans a useful tip from your business description. With neither, it plans nothing.
- One a week waits a week between storyboards, two a week waits three days, three a week waits two days.
- It adds no more while two of its storyboards are still waiting for you.
- These are marked **Planned by autopilot**.

## A video version of a post

Open any post in your **Review Queue** and press **Make a video version**. Your Video Producer plans a storyboard saying what the post says. You can also ask your Social Media Assistant in chat to hand a post over.

- The post itself stays as it is.
- The video goes to the post's own platform when that platform takes vertical video (Instagram, YouTube or Facebook). Otherwise it goes to Instagram.
- Each post gets one video. Pressing it again opens the one already started.
- These are marked **From one of your posts**, and the finished video shows **Requested by** the assistant whose post it was.

The button only appears when your Video Producer is active and your plan includes video.

## A video for a campaign

Your Campaign Assistant can include **Commission a video** in a campaign plan: one short video on the campaign's message, using 2 of the campaign's tasks. Approving the plan starts the storyboard. It never makes the video.

- The storyboard is marked **For a campaign**.
- When you approve the finished video in the Review Queue, the campaign marks that work done and starts anything that was waiting for it.
- The finished video shows **Requested by** your Campaign Assistant.
$$, FALSE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  updated_at = now();

COMMIT;

-- Check (expect 3 rows, is_published = f until go-live):
-- SELECT title, is_published, length(content_md) FROM help_articles WHERE title IN ('Meet Your Video Producer', 'Making a Video: From Storyboard to Finished Post', 'Weekly Videos, Video Versions and Campaign Videos') ORDER BY sort_order;
--
-- At go-live (Video Producer status Live), publish them:
-- UPDATE help_articles SET is_published = TRUE, updated_at = now() WHERE title IN ('Meet Your Video Producer', 'Making a Video: From Storyboard to Finished Post', 'Weekly Videos, Video Versions and Campaign Videos') RETURNING title, is_published;
