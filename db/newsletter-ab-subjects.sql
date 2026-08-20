-- db/newsletter-ab-subjects.sql
-- Two subject lines, a sample, and the winner to everyone else.
-- Requires db/newsletter.sql, db/newsletter-dispatch.sql and db/newsletter-engagement.sql.
--
-- ── The shape, and why it needs no new schedule ─────────────────────────────────────────────────
-- A sample of the list gets subject A or subject B. After a wait, whichever was opened by more
-- PEOPLE is sent to everyone who was held back. The decision runs inside sendDueIssues — the sweep
-- that already ticks every few minutes and already holds the issue in 'sending' — rather than in a
-- cron of its own. ⚠️ That is deliberate: this codebase has had two nightly sweeps that never ran
-- once, and an A/B test whose decider never fires is an issue that is never sent to 80% of a list.
-- If sending works, deciding works.
--
-- ── Why 'held' is a send status and not an absence of rows ──────────────────────────────────────
-- The remainder are materialised up front, as newsletter_sends rows with status 'held'. They could
-- have been created later instead — but then "who is this issue going to" would have two answers
-- depending on when you asked, the recipient count would jump mid-send, and a list edited between
-- the sample and the remainder would change the audience underneath a test. Held rows freeze the
-- audience at the moment the issue was approved, which is what a tenant thinks approving means.
--
-- ⚠️ ONE VOCABULARY RE-CREATED. db/newsletter.sql adds newsletter_sends_status_check only IF NOT
-- EXISTS, so this widens it with DROP + ADD. Same shape as db/newsletter-preferences.sql; the
-- fresh-install note there applies here too.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'newsletter_sends'
                   AND column_name = 'opened_at') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-ab-subjects.sql requires db/newsletter-engagement.sql first — a winner is decided on opens.',
      HINT    = 'npm run db:migrate:apply -- --only newsletter-engagement   (then this file)',
      ERRCODE = 'undefined_column';
  END IF;
END $$;

-- The second subject line, and the state of the test.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS subject_b            TEXT;
-- 'off' | 'testing' (sample out, waiting) | 'decided'
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_state             TEXT NOT NULL DEFAULT 'off';
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_sample_percent    INTEGER NOT NULL DEFAULT 30;
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_decide_after_hours INTEGER NOT NULL DEFAULT 4;
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_sample_sent_at    TIMESTAMP;
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_winner            TEXT;
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_decided_at        TIMESTAMP;
-- ⚠️ WHY that winner, in the tenant's words. "A won" with no numbers is a claim they cannot check,
-- and the honest answer is often "too close to call" — which this column is what makes sayable.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS ab_note              TEXT;

-- Which subject THIS recipient was sent. NULL on a non-test issue and on the remainder until the
-- winner is released onto them — stamped rather than inferred, so the record of what somebody
-- received survives any later edit to the issue.
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS variant TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_issues_ab_state_check') THEN
    ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_ab_state_check
      CHECK (ab_state IN ('off','testing','decided'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_issues_ab_winner_check') THEN
    ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_ab_winner_check
      CHECK (ab_winner IS NULL OR ab_winner IN ('A','B'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_issues_ab_sample_check') THEN
    -- A sample below a tenth is not a test, and above half leaves too few to benefit from the
    -- winner — at which point the tenant should just pick a subject line.
    ALTER TABLE newsletter_issues ADD CONSTRAINT newsletter_issues_ab_sample_check
      CHECK (ab_sample_percent BETWEEN 10 AND 50 AND ab_decide_after_hours BETWEEN 1 AND 72);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'newsletter_sends_variant_check') THEN
    ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_variant_check
      CHECK (variant IS NULL OR variant IN ('A','B'));
  END IF;
END $$;

-- 'held' joins the send vocabulary: materialised, frozen, not yet queued.
ALTER TABLE newsletter_sends DROP CONSTRAINT IF EXISTS newsletter_sends_status_check;
ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_status_check
  CHECK (status IN ('queued','held','sent','delivered','bounced','complained','failed','skipped'));

-- Counting opens per variant, which is the whole decision.
CREATE INDEX IF NOT EXISTS newsletter_sends_issue_variant_idx
  ON newsletter_sends (issue_id, variant) WHERE variant IS NOT NULL;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'newsletter_issues' AND column_name LIKE 'ab_%';
