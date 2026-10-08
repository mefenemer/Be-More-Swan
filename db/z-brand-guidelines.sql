-- db/z-brand-guidelines.sql — picture guidelines for the workspace. Brand Designer plan, Phase 2 (§4.5).
-- Code: src/utils/brand-guidelines.ts. Drizzle mirror: db/schema.ts (organisations.brandGuidelines).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-brand-guidelines                              (staging)
--   npm run db:migrate:apply -- --only z-brand-guidelines --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ ORDER MATTERS MORE THAN USUAL. organisations is read with a bare db.select() in many places,
-- and drizzle names every column of the mirror in that SELECT — deploying the code first would break
-- every one of those reads until this column exists ([[schema-column-breaks-reads-until-applied]]).
--
-- Why a column and not fields inside brand_kit: website extraction replaces brand_kit WHOLESALE (two
-- writers), so a guideline a person typed would be wiped the next time the colours were re-read; and
-- every branded card copies the whole kit into its render_params. Shape: brand-guidelines.ts.
-- NULL = never set, which reads exactly like empty guidelines.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS brand_guidelines JSONB;
