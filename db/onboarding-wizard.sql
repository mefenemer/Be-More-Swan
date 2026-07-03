-- Frictionless Onboarding Wizard — backing columns for the 9-step slide-over guide.
--
--   user_profiles.working_hours        jsonb  — Step 3 (User Profile). Shape:
--                                               { preset?: 'standard_9_5'|'always_on'|'custom',
--                                                 start?: 'HH:MM', end?: 'HH:MM',
--                                                 days?: number[] /* 0=Sun..6=Sat */ }
--                                               Presence of a non-null value = step done.
--   organisations.compliance_accepted_at ts   — Step 5 (Compliance). Stamped when the
--                                               user accepts the AI-usage / data-processing
--                                               agreement toggle (US6 AC2). NULL = not yet.
--
-- APPLY THIS FILE (Neon SQL editor / psql as the owner) — do NOT use `drizzle-kit push`.
-- RLS policies live in raw SQL (db/rls/) and are invisible to Drizzle, so a push can propose
-- DISABLE ROW LEVEL SECURITY / DROP POLICY. These plain ALTERs cannot touch RLS; new columns
-- inherit the table's grants + row policies automatically. Idempotent — safe to re-run.

ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS working_hours          jsonb;
ALTER TABLE organisations ADD COLUMN IF NOT EXISTS compliance_accepted_at timestamp;
