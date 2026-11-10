-- db/z-video-producer-studio-copy.sql — the Video Producer's catalogue description, for the studio
-- (docs/video-producer-studio-plan.md Phase 6). Mirrors seed/data/master_assistants.json.
--
-- APPLY AT RELEASE, to BOTH environments, with the code (it describes the studio, which posts nothing).
-- Idempotent. Release also re-runs, in the same sitting:
--   db/z-video-producer-plan-feature.sql            (pricing row: "saved to My Content")
--   db/z-assistant-showcases.sql                    (the public assistant page)
--   db/help-articles-2026-12zzzzzzzzzzzzzz-video-producer.sql   (the three help articles)
-- Dollar-quoted, so it pastes into a web SQL editor as it is.

UPDATE master_assistants
   SET description = $$Makes short videos from what you want to say, or from your own footage — it writes the script from your business details, picks the footage and pictures, adds a voiceover and captions, and cuts out pauses and ums. You check the storyboard before anything is made. The finished video is saved to My Content, to download or use with any of your assistants.$$
 WHERE role_key = 'video_producer'
RETURNING role_key, left(description, 80);
