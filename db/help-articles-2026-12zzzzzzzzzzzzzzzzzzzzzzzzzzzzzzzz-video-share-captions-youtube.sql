-- db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-share-captions-youtube.sql — Help Centre: captions, YouTube, guest review, editing the words and the teleprompter (11 November 2026)
--
-- The steps after the Vimeo / YouTube Studio comparison:
--   · caption files to download, translations at caption_translation (1 task) a language (caption-translate.ts)
--   · on YouTube: thumbnail, caption tracks (once reconnected with caption access) and results (youtube-video.ts)
--   · guest review of a video with comments on moments (video-review-links.ts)
--   · "Edit the words" on own footage (footage.ts cutWords) and the recorder's teleprompter
-- Appended to "Making a Video", plus one line in "Getting Someone's Thoughts on a Post".
--
-- APPEND, each guarded by its new heading or line: a no-op when already applied, safe to re-run.
-- Bodies dollar-quoted (apostrophes NOT doubled), titles single-quoted (doubled). No semicolons in bodies.
-- Apply to BOTH databases with the release that carries it (after db/z-review-link-video.sql). No schema change.

BEGIN;

UPDATE help_articles
   SET content_md = content_md || $$

## Caption files and translations

A finished video with a voiceover, or with your own spoken footage, has **Caption files** beside the player. **English (as spoken)** downloads free as SRT or VTT, for YouTube, Vimeo, your website or an editor.

To add another language, choose it and press **Translate**. Each language uses {{tasks.caption_translation}}, and the button shows it. The translation keeps every line's timing, so it matches the video. Remove one with the cross beside it. The captions burned into the video itself stay in the language spoken.

## On YouTube

When a post with one of your videos goes to YouTube, it also gets a thumbnail: the post's own picture, or the video's first branded card or photo. YouTube only allows custom thumbnails on a channel that has verified its phone number, so on other channels YouTube picks a frame. Once YouTube is reconnected with caption access, your caption files are added to the video as caption tracks, in every language you've made.

The **On YouTube** box beside the player shows views, likes and comments, checked every few hours (press **Check again** for the latest). Once YouTube is reconnected with analytics access, it also shows how long people watch on average, a line of how many are still watching across the video, and the moment most viewers leave, with the chapter it's in. Leave a note on that moment, or ask your Video Producer how to fix it.

## Share a video for review

Press **Share for review** beside a finished video to get a private link, or to email one. The person you send it to needs no account. They can watch it, leave comments on any moment, and approve it or ask for changes, for 30 days. Nothing they do changes the video.

Their comments appear under **Guest review** with the moment each one is about. Click a time to jump there. **Add to my notes** turns a comment into your own note on that moment, so **Make a new version from my notes** acts on it. **Turn off** stops a link working. You can also ask your Video Producer in chat to share a video.

## Edit the words

On a scene made from your own footage in its own sound, press **Edit the words** to see what was said in that part of your video. Click a word to cut it, and click it again to keep it, like editing a transcript. Press **Save**, and the words are cut when you make the video. It's free. You can also ask in chat, for example "take out 'basically' in scene 2".

## Teleprompter

When you record a video in your browser, open **Teleprompter** and type or paste what you'll say. It scrolls over the camera picture while you record, near the lens, at the speed you choose. It isn't part of the video.
$$,
       updated_at = now()
 WHERE title = 'Making a Video: From Storyboard to Finished Post'
   AND content_md NOT LIKE '%## Share a video for review%';

UPDATE help_articles
   SET content_md = content_md || $$

**Videos too.** A finished video from your Video Producer can be shared the same way, with **Share for review** beside it on the Videos tab. The person can comment on any moment of the video as well as approve it or ask for changes.
$$,
       updated_at = now()
 WHERE title = 'Getting Someone''s Thoughts on a Post'
   AND content_md NOT LIKE '%**Videos too.**%';

COMMIT;

-- Check (expect two rows, has_section = t):
-- SELECT title, (content_md LIKE '%## Share a video for review%' OR content_md LIKE '%**Videos too.**%') AS has_section
--   FROM help_articles WHERE title IN ('Making a Video: From Storyboard to Finished Post', 'Getting Someone''s Thoughts on a Post');
