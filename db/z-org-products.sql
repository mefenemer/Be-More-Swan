-- db/z-org-products.sql — Products & Services: what the business sells, recorded on Business
-- Information and read by every assistant. Code: src/utils/org-products.ts,
-- netlify/functions/org-products.ts. Drizzle mirror: db/schema.ts (orgProducts).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-org-products                              (staging)
--   npm run db:migrate:apply -- --only z-org-products --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: every prompt reader catches a missing table and carries on without products, but the
-- Products & Services tab cannot list or save until this exists.
--
-- price is TEXT on purpose: "£29/month", "from £450", "POA" and "free for charities" are all real
-- answers, and a numeric column would force a business to misstate the one it actually gives.
-- status 'archived' keeps a product the business has stopped selling out of every prompt without
-- losing what was written about it.

BEGIN;

CREATE TABLE IF NOT EXISTS org_products (
    id              SERIAL PRIMARY KEY,
    organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL DEFAULT 'product' CHECK (kind IN ('product', 'service')),
    name            TEXT NOT NULL,
    description     TEXT,
    benefits        TEXT,
    price           TEXT,
    audience        TEXT,
    url             TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS org_products_org_status_idx
    ON org_products (organisation_id, status, sort_order);

COMMIT;
