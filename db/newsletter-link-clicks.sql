-- db/newsletter-link-clicks.sql
-- Which link worked.
-- Requires db/newsletter.sql, db/newsletter-dispatch.sql and db/newsletter-engagement.sql.
--
-- ── What was missing ────────────────────────────────────────────────────────────────────────────
-- newsletter_sends.last_clicked_url holds ONE url per recipient — deliberately, because a single
-- column pretending to be a click history would mislead. So "3.4% clicked" was answerable and
-- "clicked WHAT" was not, which is the half of the number a tenant can actually act on: the answer
-- decides what goes at the top of the next issue.
--
-- ── Why a row per (recipient, link) rather than per event ───────────────────────────────────────
-- Because the metric that matters is UNIQUE clicks. One reader clicking a link five times is one
-- person interested in it, and a table of raw events makes the honest number a DISTINCT over
-- unbounded rows — the same reasoning that made opens a first-touch timestamp rather than a
-- counter. Here the row IS the unique click (UNIQUE on (send_id, url_hash)), and repeats increment
-- click_count on it. So:
--     unique clicks on a link = count(*)      — how many PEOPLE
--     total clicks on a link  = sum(click_count) — how many TIMES
-- and both are exact. It also bounds the table by "people who actually clicked", not by everyone
-- who was sent the issue.
--
-- ⚠️ URL_HASH IS THE KEY, NOT THE URL. A btree index entry is capped near 2704 bytes and a real
-- campaign url with tracking parameters gets long; an index that works in testing and throws on a
-- customer's link is not a thing to leave to chance. The url is stored alongside for display.
--
-- Idempotent. ⚠️ APPLY BEFORE DEPLOYING THE CODE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'public' AND table_name = 'newsletter_sends') THEN
    RAISE EXCEPTION USING
      MESSAGE = 'db/newsletter-link-clicks.sql requires db/newsletter.sql first.',
      HINT    = 'npm run db:migrate:apply -- --only newsletter.sql   (then this file)',
      ERRCODE = 'undefined_table';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS newsletter_link_clicks (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  issue_id          INTEGER NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
  -- The recipient. CASCADE with the send row: this is engagement data about one delivery, and it
  -- has no meaning once that delivery's record is gone.
  send_id           INTEGER NOT NULL REFERENCES newsletter_sends(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  -- sha256 hex of the NORMALISED url — see normaliseClickUrl in the webhook for what is collapsed
  -- and why (every recipient's unsubscribe link is a different url, and thousands of one-click rows
  -- would bury the links the tenant actually wants to read about).
  url_hash          TEXT NOT NULL,
  click_count       INTEGER NOT NULL DEFAULT 1,
  first_clicked_at  TIMESTAMP NOT NULL DEFAULT now(),
  last_clicked_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- One row per person per link. This is what makes "unique clicks" a count(*) rather than a guess.
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_link_clicks_send_url_uidx
  ON newsletter_link_clicks (send_id, url_hash);

-- The report: every link in one issue, ordered by how many people clicked it.
CREATE INDEX IF NOT EXISTS newsletter_link_clicks_issue_idx
  ON newsletter_link_clicks (issue_id, url_hash);

-- Verify:
--   SELECT table_name FROM information_schema.tables WHERE table_name = 'newsletter_link_clicks';
