-- db/z-website-hosting.sql — the Website Assistant, step 3a: publishing on <name>.bemoreswan.site.
-- docs/website-assistant-plan.md §5.2, §6. Code: src/utils/site-hosting.ts, src/utils/site-store.ts
-- (publish/unpublish/restore), netlify/functions/site-serve.ts, site-reports.ts, admin-sites.ts.
-- Drizzle mirror: db/schema.ts (sites, siteVersions, siteReports).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-website-hosting.sql                              (staging)
--   npm run db:migrate:apply -- --only z-website-hosting.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── sites (new columns) ────────────────────────────────────────────────────
-- `slug` already exists (z-website-assistant.sql): the <slug>.bemoreswan.site address, unique.
-- `published_version` is the site_versions.version the public sees; NULL = never published.
-- `status`: draft (offline) · published (live) · suspended (taken down by us — the owner cannot
-- publish until an admin restores it; `suspended_reason` is shown to them).
--
-- ── site_versions ──────────────────────────────────────────────────────────
-- Every publish is a frozen copy of the definition that passed the gate. The live site is served
-- from here, never from the draft, so editing never changes the live site until "Publish". The
-- newest 20 per site are kept (site-store.ts trims).
--
-- ── site_reports ───────────────────────────────────────────────────────────
-- "Report this site" — in every hosted site's footer. Public, rate-limited; the reporter's email is
-- optional. Reviewed on Admin ▸ Trust ▸ Hosted Sites.

BEGIN;

ALTER TABLE sites ADD COLUMN IF NOT EXISTS published_version INTEGER;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS published_at      TIMESTAMP;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMP;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS suspended_reason  TEXT;

CREATE TABLE IF NOT EXISTS site_versions (
    id            SERIAL PRIMARY KEY,
    site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    definition    JSONB NOT NULL,
    published_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    published_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_versions_site_version_uq ON site_versions (site_id, version);

CREATE TABLE IF NOT EXISTS site_reports (
    id              SERIAL PRIMARY KEY,
    site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL CHECK (reason IN ('scam', 'impersonation', 'harmful', 'copyright', 'other')),
    details         TEXT,
    reporter_email  TEXT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
    reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_reports_site_idx ON site_reports (site_id);
CREATE INDEX IF NOT EXISTS site_reports_open_idx ON site_reports (status) WHERE status = 'open';

-- Tenant isolation: both tables hang off sites (organisation-scoped). Every workspace reader joins
-- through sites.organisation_id (site-store.ts); site_reports is otherwise read by admins only.

COMMIT;
