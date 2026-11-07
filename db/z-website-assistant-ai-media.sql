-- db/z-website-assistant-ai-media.sql — lets the Website Assistant make AI pictures and videos
-- (owner request 2026-11-06: placeholder media on a first draft).
--
-- AI media needs an active assistant whose type carries the flag (orgHasAssistantFeature), and the
-- Website Assistant had neither. Without this row, a workspace whose only assistant is the Website
-- Assistant sees AI-made greyed out, with the reason. Stock works either way. AI video also needs the
-- Busywork Buster or Digital Employee plan.
--
-- Idempotent. Run on staging, then prod with the release.

BEGIN;

INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT ma.id, f.key, true
  FROM master_assistants ma
 CROSS JOIN (VALUES ('ai_image_generation'), ('ai_video_generation')) AS f(key)
 WHERE ma.role_key = 'website_assistant'
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;

COMMIT;
