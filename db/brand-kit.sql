-- Visual brand identity on organisations, for rendering branded text cards.
--
-- The platform already stores what a brand SOUNDS like (organisations.business_description /
-- target_audience, ai_assistants.onboarding_context.brand_voice). Nothing stored what it LOOKS
-- like, so the brand-card renderer (src/lib/brand-card.ts) had no colours to paint with. Shape:
--   { "primaryColor": "#ff007f", "textColor": "#1f1e1b", "backgroundColor": "#fdfcf9",
--     "wordmark": "BE MORE SWAN", "logoUrl": null, "website": "bemoreswan.com",
--     "source": "manual" }
-- source is 'default' | 'manual' | 'website' — 'website' marks colours extracted from the org's
-- own site rather than entered by a human. Every field is optional; src/utils/brand-kit.ts fills
-- gaps from DEFAULT_BRAND_KIT (neutral monochrome), so an org with NULL here still renders a
-- publishable card and never borrows another brand's palette. Idempotent.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on RLS-enabled tables. This plain
-- ALTER TABLE cannot touch RLS; the new column inherits the table's grants + row
-- policies automatically. Canonical column definition lives in db/schema.ts.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS brand_kit jsonb;

-- Seed Be More Swan's own palette (input.css: neon pink accent, deep espresso ink, warm cream
-- canvas). Scoped by name and guarded by IS NULL so re-running never overwrites edited values,
-- and no other tenant is touched.
UPDATE organisations
SET brand_kit = jsonb_build_object(
      'primaryColor',    '#ff007f',
      'textColor',       '#1f1e1b',
      'backgroundColor', '#fdfcf9',
      'wordmark',        'BE MORE SWAN',
      'logoUrl',         NULL,
      'website',         'bemoreswan.com',
      'source',          'manual')
WHERE brand_kit IS NULL
  AND name ILIKE '%be more swan%';
