-- db/z-video-producer-own-voice-copy.sql — the Video Producer's catalogue description says the voiceover
-- can be your own (2026-11-10/11, docs/video-producer-manual-controls-plan.md). Mirrors
-- seed/data/master_assistants.json and db/seed-catalog.ts.
--
-- APPLY to BOTH environments with the release, together with a re-run of db/z-assistant-showcases.sql
-- (the public assistant page). Idempotent. Dollar-quoted, so it pastes into a web SQL editor as it is.

UPDATE master_assistants
   SET description = $$Makes short videos from what you want to say, or from your own footage — it writes the script from your business details, picks the footage and pictures, adds a voiceover (an AI voice or your own) and captions, and cuts out pauses and ums. You check the storyboard before anything is made. The finished video is saved to My Content, to download or use with any of your assistants.$$
 WHERE role_key = 'video_producer'
RETURNING role_key, left(description, 80);
