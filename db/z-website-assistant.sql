-- db/z-website-assistant.sql — the Website Assistant, step 2 (docs/website-assistant-plan.md §6).
-- Code: src/utils/site-definition.ts, src/utils/site-render.ts, netlify/functions/sites.ts,
-- netlify/functions/site-preview.ts. Drizzle mirror: db/schema.ts (sites).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code deploys. Idempotent.
--   npm run db:migrate:apply -- --only z-website-assistant.sql                              (staging)
--   npm run db:migrate:apply -- --only z-website-assistant.sql --url-var DATABASE_URL_PROD  (prod)
-- (the full filename, so --only matches this file alone)
--
-- ── sites ──────────────────────────────────────────────────────────────────
-- ONE site per hired Website Assistant. `draft` is the definition being edited — every write to it
-- has passed normaliseSiteDefinition. Publishing (step 3) copies it to versions; nothing here is
-- served to the public yet. `credit` = the "Made with Be More Swan" footer link, ON by default
-- (decision 2026-10-14). `slug` is the free subdomain, chosen at publish time (step 3).
--
-- ── The catalogue row ──────────────────────────────────────────────────────
-- Inserted HIDDEN (is_active=false, coming_soon=false). Status changes only on Admin ▸ Configuration
-- ▸ Assistants. ON CONFLICT DO NOTHING: once it exists, every field is the admin's.
--
-- ── Pages per plan ─────────────────────────────────────────────────────────
-- `website_pages` — decision D1: 5 on £29 (saver). The two higher tiers are seeded at 15 and 50 as
-- STARTING values, editable in Admin ▸ Master Data ▸ Plan Features; only set where missing, so a
-- re-run never overwrites an admin's number. The catalogue row is is_enabled=false so it stays off
-- the public pricing table until the role goes live.

BEGIN;

CREATE TABLE IF NOT EXISTS sites (
    id               SERIAL PRIMARY KEY,
    organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    ai_assistant_id  INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'suspended')),
    draft            JSONB NOT NULL,
    slug             TEXT,
    credit           BOOLEAN NOT NULL DEFAULT true,
    -- An AI draft in flight (status of the background job), so a double click cannot start two.
    drafting_at      TIMESTAMP,
    draft_note       TEXT,
    created_at       TIMESTAMP NOT NULL DEFAULT now(),
    updated_at       TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sites_assistant_uq ON sites (ai_assistant_id);
CREATE UNIQUE INDEX IF NOT EXISTS sites_slug_uq ON sites (slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS sites_org_idx ON sites (organisation_id);

INSERT INTO master_assistants
    (role_key, name, description, category, icon_key, icon_color, tagline, key_features, integrations, works_with, coming_soon, is_active)
VALUES (
    'website_assistant',
    'Website Assistant',
    'Builds your website from a conversation — pages, wording, pictures and layout — shows you a live preview, and makes the changes you ask for. No drag-and-drop, no templates to wrestle with: you describe it, approve it, and it keeps it up to date.',
    'Marketing & Sales',
    'globe',
    'purple',
    'Describe your website. Approve it. Done.',
    '["Built From a Conversation","Live Preview Before Anything Goes Out","Search-Ready on Every Page"]'::jsonb,
    '[]'::jsonb,
    '["standalone", "mystery_shopper"]'::jsonb,
    false,
    false
)
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO plan_features (key, label, description, category, value_type, storage_target,
                           unlimited_label, enterprise_value, display_order, is_enabled)
VALUES (
  'website_pages',
  'Website Pages',
  'Pages your Website Assistant can build and keep up to date on your site.',
  'Capacity', 'number', 'feature', 'Unlimited', 'Custom',
  (SELECT COALESCE(MAX(display_order), 0) + 1 FROM plan_features WHERE category = 'Capacity'),
  false
)
ON CONFLICT (key) DO NOTHING;

UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || '{"website_pages": 5}'::jsonb
 WHERE tier_key = 'saver' AND NOT (COALESCE(features, '{}'::jsonb) ? 'website_pages');
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || '{"website_pages": 15}'::jsonb
 WHERE tier_key = 'buster' AND NOT (COALESCE(features, '{}'::jsonb) ? 'website_pages');
UPDATE master_plans SET features = COALESCE(features, '{}'::jsonb) || '{"website_pages": 50}'::jsonb
 WHERE tier_key = 'employee' AND NOT (COALESCE(features, '{}'::jsonb) ? 'website_pages');

COMMIT;
