-- db/z-site-directory.sql — the site page directory every live assistant reads.
-- docs/site-directory-plan.md. Code: src/utils/site-directory.ts (pure: pick pages, build entries,
-- the prompt block), src/utils/site-directory-store.ts (reading, saving, the loader),
-- netlify/functions/site-directory.ts (Business Information tab + chat card).
-- Drizzle mirror: db/schema.ts (siteDirectories).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-site-directory.sql                              (staging)
--   npm run db:migrate:apply -- --only z-site-directory.sql --url-var DATABASE_URL_PROD  (prod)
--
-- ── site_directories ───────────────────────────────────────────────────────
-- One row per workspace: a MAP of its website (address, title, one-line summary, what each page
-- offers), never the page text. 'hosted' = read from its published Be More Swan site (no fetch);
-- 'crawl' = read from organisations.website_url. A failed refresh keeps the last good `pages`.
-- `excluded` holds the paths the owner left out; it survives every refresh.

BEGIN;

CREATE TABLE IF NOT EXISTS site_directories (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    source           TEXT NOT NULL CHECK (source IN ('hosted', 'crawl')),
    source_url       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'reading' CHECK (status IN ('reading', 'ready', 'failed')),
    pages            JSONB NOT NULL DEFAULT '[]'::jsonb,
    excluded         JSONB NOT NULL DEFAULT '[]'::jsonb,
    message          TEXT,
    refreshed_at     TIMESTAMPTZ,
    next_refresh_at  TIMESTAMPTZ,
    requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS site_directories_org_uq ON site_directories (organisation_id);
CREATE INDEX IF NOT EXISTS site_directories_due_idx ON site_directories (next_refresh_at);

COMMIT;
