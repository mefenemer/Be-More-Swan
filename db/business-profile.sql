-- Business profile columns on organisations.
-- Assistant-facing business context captured on the Business Information page
-- (renamed from "Brand Assets"). Legal/tax/registered-address details remain in
-- billing_information. Idempotent — safe to run more than once.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies here live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can
-- propose DISABLE ROW LEVEL SECURITY / DROP POLICY on the RLS-enabled ai_assistants table.
-- This plain ALTER TABLE cannot touch RLS; new columns inherit the table's grants + row
-- policies automatically. Canonical column definitions still live in db/schema.ts.

ALTER TABLE organisations ADD COLUMN IF NOT EXISTS industry             text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS business_description  text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS website_url          text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS social_links         text;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS target_audience      text;
