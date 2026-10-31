-- db/z-growth-funnel.sql — the growth funnel (Admin → Analytics → Growth funnel). Owner decision
-- 2026-10-31: our own cookieless visit counter, no third-party analytics.
-- Code: src/utils/visit-source.ts (classify a visit), netlify/functions/track-visit.ts (count it),
-- visit-count.js (public pages), register.ts (save the sign-up's source),
-- netlify/functions/admin-funnel.ts (the report). Drizzle mirror: db/schema.ts.
--
-- Two NEW tables; nothing existing changes (a column on `users` would break every whole-row read of
-- users until applied). Code before SQL degrades: visits and sources are simply not counted, and the
-- Admin card says the SQL is missing.
--
-- APPLY to BOTH environments (staging, then prod). Idempotent. Every statement RETURNs or is a no-op.

BEGIN;

-- Daily totals of public page views. No IP, no user agent, no cookie, no visitor id: a row is a count.
-- `entries` = views that started a visit (arrived from another site, a tagged link, or no referrer);
-- `views` = every page view, including clicks around the site after landing.
CREATE TABLE IF NOT EXISTS site_visit_counts (
    day       DATE    NOT NULL,
    path      TEXT    NOT NULL,
    source    TEXT    NOT NULL,
    campaign  TEXT    NOT NULL DEFAULT '',
    views     INTEGER NOT NULL DEFAULT 0,
    entries   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path, source, campaign)
);
CREATE INDEX IF NOT EXISTS site_visit_counts_day_idx ON site_visit_counts (day);

-- The source a new account arrived with (one row per user, only when one was known).
CREATE TABLE IF NOT EXISTS signup_sources (
    user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source      TEXT NOT NULL,
    campaign    TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMP NOT NULL DEFAULT now()
);

COMMIT;

-- Check (expect two rows):
--   SELECT table_name FROM information_schema.tables WHERE table_name IN ('site_visit_counts', 'signup_sources');
