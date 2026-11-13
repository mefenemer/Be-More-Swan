-- db/z-issue-remove-backlog.sql — the Backlog status goes; On Hold is shown as "Waiting on Others".
--
-- Owner, 2026-11-13: Claude works Reported tickets from a session (docs/fix-pipeline-interactive.md), so a
-- separate "accepted, not started" status adds nothing. Any issue still at Backlog goes back to Reported
-- (Claude's queue). On Hold keeps its value 'on_hold'; only its label and wording change (in code).
-- Changes a CHECK constraint: run on BOTH staging and prod. Safe before or after the code deploys.

BEGIN;

UPDATE issue_reports SET status = 'reported', updated_at = now() WHERE status = 'backlog';

ALTER TABLE issue_reports DROP CONSTRAINT IF EXISTS issue_reports_status_check;
ALTER TABLE issue_reports
  ADD CONSTRAINT issue_reports_status_check
  CHECK (status = ANY (ARRAY['reported','investigating','on_hold','fix_in_progress','merge',
                             'fixed_ready_to_test','more_info_required','closed','roadmap']));

COMMIT;

-- Check (expect 0, then the rule without 'backlog'):
-- SELECT count(*) FROM issue_reports WHERE status = 'backlog';
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'issue_reports_status_check';
