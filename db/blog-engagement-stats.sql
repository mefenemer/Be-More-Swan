-- Autonomous Content Engine — the Blog Writer's "Average Engagement Time" KPI card.
--
-- Context: widget.js has measured reader dwell time and max scroll depth since the headline A/B
-- test shipped, and posted them to widget-ab-beacon. But it only fired for a post that HAD hook
-- variants and was still in `testing` — so the overwhelming majority of posts were read with
-- nobody counting, and the data that did exist lived in blog_ab_stats, keyed per VARIANT, where
-- resolve-ab-tests consumes it to pick a headline winner.
--
-- ⚠️ Why a separate table rather than a sentinel variant row in blog_ab_stats.
-- resolve-ab-tests reads every row for a post and scores the variants against each other. A row
-- carrying whole-post traffic under a fake variant id would be scored as though it were a
-- competing headline, and it would win every time simply by having more impressions than any real
-- variant. The two questions are genuinely different — "which headline held people longer" versus
-- "did anyone read this post at all" — and they get different tables.
--
-- No PII, no cookies, no raw rows: aggregate counters only, upserted per view. Same posture as
-- blog_ab_stats, which is what makes this beacon safe to fire from a customer's own domain.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS blog_engagement_stats (
  blog_post_id    INTEGER PRIMARY KEY REFERENCES blog_posts(id) ON DELETE CASCADE,
  -- Completed reads: one per beacon flush (pagehide / tab hidden), NOT per page load. A reader who
  -- opens a post and never comes back to that tab is never counted, which is the honest direction:
  -- we only count a view we actually measured a duration for.
  views           INTEGER NOT NULL DEFAULT 0,
  -- Summed, not averaged, so the average can be recomputed at read time without a rolling update
  -- losing precision. bigint: 10k views x 1h clamp overflows int4.
  sum_dwell_ms    BIGINT  NOT NULL DEFAULT 0,
  sum_scroll_pct  BIGINT  NOT NULL DEFAULT 0,
  -- Dwell > 15s or scroll > 50%, decided client-side and mirrored from the A/B beacon's rule so
  -- "engaged" means the same thing on both surfaces.
  engaged_count   INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE blog_engagement_stats IS
  'Anonymous per-post reader engagement aggregates from widget.js. One row per published post. Distinct from blog_ab_stats, which is per headline VARIANT and is consumed by resolve-ab-tests.';
COMMENT ON COLUMN blog_engagement_stats.views IS
  'Measured reads (beacon flushes), not page loads. The denominator for average engagement time.';
