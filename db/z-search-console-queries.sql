-- db/z-search-console-queries.sql — "Searches that found you" (Google Trends plan, Phase 1b; FR#31).
-- docs/google-trends-plan.md §5 Phase 1b. Code: netlify/functions/ingest-gsc-metrics.ts (writes),
-- src/utils/gsc-queries.ts (picks properties, ranks, reads, prompt block),
-- netlify/functions/get-search-queries.ts (Blog setup panel), src/utils/chat-search-queries.ts (chat).
-- Drizzle mirror: db/schema.ts (searchConsoleQueries).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-search-console-queries.sql                              (staging)
--   npm run db:migrate:apply -- --only z-search-console-queries.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── search_console_queries ─────────────────────────────────────────────────
-- The searches people typed in Google before seeing the workspace's own site, from its connected
-- Search Console: the top queries by impressions over the latest 28-day window (data trails ~3 days).
-- A SNAPSHOT, not history: the daily ingest replaces a property's rows in one transaction, so what is
-- here is always one window. Google already anonymises these (rare queries are withheld), and no
-- personal data is involved: a query is search text, never who typed it.
--
-- One row per org + property + query. A workspace whose Search Console sees several properties keeps
-- only the ones that match its own site (website_url, blog widget site URL, published posts' canonical
-- URLs) — an agency login must not pour its clients' searches into one workspace.

BEGIN;

CREATE TABLE IF NOT EXISTS search_console_queries (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    property         TEXT NOT NULL,
    query            TEXT NOT NULL,
    clicks           INTEGER NOT NULL DEFAULT 0,
    impressions      INTEGER NOT NULL DEFAULT 0,
    ctr              REAL,
    position         REAL,
    window_start     DATE NOT NULL,
    window_end       DATE NOT NULL,
    fetched_at       TIMESTAMP NOT NULL DEFAULT now(),
    UNIQUE (organisation_id, property, query)
);
CREATE INDEX IF NOT EXISTS search_console_queries_org_idx ON search_console_queries (organisation_id, impressions DESC);

COMMIT;
