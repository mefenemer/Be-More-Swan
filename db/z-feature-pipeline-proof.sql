-- db/z-feature-pipeline-proof.sql — Feature requests get the Fix pipeline's checks (owner, 2026-11-13).
--
-- Before a feature reaches production the request now shows the same evidence a fix does
-- (src/utils/feature-proof.ts, docs/claude-inbox-and-features.md):
--   proof test   a test of the new behaviour that failed on the old code and passes with the feature (jsonb)
--   SQL          the feature's database change, whether it is additive, its hash, and where it ran
--   staging      when it merged to staging, CI on the merge commit, when the staging deploy contained it
--   production   the prod SQL run, when it merged into main, and when the prod deploy contained it
-- The Approve button refuses a merge until the SQL is on that PR's database, and a request only moves to
-- Released once the production deploy actually contains it (the 30-minute live check).
--
-- Not declared in db/schema.ts (Drizzle names every declared column in an INSERT), read and written raw
-- behind featureProofColumnsReady(). Additive and idempotent: run on BOTH staging and prod.

BEGIN;

ALTER TABLE feature_requests
    ADD COLUMN IF NOT EXISTS dev_repro JSONB,
    ADD COLUMN IF NOT EXISTS dev_sql TEXT,
    ADD COLUMN IF NOT EXISTS dev_sql_safety TEXT,
    ADD COLUMN IF NOT EXISTS dev_sql_hash TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_result TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_hash TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_ran_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_merged_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_staging_ci_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_ci_url TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_live_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_prod_sql_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_prod_sql_result TEXT,
    ADD COLUMN IF NOT EXISTS dev_prod_sql_ran_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_prod_merged_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS live_at TIMESTAMP;

COMMIT;

-- Check (expect 17):
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_name = 'feature_requests'
--    AND column_name IN ('dev_repro','dev_sql','dev_sql_safety','dev_sql_hash','dev_staging_sql_status',
--        'dev_staging_sql_result','dev_staging_sql_hash','dev_staging_sql_ran_at','dev_merged_at',
--        'dev_staging_ci_status','dev_staging_ci_url','dev_staging_live_at','dev_prod_sql_status',
--        'dev_prod_sql_result','dev_prod_sql_ran_at','dev_prod_merged_at','live_at');
