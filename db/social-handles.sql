-- Social media handles on organisations.
-- Per-platform handles/URLs captured on the Business Information page, keyed by
-- lowercase platform slug, e.g.
--   { "instagram": "@yourbrand", "facebook": "https://facebook.com/yourpage",
--     "linkedin": "https://linkedin.com/company/yourbrand", "x": "@yourbrand" }
-- These are the single source of truth for handles and gate which Connections can be
-- enabled later (only platforms with a handle here can be connected). Idempotent.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on RLS-enabled tables. This plain
-- ALTER TABLE cannot touch RLS; the new column inherits the table's grants + row
-- policies automatically. Canonical column definition lives in db/schema.ts.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS social_handles jsonb;
