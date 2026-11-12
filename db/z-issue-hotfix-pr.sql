-- db/z-issue-hotfix-pr.sql — "Open hotfix PR" replaces "Push to prod" (src/utils/issue-hotfix.ts).
--
-- "Push to prod" promoted ALL of staging to main through the developer's laptop runner. The
-- issue panel now starts .github/workflows/hotfix-pr.yml, which opens a PR into main carrying only
-- that issue's fix; a person merges it on GitHub. Two new dev_prod_status values follow it:
--
--   hotfix_requested → the workflow was started from the admin portal
--   hotfix_open      → the hotfix PR is open, waiting for review and merge (URL in dev_prod_result)
--   promoted         → (existing) merged into main; the live check tells the reporter after deploy
--   failed           → (existing) the workflow failed or the PR was closed; see dev_prod_result
--
-- 'queued' / 'promoting' stay allowed for rows the old runner flow left behind; nothing sets them now.
--
-- Same drop-then-add pattern as db/issue-reports.sql. Idempotent. Run on BOTH staging and prod
-- BEFORE deploying the code that uses it: until then "Open hotfix PR" fails on the constraint and
-- says so, and nothing else changes.

ALTER TABLE issue_reports DROP CONSTRAINT IF EXISTS issue_reports_dev_prod_status_check;
ALTER TABLE issue_reports
  ADD CONSTRAINT issue_reports_dev_prod_status_check
  CHECK (dev_prod_status IS NULL
         OR dev_prod_status IN ('queued', 'promoting', 'promoted', 'failed', 'hotfix_requested', 'hotfix_open'));
