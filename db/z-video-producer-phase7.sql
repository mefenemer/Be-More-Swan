-- db/z-video-producer-phase7.sql — the Video Producer, Phase 7 (autopilot, hand-offs, campaigns).
-- Plan: docs/video-producer-plan.md §5.9, §7 Phase 7. Code: src/utils/video-autopilot.ts,
-- netlify/functions/video-autopilot.ts, src/utils/campaign-video-order.ts, video-projects.ts
-- (action 'from_post'). Drizzle mirror: db/schema.ts (videoProjects, campaign_orders check).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-video-producer-phase7                              (staging)
--   npm run db:migrate:apply -- --only z-video-producer-phase7 --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER: video_projects is read with a bare db.select() (video-projects.ts, the chat snapshot) and
-- the mirror names the four new columns — code before DDL breaks the Videos tab.
--
-- ── What a video came from ──────────────────────────────────────────────────
--   origin            'user' (the Videos tab or a chat card the user clicked), 'autopilot' (the weekly
--                     run — a storyboard only; making it is still the user's click), 'handoff' ("Make a
--                     video version" on a post), 'campaign' (a Campaign Assistant order).
--   source_post_id    the post a hand-off was made from. ONE live video per post per assistant
--                     (partial unique index): a second click opens the first rather than planning twice.
--   campaign_id / campaign_order_id   as visual_briefs: SET NULL both ways — a video the user approved
--                     outlives the campaign that asked for it.
--
-- ── One constraint widening, DROP-then-ADD ──────────────────────────────────
-- In ONE transaction (all or nothing); the DROP names a constraint this codebase owns, and the new
-- list is a SUPERSET of the old one, so no existing row can fail the re-added check.

BEGIN;

ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'user';
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS source_post_id INTEGER REFERENCES scheduled_posts(id) ON DELETE SET NULL;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE video_projects ADD COLUMN IF NOT EXISTS campaign_order_id INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL;

ALTER TABLE video_projects DROP CONSTRAINT IF EXISTS video_projects_origin_check;
ALTER TABLE video_projects ADD CONSTRAINT video_projects_origin_check
  CHECK (origin IN ('user', 'autopilot', 'handoff', 'campaign'));

CREATE UNIQUE INDEX IF NOT EXISTS video_projects_source_post_uniq
  ON video_projects (ai_assistant_id, source_post_id)
  WHERE source_post_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX IF NOT EXISTS video_projects_campaign_order_idx
  ON video_projects (campaign_order_id) WHERE campaign_order_id IS NOT NULL;

ALTER TABLE campaign_orders DROP CONSTRAINT IF EXISTS campaign_orders_artefact_check;
ALTER TABLE campaign_orders ADD CONSTRAINT campaign_orders_artefact_check
  CHECK (artefact_kind IS NULL OR artefact_kind IN (
    'scheduled_post','blog_post','discovery_campaign','assistant_record',
    'newsletter_sequence','newsletter_issue','visual_brief','video_project'));

-- "Works with", guarded like z-campaign-visuals.sql so a re-run or an admin's own edit is left alone.
UPDATE master_assistants SET works_with = '["campaign_orchestrator", "social_media_manager"]'::jsonb
 WHERE role_key = 'video_producer' AND (works_with IS NULL OR works_with = '["standalone"]'::jsonb OR works_with = '[]'::jsonb);
UPDATE master_assistants SET works_with = COALESCE(works_with, '[]'::jsonb) || '["video_producer"]'::jsonb
 WHERE role_key = 'campaign_orchestrator' AND NOT (COALESCE(works_with, '[]'::jsonb) ? 'video_producer');

COMMIT;
