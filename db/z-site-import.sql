-- db/z-site-import.sql — the Website Assistant's "Import my current site".
-- docs/website-assistant-plan.md §5.3 step 1. Code: src/utils/site-import.ts (pure: blocks → plan →
-- sections), src/utils/site-import-store.ts (reading, pictures, saving), netlify/functions/sites.ts
-- (import / import_accept / import_discard). Drizzle mirror: db/schema.ts (siteImports).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-site-import.sql                              (staging)
--   npm run db:migrate:apply -- --only z-site-import.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── site_imports ───────────────────────────────────────────────────────────
-- One row per site. 'reading' while the worker reads their old site; 'ready' holds the imported
-- DRAFT (a site definition, already through the gate) for the owner to review — sites.draft is only
-- replaced when they press "Use this as my draft"; 'failed' keeps the plain-words reason and what we
-- managed to read. Pictures they chose to copy are ordinary content_assets rows (provider 'site_import').
-- A new table rather than columns on `sites`, so every existing read of `sites` is untouched.

BEGIN;

CREATE TABLE IF NOT EXISTS site_imports (
    id               SERIAL PRIMARY KEY,
    site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    source_url       TEXT NOT NULL,
    pictures         TEXT NOT NULL DEFAULT 'skip' CHECK (pictures IN ('copy', 'skip')),
    status           TEXT NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'ready', 'failed')),
    definition       JSONB,
    report           JSONB,
    message          TEXT,
    requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_imports_site_uq ON site_imports (site_id);
CREATE INDEX IF NOT EXISTS site_imports_org_idx ON site_imports (organisation_id);

COMMIT;
