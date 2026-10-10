-- db/z-music-capability.sql — AI music gets its own capability switch, `ai_music_generation`.
-- Code: netlify/functions/generate-ai-music.ts, src/utils/assistant-capabilities.ts.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-music-capability                              (staging)
--   npm run db:migrate:apply -- --only z-music-capability --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER: until this runs, the new code finds no `ai_music_generation` grant anywhere, so AI music
-- answers "None of your assistants can generate AI music." for every workspace.
--
-- Before this, generate-ai-music checked `ai_image_generation`, so switching AI images off (say, for
-- a fal outage) silently took music down too, although music runs on Stability, not fal.
--
-- ── The grants ──────────────────────────────────────────────────────────────
-- Copied from today's AI image grants, so no workspace gains or loses music on deploy. From here the
-- two are independent: change either per role on Admin ▸ Assistants ▸ (role) ▸ Capabilities.
-- ⚠️ ORG-WIDE, like every assistant_features grant (assistant-features.sql).
-- ⚠️ The INSERT can only ADD grants (ON CONFLICT DO NOTHING) — a re-run never undoes an admin's
-- later change, and narrowing means switching rows off in the admin page, not editing this file.
--
-- Named z-music-… so the runner applies it AFTER z-brand-designer.sql, whose image grant it copies.

BEGIN;

INSERT INTO assistant_feature_defs (key, label, description, category, display_order, is_enabled)
VALUES ('ai_music_generation', 'AI Music Generation', 'Generate royalty-free background music with AI for posts.', 'Media', 2, true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT af.master_assistant_id, 'ai_music_generation', true
  FROM assistant_features af
 WHERE af.feature_key = 'ai_image_generation'
   AND af.enabled = true
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;

COMMIT;
