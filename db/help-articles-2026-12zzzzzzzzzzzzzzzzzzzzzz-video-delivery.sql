-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzz-video-delivery.sql — Help Centre: where a requested video goes (10 November 2026)
--
-- Owner, 2026-11-10: the Video Producer is a studio and its own page and article say nothing about
-- what happens to other assistants' posts. A video asked for from a post ("Make a video version") or
-- by a campaign ("Commission a video") is still delivered back to it (src/utils/video-post-media.ts),
-- so that delivery is now described where the request is made: the Social Media Assistant's and the
-- Campaign Assistant's articles. The Video Producer's article keeps one line each and points here.
--
-- APPEND, guarded by the new heading: a no-op when already applied, so the file is safe to re-run.
-- Bodies dollar-quoted (apostrophes NOT doubled), no semicolons inside bodies. Apply to BOTH databases,
-- with the release that carries the 2026-11-10 Video Producer changes, together with a re-run of
-- db/help-articles-2026-12zzzzzzzzzzzzzz-video-producer.sql.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Video versions of your posts

When you have a Video Producer, open a post in your **Review Queue** and press **Make a video version**. Your Video Producer plans a storyboard saying what the post says, and you check it on its **Videos** tab before anything is made. You can also ask your Social Media Assistant in chat to do it.

- When the video is finished, it goes onto that post, keeping its words, and waits for your approval in the **Review Queue**.
- If the post can't take a video as it is (it's already scheduled, its platform doesn't take video, or you've put text on its picture), the post stays as it is and a new draft with the video and the post's words waits beside it.
- Each post gets one video. Pressing it again opens the one already started.
- The finished video is also in **My Content**.

The button only appears when your Video Producer is active and your plan includes video.
$$,
       updated_at = now()
 WHERE title = 'The Social Media Assistant'
   AND content_md NOT LIKE '%## Video versions of your posts%';

UPDATE help_articles
   SET content_md = content_md || $$

## A video for your campaign

When you have a Video Producer, a campaign plan can include **Commission a video**: one short video on the campaign's message, using 2 of the campaign's tasks. Approving the plan asks your Video Producer for a storyboard, which you check on its **Videos** tab before anything is made.

- When the video is finished, the campaign marks that work done and starts anything that was waiting for it.
- The video goes onto one of the campaign's posts that is still waiting for your approval, in place of the picture that post found for itself. A picture you chose yourself is never replaced.
- The finished video is also in **My Content**.
$$,
       updated_at = now()
 WHERE title IN ('The Marketing Campaign Orchestrator', 'The Marketing Campaign Assistant')
   AND content_md NOT LIKE '%## A video for your campaign%';

COMMIT;

-- Check (expect each title once, has_section = t; the Orchestrator/Assistant pair is whichever exists):
-- SELECT title, is_published, content_md LIKE '%## Video versions of your posts%' OR content_md LIKE '%## A video for your campaign%' AS has_section
--   FROM help_articles WHERE title IN ('The Social Media Assistant', 'The Marketing Campaign Orchestrator', 'The Marketing Campaign Assistant');
