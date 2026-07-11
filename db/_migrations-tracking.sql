-- Migration tracking ledger for the hand-applied db/*.sql files.
-- Created/owned by scripts/db-migrate.mjs (the tool ensures this table exists before
-- doing anything else). One row per db/*.sql file that has been applied to THIS database.
--
-- Why this exists: the 70+ db/*.sql files are idempotent and applied MANUALLY (Neon SQL
-- editor / psql as owner — never drizzle-kit push, which would drop the raw-SQL RLS policies).
-- Before this ledger, "did we run that one on prod?" was answered from memory. This table is
-- the single source of truth for which migrations each environment has actually seen.
--
-- checksum = sha256 of the file contents at apply time. If the file is later edited, the tool
-- reports it as DRIFTED so you can decide whether to re-apply. Apply MANUALLY the first time,
-- or let `node scripts/db-migrate.mjs status` create it (it runs this DDL automatically).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename      text        PRIMARY KEY,          -- e.g. 'goals.sql' (basename, relative to db/)
  checksum      text        NOT NULL,             -- sha256 hex of file contents when applied
  applied_at    timestamptz NOT NULL DEFAULT now(),
  applied_by    text,                             -- OS user / CI actor that ran the apply
  execution_ms  integer,                          -- wall-clock time the file took to run
  baselined     boolean     NOT NULL DEFAULT false -- true = recorded as already-present, NOT executed by the tool
);

COMMENT ON TABLE schema_migrations IS
  'Ledger of hand-applied db/*.sql migrations. Managed by scripts/db-migrate.mjs.';
