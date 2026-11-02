-- db/z-brand-designer-flyers.sql — printable flyers in the Brand Designer.
-- Plan: docs/brand-designer-flyers-plan.md §5. Code: src/lib/flyer.ts, src/config/flyer-vocab.ts,
-- src/utils/visual-briefs.ts. Drizzle mirror: db/schema.ts (visualBriefs, visualBriefOptions).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-brand-designer-flyers                              (staging)
--   npm run db:migrate:apply -- --only z-brand-designer-flyers --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER: visual_briefs is read with a bare db.select() — code before DDL breaks the Briefs tab.
--
-- ── purpose 'flyer' ─────────────────────────────────────────────────────────
-- A printed flyer. Its photo is still fetched at 4:5 (aspect_ratio keeps its four social shapes,
-- which stock search and AI generation understand); the PAPER is its own column.
--
-- ── paper_size ──────────────────────────────────────────────────────────────
-- 'A5' | 'A4' | 'A6' | 'DL', portrait. NULL on every brief that is not a flyer.
--
-- ── flyer_content ───────────────────────────────────────────────────────────
-- The flyer's words, as the user last saved them (normaliseFlyerContent): headline, subheading,
-- points, offer, call to action, date line, contact details, QR link. A round draws exactly these.
--
-- ── option source 'flyer_layout' ────────────────────────────────────────────
-- One drawn page per layout (photo top / full photo / words only). Its render_params holds what is
-- needed to draw the PDF on approve: layout, paper, words, kit, and the photo it used.
--
-- ── The CHECKs, DROP-then-ADD ───────────────────────────────────────────────
-- Inside one transaction, naming constraints this codebase owns, widened to a SUPERSET — so a re-run
-- drops and re-adds the same rule, and no existing row can fail it.

BEGIN;

ALTER TABLE visual_briefs DROP CONSTRAINT IF EXISTS visual_briefs_purpose_check;
ALTER TABLE visual_briefs ADD CONSTRAINT visual_briefs_purpose_check
  CHECK (purpose IN ('social_post', 'blog_header', 'ad', 'email_header', 'story', 'other', 'flyer'));

ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS paper_size TEXT;
ALTER TABLE visual_briefs DROP CONSTRAINT IF EXISTS visual_briefs_paper_size_check;
ALTER TABLE visual_briefs ADD CONSTRAINT visual_briefs_paper_size_check
  CHECK (paper_size IS NULL OR paper_size IN ('A5', 'A4', 'A6', 'DL'));

ALTER TABLE visual_briefs ADD COLUMN IF NOT EXISTS flyer_content JSONB;

ALTER TABLE visual_brief_options DROP CONSTRAINT IF EXISTS visual_brief_options_source_check;
ALTER TABLE visual_brief_options ADD CONSTRAINT visual_brief_options_source_check
  CHECK (source IN ('stock', 'ai_image', 'brand_card', 'stock_video', 'ai_video', 'own', 'flyer_layout'));

COMMIT;
