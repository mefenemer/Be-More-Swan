-- Pexels search-term cache (technical note: minimize redundant API calls / optimise latency).
--
-- Transient store of raw Pexels search responses keyed by a normalized "query|type|page" string.
-- Caching happens BEFORE per-org dedup: filterUnique() still runs on the cached candidates at read
-- time, so the cache never breaks the never-reuse rule (posted_assets).
--
-- A short TTL (see PEXELS_CACHE_TTL_MS in src/utils/pexels.ts) keeps results fresh; stale rows are
-- simply ignored on read and overwritten on the next miss. created_at index supports housekeeping.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push).

CREATE TABLE IF NOT EXISTS pexels_search_cache (
    query_key   TEXT PRIMARY KEY,
    candidates  JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pexels_search_cache_created_idx ON pexels_search_cache (created_at);
