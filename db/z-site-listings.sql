-- db/z-site-listings.sql — Listings (docs/website-types-plan.md §4): a workspace's own lists of
-- things shown on its website — an events calendar or directory, and every other "list of entries"
-- (places, people, jobs, case studies). src/utils/site-listings.ts, netlify/functions/site-listings.ts.
-- Drizzle mirror: db/schema.ts (siteListings).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-site-listings.sql                              (staging)
--   npm run db:migrate:apply -- --only z-site-listings.sql --url-var DATABASE_URL_PROD  (prod)
--
-- kind: event (has a date) | entry (no date: a place, a person, a job…).
-- Dates and times are kept exactly as the owner typed them (starts_on / ends_on DATE, start_time /
-- end_time 'HH:MM' text) — no timezone arithmetic, so nothing shifts by an hour in British Summer Time.
-- status: published (on the site) | hidden (kept, not shown) | pending (sent in by a visitor, waiting
-- for the owner's approval — never shown until approved) | declined (never shown).
-- source: owner (added on the Listings tab or through the chat) | public ("Post your event" on the site).
-- submitter_name / submitter_email: who sent a public entry in — for the owner only, never on the site.

BEGIN;

CREATE TABLE IF NOT EXISTS site_listings (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'entry')),
    title            TEXT NOT NULL,
    slug             TEXT NOT NULL,
    category         TEXT,
    summary          TEXT,
    body             TEXT,
    starts_on        DATE,
    start_time       TEXT CHECK (start_time IS NULL OR start_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
    ends_on          DATE,
    end_time         TEXT CHECK (end_time IS NULL OR end_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
    location         TEXT,
    image_asset_id   INTEGER,
    image_alt        TEXT,
    link_url         TEXT,
    link_label       TEXT,
    status           TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'pending', 'declined')),
    source           TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'public')),
    submitter_name   TEXT,
    submitter_email  TEXT,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_listings_org_slug_idx ON site_listings (organisation_id, slug);
CREATE INDEX IF NOT EXISTS site_listings_org_idx ON site_listings (organisation_id, status, starts_on);

COMMIT;
