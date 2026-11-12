-- db/z-issue-fix-proof.sql — Fix pipeline: proof before production (docs/fix-pipeline-proof-plan.md).
--
-- Every AI fix now carries the evidence the owner reads before "Approve for production":
--   root cause   confirmed (its repro test failed before the fix and passes after) | guessed | not_found
--   repro        the repro test's before/after results (jsonb)
--   SQL          is it additive (the only kind the pipeline runs unattended), its hash, and where it ran
--   staging      CI on the merge commit, and when the staging deploy contained the fix
--   production   the prod SQL run and who approved, when
-- issue_report_messages gains an optional image (before/after screenshots from the repro run).
--
-- Deliberately NOT declared in db/schema.ts (same reason as db/z-platform-incidents.sql): Drizzle names
-- every declared column in an INSERT, so declaring them would break "Report an Issue" on a database
-- this file hasn't reached. The code reads and writes them raw, behind proofColumnsReady().
--
-- Additive and idempotent. Run on BOTH staging and prod. Until it runs, the checklist says
-- "run db/z-issue-fix-proof.sql" and the old flow carries on.

BEGIN;

ALTER TABLE issue_reports
    ADD COLUMN IF NOT EXISTS dev_root_cause_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_root_cause TEXT,
    ADD COLUMN IF NOT EXISTS dev_repro JSONB,
    ADD COLUMN IF NOT EXISTS dev_sql_safety TEXT,
    ADD COLUMN IF NOT EXISTS dev_sql_hash TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_result TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_hash TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_sql_ran_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_staging_ci_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_ci_url TEXT,
    ADD COLUMN IF NOT EXISTS dev_staging_live_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_prod_sql_status TEXT,
    ADD COLUMN IF NOT EXISTS dev_prod_sql_result TEXT,
    ADD COLUMN IF NOT EXISTS dev_prod_sql_ran_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_prod_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS dev_prod_approved_at TIMESTAMP,
    ADD COLUMN IF NOT EXISTS dev_proof_run_id BIGINT,
    ADD COLUMN IF NOT EXISTS dev_proof_images_at TIMESTAMP;

ALTER TABLE issue_report_messages
    ADD COLUMN IF NOT EXISTS image_data TEXT,
    ADD COLUMN IF NOT EXISTS image_mime TEXT;

COMMIT;

-- Check (expect 21):
-- SELECT count(*) FROM information_schema.columns
--  WHERE (table_name = 'issue_reports' AND (column_name LIKE 'dev_root_cause%' OR column_name IN ('dev_repro','dev_sql_safety','dev_sql_hash','dev_proof_run_id','dev_proof_images_at') OR column_name LIKE 'dev_staging_%' OR column_name LIKE 'dev_prod_sql_%' OR column_name LIKE 'dev_prod_approved_%'))
--     OR (table_name = 'issue_report_messages' AND column_name IN ('image_data','image_mime'));
