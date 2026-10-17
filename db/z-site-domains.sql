-- db/z-site-domains.sql — a business's own domain for its Website Assistant site (decision D2:
-- Netlify aliases to start). Code: src/utils/site-domains.ts; Drizzle mirror: db/schema.ts (siteDomains).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-site-domains.sql                              (staging)
--   npm run db:migrate:apply -- --only z-site-domains.sql --url-var DATABASE_URL_PROD  (prod)
--
-- One row per connection attempt; a site has at most one that is not 'removed'. `domain` is what
-- visitors are sent to (www.example.com); `alt_domain` the other form (example.com) that redirects
-- to it, and `alt_live` whether that form is connected yet. A name can be held by one site at a time.

CREATE TABLE IF NOT EXISTS site_domains (
    id                       SERIAL PRIMARY KEY,
    site_id                  INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    organisation_id          INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    domain                   TEXT NOT NULL,
    alt_domain               TEXT,
    alt_live                 BOOLEAN NOT NULL DEFAULT false,
    status                   TEXT NOT NULL DEFAULT 'pending_dns',
    status_detail            TEXT,
    checked_at               TIMESTAMPTZ,
    provision_requested_at   TIMESTAMPTZ,
    live_at                  TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_domains_status_check') THEN
    ALTER TABLE site_domains ADD CONSTRAINT site_domains_status_check
      CHECK (status IN ('pending_dns','securing','live','removed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS site_domains_domain_uq ON site_domains (domain) WHERE status <> 'removed';
CREATE UNIQUE INDEX IF NOT EXISTS site_domains_alt_uq ON site_domains (alt_domain) WHERE status <> 'removed' AND alt_domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS site_domains_site_uq ON site_domains (site_id) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS site_domains_org_idx ON site_domains (organisation_id);
