-- db/z-system-fixed-costs.sql — monthly bills for the systems that run Be More Swan (System Map,
-- docs/system-map-plan.md). Variable spend is already per call in ai_usage_log; this holds what no
-- API call shows: Netlify, Neon, Resend, ElevenLabs Starter, Porkbun and the like.
-- Code: src/utils/system-map.ts (system keys, monthly → period maths). Drizzle mirror: db/schema.ts (systemFixedCosts).
-- system_key matches a key in netlify/functions/admin-system-status.ts SERVICES.
--
-- APPLY MANUALLY as the DB owner, to BOTH environments. Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-system-fixed-costs                              (staging)
--   npm run db:migrate:apply -- --only z-system-fixed-costs --url-var DATABASE_URL_PROD  (prod)
--
-- ORDER: any order. Nothing reads it until the System Map page (Phase 2). Starts empty — the owner
-- enters the real bills; nothing is seeded so no guessed figure is shown as a cost.
--
-- A price change is a NEW row: end the old one (ended_on) and start the next (started_on), so
-- all-time totals stay right.

BEGIN;

CREATE TABLE IF NOT EXISTS system_fixed_costs (
    id              SERIAL PRIMARY KEY,
    system_key      TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT '',          -- e.g. 'Pro plan', 'Starter 40k chars'
    amount_monthly  NUMERIC(10, 2) NOT NULL CHECK (amount_monthly >= 0),
    currency        TEXT NOT NULL DEFAULT 'GBP' CHECK (currency IN ('GBP', 'USD', 'EUR')),
    started_on      DATE NOT NULL,
    ended_on        DATE,                              -- NULL = still paying
    note            TEXT NOT NULL DEFAULT '',
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT now(),
    updated_at      TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT system_fixed_costs_dates_check CHECK (ended_on IS NULL OR ended_on >= started_on)
);

CREATE INDEX IF NOT EXISTS system_fixed_costs_system_idx ON system_fixed_costs (system_key);

COMMIT;
