-- db/z-issue-severity.sql — how bad an issue is (src/utils/issue-severity.ts), 2026-11-12.
--
-- The reporter picks it in Contact us ("How bad is it?"); an admin can change it on the issue. A
-- critical or high issue from a paying workspace emails the business inbox straight away.
-- Automatic incidents and older rows are 'normal'.
--
-- Not declared in db/schema.ts on purpose (same reason as z-platform-incidents.sql): read and
-- written raw behind severityColumnReady(). Idempotent. Run on BOTH staging and prod.

ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT 'normal';

ALTER TABLE issue_reports DROP CONSTRAINT IF EXISTS issue_reports_severity_check;
ALTER TABLE issue_reports
  ADD CONSTRAINT issue_reports_severity_check
  CHECK (severity IN ('critical', 'high', 'normal', 'low'));
