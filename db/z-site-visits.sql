-- db/z-site-visits.sql — visitor counts for websites published by the Website Assistant: how many
-- people came, which pages they read, and which sites sent them. src/utils/site-visits.ts,
-- netlify/functions/site-visit.ts (counted by sites-host/edge-functions/serve.ts, which sees every
-- page view before any cache). Drizzle mirror: db/schema.ts (siteVisitDays, siteVisitPages,
-- siteVisitRefs, siteVisitSeen).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-site-visits.sql                              (staging)
--   npm run db:migrate:apply -- --only z-site-visits.sql --url-var DATABASE_URL_PROD  (prod)
--
-- Privacy (UK GDPR; no cookie, no script, so no banner): no IP address, user agent or cookie is stored.
-- A unique visitor is a one-way hash of (day, site, IP, browser) made with a secret on the edge, kept in
-- site_visit_seen for that day only and deleted after two days — it can't be traced back, and it can't
-- link a person across days or across sites. Only daily totals are kept beyond that.
-- `day` is the UK calendar date.

BEGIN;

CREATE TABLE IF NOT EXISTS site_visit_days (
    site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    day       DATE NOT NULL,
    views     INTEGER NOT NULL DEFAULT 0,
    visitors  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day)
);
CREATE TABLE IF NOT EXISTS site_visit_pages (
    site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    day       DATE NOT NULL,
    path      TEXT NOT NULL,
    views     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day, path)
);
CREATE TABLE IF NOT EXISTS site_visit_refs (
    site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    day       DATE NOT NULL,
    ref_host  TEXT NOT NULL,
    visits    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site_id, day, ref_host)
);
-- Today's (and yesterday's) hashed visitors, only to count each once a day. Deleted after two days.
CREATE TABLE IF NOT EXISTS site_visit_seen (
    site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    day       DATE NOT NULL,
    visitor   TEXT NOT NULL,
    PRIMARY KEY (site_id, day, visitor)
);

COMMIT;
