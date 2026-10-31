-- db/_go-live-video-producer-plan-feature.sql — "Video Producer" on the pricing page (docs/video-producer-plan.md §7.3).
--
-- ⚠️ APPLY AT GO-LIVE ONLY — the same day the Video Producer's status goes Live. The pricing.html comparison
-- table renders plan_features straight away, so applying this while the role is Hidden advertises an
-- assistant nobody can hire. At go-live also add the same row to db/seed-plan-features.ts (after
-- ai_video_generation: saver DASH, buster CHECK, employee CHECK) so a re-seed keeps it.
--
-- One row in "AI Media Generation", straight after AI Video Generation, ticked on the plans that can make
-- videos — the same gate the Videos tab applies (src/utils/ai-credits.ts VIDEO_TIERS: buster, employee).
-- The wording is only what the code does: a storyboard you approve first, voiceover and captions, AI scenes
-- in tasks (src/config/task-weights.ts: ai_video 20, ai_image 1, ai_voiceover 1).
--
-- The leading underscore keeps the migrate runner from applying it in a routine pass (it skips `_` files).
-- Paste it by hand at go-live, then rename it to db/z-video-producer-plan-feature.sql in the same commit as
-- the seed row, so the ledger and the file agree.
--
-- Idempotent. Paste into the Neon SQL Editor, staging then prod. Expect 1 row from the first RETURNING,
-- and the three plans from the second.

BEGIN;

-- Make room straight after AI Video Generation — only the first time, so a re-run shifts nothing.
UPDATE plan_features SET display_order = display_order + 1
 WHERE display_order > (SELECT display_order FROM plan_features WHERE key = 'ai_video_generation')
   AND NOT EXISTS (SELECT 1 FROM plan_features WHERE key = 'video_producer');

INSERT INTO plan_features (key, label, description, category, value_type, storage_target,
                           enterprise_value, display_order, is_enabled)
VALUES (
  'video_producer',
  'Video Producer',
  'Short vertical videos with a voiceover and captions, from a storyboard you approve. AI clips use 20 tasks each',
  'AI Media Generation', 'boolean', 'feature', 'true',
  (SELECT COALESCE(MAX(display_order), 0) + 1 FROM plan_features WHERE key = 'ai_video_generation'),
  true
)
ON CONFLICT (key) DO UPDATE SET
  label            = EXCLUDED.label,
  description      = EXCLUDED.description,
  category         = EXCLUDED.category,
  value_type       = EXCLUDED.value_type,
  storage_target   = EXCLUDED.storage_target,
  enterprise_value = EXCLUDED.enterprise_value,
  is_enabled       = true,
  updated_at       = now()
RETURNING key, label, display_order;

-- Ticked where videos can be made; a dash on the entry plan.
UPDATE master_plans
   SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object('video_producer', tier_key IN ('buster', 'employee'))
 WHERE tier_key IN ('saver', 'buster', 'employee')
RETURNING tier_key, features ->> 'video_producer' AS video_producer;

COMMIT;
