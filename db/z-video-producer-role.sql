-- db/z-video-producer-role.sql — the Video Producer role (roleKey `video_producer`), Phase 6.
-- Plan: docs/video-producer-plan.md §5.1, §7 Phase 6. Table: db/z-video-producer.sql (Phase 5, applied).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that shows the role deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-producer-role                              (staging)
--   npm run db:migrate:apply -- --only z-video-producer-role --url-var DATABASE_URL_PROD  (prod)
--
-- ── The catalogue row ───────────────────────────────────────────────────────
-- Inserted HIDDEN (is_active=false, coming_soon=false), like the Website Assistant: nothing about it
-- has run against live fal/OpenAI yet. Status changes only on Admin ▸ Configuration ▸ Assistants
-- (admin-assistants.ts — one status, one place). ON CONFLICT DO NOTHING: once the row exists every
-- field is the admin's.
--
-- ── The capability grants ───────────────────────────────────────────────────
-- Everything it makes is gated on an active assistant TYPE holding the feature:
--   ai_video_generation — the role itself (video-projects.ts) and its AI clips
--   ai_image_generation — AI-image scenes (generate-ai-image / generateAndPersistImage)
--   ai_music_generation — the voiceover gate (generate-voiceover.ts)
-- A grant on a hidden type does nothing: orgHasAssistantFeature counts ACTIVE hires only.

BEGIN;

INSERT INTO master_assistants
    (role_key, name, description, category, icon_key, icon_color, tagline, key_features, integrations, works_with, coming_soon, is_active)
VALUES (
    'video_producer',
    'Video Producer',
    'Turns what you want to say into a short vertical video for Reels, Shorts and Facebook — it writes the script from your business details, picks the footage and pictures, adds a voiceover and captions, and lines it up with your posts. You check the storyboard before anything is made, and approve the finished video before it goes out.',
    'Marketing & Sales',
    'megaphone',
    'orange',
    'Say what the video is about. Approve the storyboard. Done.',
    '["Storyboard Before Anything Is Made","Voiceover and Captions Included","Nothing Posts Until You Approve It"]'::jsonb,
    '[]'::jsonb,
    '["standalone"]'::jsonb,
    false,
    false
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT ma.id, f.key, true
  FROM master_assistants ma
 CROSS JOIN (VALUES ('ai_video_generation'), ('ai_image_generation'), ('ai_music_generation')) AS f(key)
 WHERE ma.role_key = 'video_producer'
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;

COMMIT;
