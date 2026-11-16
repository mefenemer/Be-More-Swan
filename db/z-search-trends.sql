-- db/z-search-trends.sql — the Google Trends engine (Google Trends plan, Phase 1; FR#31).
-- docs/google-trends-plan.md §5 Phase 1 and §10. Code: src/lib/trends-provider.ts (DataForSEO),
-- src/utils/search-trends.ts (parse, peak months, relevance filter, weekly refresh, tracking),
-- netlify/functions/refresh-search-trends.ts (hourly tick) → search-trends-background.ts (worker),
-- netlify/functions/run-search-trends-refresh.ts (staging poke).
-- Drizzle mirror: db/schema.ts (searchTrendTerms, orgTrendTerms).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-search-trends.sql                              (staging)
--   npm run db:migrate:apply -- --only z-search-trends.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── search_trend_terms ─────────────────────────────────────────────────────
-- SHARED across workspaces: one row per search term + Google Trends location. Two workspaces tracking
-- "boiler service" in the UK cost one weekly fetch. No organisation column and nothing personal: a
-- term is public search text, and only aggregates come back (relative interest, 100 = the peak in
-- the period — never search counts).
--   series         weekly points over the past 12 months: [{ "d": "2025-11-16", "v": 42 | null }]
--   peak_months    calendar months (1–12) whose average is within 10% of the best month
--   top_queries    related searches Google lists as top, AFTER the relevance filter
--   rising_queries related searches Google lists as rising, AFTER the filter: [{ "query", "value" }]
--   status         pending (never fetched) | ok | not_enough_data | error
--   task_id        the DataForSEO Standard task waiting to be collected (NULL when none is out)
--
-- ── org_trend_terms ────────────────────────────────────────────────────────
-- Which workspace tracks which shared term. `approved_at` NULL = suggested, not yet approved by the
-- owner (plan §10 Q4: auto-suggested, then approved); only approved rows are fetched.

BEGIN;

CREATE TABLE IF NOT EXISTS search_trend_terms (
    id               SERIAL PRIMARY KEY,
    term             TEXT NOT NULL,
    location_code    INTEGER NOT NULL,
    location_name    TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    series           JSONB NOT NULL DEFAULT '[]'::jsonb,
    peak_months      JSONB NOT NULL DEFAULT '[]'::jsonb,
    top_queries      JSONB NOT NULL DEFAULT '[]'::jsonb,
    rising_queries   JSONB NOT NULL DEFAULT '[]'::jsonb,
    non_zero_share   REAL,
    task_id          TEXT,
    task_posted_at   TIMESTAMP,
    fetched_at       TIMESTAMP,
    attempts         INTEGER NOT NULL DEFAULT 0,
    last_error       TEXT,
    cost_usd_total   NUMERIC(10, 4) NOT NULL DEFAULT 0,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (term, location_code)
);
CREATE INDEX IF NOT EXISTS search_trend_terms_task_idx ON search_trend_terms (task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS org_trend_terms (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    term_id          INTEGER NOT NULL REFERENCES search_trend_terms(id) ON DELETE CASCADE,
    source           TEXT NOT NULL DEFAULT 'user',
    approved_at      TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (organisation_id, term_id)
);
CREATE INDEX IF NOT EXISTS org_trend_terms_term_idx ON org_trend_terms (term_id) WHERE approved_at IS NOT NULL;

COMMIT;
