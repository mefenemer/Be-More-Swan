-- db/newsletter-resend.sql
-- Resend to the people who did not open an issue.
-- Requires db/newsletter.sql, db/newsletter-dispatch.sql and db/newsletter-engagement.sql.
--
-- ── The cheapest reach increase in email, and the easiest one to turn into spam ─────────────────
-- Sending the same issue again, with a different subject line, to only the people who never opened
-- it typically adds a third again to total opens for no new writing. It is also, done carelessly,
-- a second unrequested email to your entire list. Three things separate one from the other, and
-- all three are enforced rather than advised:
--
--   1. ⚠️ THE ORIGINAL MUST HAVE BEEN ABLE TO REPORT OPENS. `newsletter_issues.engagement_tracked`
--      is false for anything sent from a tenant's own Gmail/Outlook mailbox — no pixel, no link
--      rewriting. On those issues "did not open" is not a fact about the reader, it is the absence
--      of instrumentation, and a resend would go to EVERYONE who received it.
--   2. ONE RESEND PER ISSUE, EVER — the unique index below. Not a policy that a retried request or
--      a double-clicked button can get around.
--   3. A resend cannot itself be resent. The index makes a chain impossible to record; the API
--      refuses it with a sentence rather than a constraint violation.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE: db/schema.ts names this column, and two bare
-- `db.select()` reads on newsletter_issues name every column in the table.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'newsletter_sends'
                   AND column_name = 'opened_at') THEN
    -- Named as a missing MIGRATION rather than left to fail later as a missing column: without
    -- opened_at there is no such thing as "did not open", so this feature has nothing to stand on.
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-resend.sql requires db/newsletter-engagement.sql first — there is no opened_at to read.',
      HINT    = 'npm run db:migrate:apply -- --only newsletter-engagement   (then this file)',
      ERRCODE = 'undefined_column';
  END IF;
END $$;

ALTER TABLE newsletter_issues
  ADD COLUMN IF NOT EXISTS resend_of_issue_id INTEGER REFERENCES newsletter_issues(id) ON DELETE SET NULL;

-- ⚠️ ONE RESEND PER ISSUE. Without this a retry, a double-click or two admins in the same hour
-- send the same people the same email twice — which is the exact behaviour that gets a sending
-- domain reported. SET NULL on delete keeps the resend's own record intact if the original is
-- ever removed; the index then no longer holds it, which is correct, because the thing it was
-- protecting against no longer exists.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_issues_resend_of_uidx
  ON newsletter_issues (resend_of_issue_id)
  WHERE resend_of_issue_id IS NOT NULL;

-- The resend's own hot path: "who was sent this and never opened or clicked it". Partial, so it
-- indexes only the rows a resend can target rather than the whole ledger.
CREATE INDEX IF NOT EXISTS newsletter_sends_unopened_idx
  ON newsletter_sends (issue_id, contact_id)
  WHERE status = 'sent' AND opened_at IS NULL AND clicked_at IS NULL;

-- "Has this account EVER recorded an open?" — the check that catches tracking being switched on
-- while the provider webhook is not subscribed to open events, which makes every recipient of every
-- issue look like a non-opener. ⚠️ Org-scoped rather than issue-scoped on purpose: the existing
-- newsletter_sends_opened_idx is keyed by issue_id, so the account-wide question would scan every
-- opened row of every tenant to answer "none" — which is exactly the case that asks it.
CREATE INDEX IF NOT EXISTS newsletter_sends_org_opened_idx
  ON newsletter_sends (organisation_id)
  WHERE opened_at IS NOT NULL;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'newsletter_issues' AND column_name = 'resend_of_issue_id';
