-- Autonomous Content Engine — the Blog Writer's "Organic Clicks" KPI card.
--
-- Context: ingest-gsc-metrics.ts has always asked Search Console for each published post's
-- performance and thrown half the answer away. The searchAnalytics/query response carries `clicks`
-- in the very same row as `impressions`; only impressions were read. So the product could tell an
-- author how often Google SHOWED their post and never whether anyone actually came.
--
-- ⚠️ search_clicks is NOT the same shape of number as traffic_baseline beside it.
--   · traffic_baseline is a running PEAK of impressions, maintained to detect decay against that
--     peak (see evaluateDecay / gsc-decay.ts). It never falls.
--   · search_clicks is the LATEST windowed measurement — clicks over the GSC lookback window
--     (GSC_LOOKBACK_DAYS, default 28), overwritten on each daily run. It rises and falls.
-- They must not be divided by one another to compute a click-through rate: peak impressions over
-- a 28-day click count is not a CTR, and presenting it as one would be a fabricated metric.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

-- ---------------------------------------------------------------------------------------------
-- blog_posts: search clicks over the most recent GSC window.
-- ---------------------------------------------------------------------------------------------
-- Nullable, and NULL is load-bearing: it means "never measured" (no Search Console connection, or
-- the post has no canonical_url to query by), which is a different answer from 0 = "we asked and
-- nobody clicked". get-blog-performance.ts keeps the two apart, exactly as it does for impressions.
ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS search_clicks INTEGER;

COMMENT ON COLUMN blog_posts.search_clicks IS
  'Search Console clicks over the latest GSC lookback window (default 28d), refreshed daily by ingest-gsc-metrics.ts. NULL = never measured. Windowed, unlike traffic_baseline which is a running peak.';
