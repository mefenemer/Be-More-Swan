-- db/z-issue-investigating.sql — new issue status 'investigating' ("Investigation In Progress").
--
-- Owner, 2026-11-13: Claude works Fix pipeline tickets from a session (docs/fix-pipeline-interactive.md).
-- Between Reported and Fix In Progress the ticket now says the cause is being looked for, which the
-- reporter sees on their Issues page. Same drop-then-add pattern as db/z-issue-hotfix-pr.sql.
-- Changes a CHECK constraint, so the pipeline won't run it by itself: run it on BOTH staging and prod.
-- Until it runs, scripts/fix-tickets.ts `start` falls back to Fix In Progress and says why.

ALTER TABLE issue_reports DROP CONSTRAINT IF EXISTS issue_reports_status_check;
ALTER TABLE issue_reports
  ADD CONSTRAINT issue_reports_status_check
  CHECK (status = ANY (ARRAY['reported','investigating','backlog','on_hold','fix_in_progress','merge',
                             'fixed_ready_to_test','more_info_required','closed','roadmap']));

-- Check (expect 1 row containing 'investigating'):
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'issue_reports_status_check';
