-- db/z-mystery-shopper-role.sql — the Mystery Shopper's catalogue row (roleKey `mystery_shopper`).
-- Plan: docs/mystery-shopper-plan.md. Tables: db/z-mystery-shopper.sql (apply that one first).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-mystery-shopper-role                              (staging)
--   npm run db:migrate:apply -- --only z-mystery-shopper-role --url-var DATABASE_URL_PROD  (prod)
--
-- Inserted HIDDEN (is_active=false, coming_soon=false — src/utils/assistant-go-live.ts): nobody can
-- see or hire it until an admin changes its status on Admin ▸ Configuration ▸ Assistants, which is
-- the ONLY place status is written (admin-assistants.ts) and runs the go-live checks first.
-- ON CONFLICT DO NOTHING: once the row exists, every field is the admin's.
--
-- Hiding `competitor_intel_analyst` (decision D1, 2026-10-14) is deliberately NOT in this file —
-- status changes go through Admin ▸ Assistants, never through SQL.

BEGIN;

INSERT INTO master_assistants
    (role_key, name, description, category, icon_key, icon_color, tagline, key_features, integrations, works_with, coming_soon, is_active)
VALUES (
    'mystery_shopper',
    'Mystery Shopper',
    'Reads your website the way a real buyer would — a sceptical first-time visitor, a buyer comparing you with your competitors, and an AI assistant deciding whether it could recommend you — then scores it, writes the replacement wording, and checks again every week to prove each fix landed.',
    'Marketing & Sales',
    'globe',
    'pink',
    'Find out why visitors leave without buying.',
    '["Reads Your Site Like a Buyer","Side by Side With Your Competitors","Every Fix Checked on the Live Page"]'::jsonb,
    '[]'::jsonb,
    '["standalone"]'::jsonb,
    false,
    false
)
ON CONFLICT (role_key) DO NOTHING;

COMMIT;
