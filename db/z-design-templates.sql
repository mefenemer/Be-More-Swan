-- db/z-design-templates.sql — saved design templates in the Brand Designer (owner, 2026-11-06).
-- Code: src/utils/design-templates.ts. Drizzle mirror: db/schema.ts (designTemplates).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-design-templates                              (staging)
--   npm run db:migrate:apply -- --only z-design-templates --url-var DATABASE_URL_PROD  (prod)
--
-- Order does not matter for anything else: only the templates code reads this table, and until it exists the editor
-- simply offers no templates.

CREATE TABLE IF NOT EXISTS design_templates (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    design           JSONB NOT NULL,
    created_by       INTEGER,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS design_templates_org_name ON design_templates (organisation_id, lower(name));
