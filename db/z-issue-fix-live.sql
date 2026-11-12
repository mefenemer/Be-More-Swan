-- db/z-issue-fix-live.sql — Issues: tell the reporter only when the fix is LIVE, then auto-close.
--
-- Before this, "Fixed & Ready to Test" (and its email) went out the moment a fix PR merged to the
-- STAGING branch. A customer on bemoreswan.com was asked to re-test something production did not
-- have yet. Now src/utils/issue-fix-live.ts checks, on a schedule, whether the fix's merge commit
-- is inside the commit this deploy was built from, and only then moves the issue on and tells the
-- reporter. An issue nobody replies to closes itself 7 days after that.
--
--   fixed_at     when the issue last became 'fixed_ready_to_test' (live check, or an admin by hand).
--                The 7-day auto-close counts from here.
--   live_at      when the live check found the fix in this environment's deployed commit.
--   live_pr_url  the PR that check confirmed — so a reopened issue is not re-marked live by its OLD
--                fix; only a new PR (dev_pr_url changes) is checked again.
--
-- Not declared in db/schema.ts on purpose (same reason as z-platform-incidents.sql): Drizzle names
-- every declared column in an INSERT, so declaring them would break "Report an Issue" on a database
-- this file has not reached. They are read and written raw, behind fixLiveColumnsReady().
--
-- Idempotent. Run on BOTH staging and prod.

ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS fixed_at    timestamptz;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS live_at     timestamptz;
ALTER TABLE issue_reports ADD COLUMN IF NOT EXISTS live_pr_url text;

CREATE INDEX IF NOT EXISTS issue_reports_fixed_at_idx ON issue_reports (status, fixed_at);

-- Issues already waiting at "Fixed & Ready to Test" start their 7 days from today, not from
-- whenever they were set: closing a month-old backlog in one run would send a burst of emails.
UPDATE issue_reports SET fixed_at = now()
 WHERE status = 'fixed_ready_to_test' AND fixed_at IS NULL;
