-- db/newsletter-engagement.sql
-- Per-recipient open and click tracking for newsletter issues.
-- Requires db/newsletter.sql and db/newsletter-dispatch.sql.
--
-- ── Why timestamps and not counters ─────────────────────────────────────────────────────────────
-- One subscriber opening an issue five times is ONE person reading it. Counting every event would
-- inflate an "open rate" past 100% and make the number meaningless — so the ledger stores FIRST
-- touch per recipient, and newsletter_issues.opened_count / clicked_count are incremented only when
-- the timestamp moves from NULL. That is the whole reason these columns exist rather than a bare
-- counter on the issue.
--
-- ⚠️ WHAT AN OPEN ACTUALLY MEANS. Open tracking is a 1×1 image. Apple Mail Privacy Protection (on by
-- default for Apple Mail since 2021) pre-fetches that image for every message whether or not a human
-- looks at it, and other clients block it entirely. So opens are inflated for some recipients,
-- invisible for others, and are a TREND rather than a measurement. Every surface that shows this
-- number says so; do not let a future change quietly present it as a fact.
--
-- ⚠️ Clicks are only recorded when the provider rewrites links, which happens on the Resend route
-- only. Mail sent from a tenant's own Gmail/Outlook mailbox reports neither opens nor clicks —
-- get-newsletter-performance distinguishes "none" from "not measurable" for that reason.
--
-- Idempotent. Apply to staging first, then prod, as the DB owner.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_sends') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-engagement.sql requires db/newsletter.sql and db/newsletter-dispatch.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only newsletter   (then --only newsletter-dispatch, then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

-- First touch per recipient. NULL = never.
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMP;
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMP;

-- Repeat engagement, kept for interest but NEVER used as the numerator of a rate.
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS open_count  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;

-- The last link a recipient followed. One URL, not a history: a per-link report is a different
-- feature with a different table, and a single column pretending to be one would mislead.
ALTER TABLE newsletter_sends ADD COLUMN IF NOT EXISTS last_clicked_url TEXT;

-- Whether the issue could report engagement AT ALL. Set at send time from the route:
-- true on the Resend route with tracking enabled, false from a tenant's own mailbox.
-- ⚠️ Without this, "0% opened" and "we cannot see opens" are the same number on screen.
ALTER TABLE newsletter_issues ADD COLUMN IF NOT EXISTS engagement_tracked BOOLEAN NOT NULL DEFAULT false;

-- Whether the tenant asked for tracking on this domain. Off means we tell the provider not to
-- rewrite links or embed the pixel, and the issue records engagement_tracked = false.
ALTER TABLE newsletter_sending_domains ADD COLUMN IF NOT EXISTS open_tracking  BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE newsletter_sending_domains ADD COLUMN IF NOT EXISTS click_tracking BOOLEAN NOT NULL DEFAULT true;

-- The webhook matches on the provider's message id; these two make the "has this recipient already
-- opened?" check on every event an index hit rather than a scan of the issue's whole ledger.
CREATE INDEX IF NOT EXISTS newsletter_sends_opened_idx  ON newsletter_sends (issue_id) WHERE opened_at  IS NOT NULL;
CREATE INDEX IF NOT EXISTS newsletter_sends_clicked_idx ON newsletter_sends (issue_id) WHERE clicked_at IS NOT NULL;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'newsletter_sends' AND column_name IN ('opened_at','clicked_at','open_count','click_count','last_clicked_url');
