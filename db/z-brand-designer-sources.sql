-- db/z-brand-designer-sources.sql — the Brand Designer's Phase 4 sources: stock video, AI video, and
-- "add your own" (an upload, a library picture, or a Canva design already imported into the library).
-- docs/brand-designer-plan.md §6 step 4. Code: src/utils/visual-briefs.ts, src/config/visual-brief-vocab.ts.
-- Drizzle mirror: db/schema.ts (visualBriefs, visualBriefOptions).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-brand-designer-sources                              (staging)
--   npm run db:migrate:apply -- --only z-brand-designer-sources --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER: visual_briefs is read with a bare db.select() — code before DDL breaks the Briefs tab.
--
-- ── credit_hold_video ───────────────────────────────────────────────────────
-- The part of credit_hold that is for AI VIDEO. A round may hold for images AND a video, and the two
-- succeed or fail separately: four images arriving while the clip fails must charge the image credit
-- and refund the five video credits. One number could not say which part to give back.
--
-- ── waiting_on ──────────────────────────────────────────────────────────────
-- "Someone on my team is making it": who, in the user's words. Nothing is sent to them — their file
-- arrives through "Add your own", like any upload.
--
-- ── The source CHECK, DROP-then-ADD ─────────────────────────────────────────
-- Inside one transaction, naming a constraint this codebase owns, widened to a SUPERSET.
--
-- ── The AI video grant ──────────────────────────────────────────────────────
-- ⚠️ ORG-WIDE, like every assistant_features grant (assistant-features.sql): a workspace whose only
-- video-capable hire is the Brand Designer now has AI video in My Content too. The plan-tier lock
-- (Saver and Employee only, tierCanGenerateVideo) still applies on every surface, so this does not
-- hand video to a plan that does not include it.

BEGIN;

ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS credit_hold_video INTEGER NOT NULL DEFAULT 0;
ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS waiting_on TEXT;

ALTER TABLE visual_brief_options DROP CONSTRAINT IF EXISTS visual_brief_options_source_check;
ALTER TABLE visual_brief_options ADD CONSTRAINT visual_brief_options_source_check
  CHECK (source IN ('stock', 'ai_image', 'brand_card', 'stock_video', 'ai_video', 'own'));

INSERT INTO assistant_features (master_assistant_id, feature_key, enabled)
SELECT ma.id, 'ai_video_generation', true
  FROM master_assistants ma
 WHERE ma.role_key = 'brand_designer'
ON CONFLICT (master_assistant_id, feature_key) DO NOTHING;

COMMIT;
