-- Integration Scenario Library — the Zapier-style recipe layer over the Phase-1
-- integration primitives (workspace_integrations = OAuth grant, webhook_events =
-- inbound intake, sync-action ACTION_HANDLERS = outbound execution).
-- Design: docs/integration-scenario-library-plan.md. Drizzle mirror: db/schema.ts
-- (integrationProviders / integrationScenarios / activeScenarios / suppressionList).
-- The outbound job queue lives in db/scenario-jobs.sql.
--
-- Idempotent: safe to re-run. Apply MANUALLY as the DB owner (no drizzle-kit push —
-- an RLS-enabled push can propose DROP POLICY on ai_assistants; see webhook-events.sql).

-- ── Provider catalog (SEED data, not tenant-owned) ───────────────────────────
CREATE TABLE IF NOT EXISTS integration_providers (
  id            SERIAL PRIMARY KEY,
  provider_key  TEXT NOT NULL UNIQUE,          -- 'hubspot' | 'salesforce' | 'custom_webhook'
  display_name  TEXT NOT NULL,
  category      TEXT NOT NULL,                 -- 'crm' | 'accounting' | 'comms' | 'generic'
  auth_type     TEXT NOT NULL,                 -- 'oauth2' | 'api_key' | 'webhook_url'
  logo_key      TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- ── Scenario library (SEED data) — the browsable recipes ─────────────────────
CREATE TABLE IF NOT EXISTS integration_scenarios (
  id                 SERIAL PRIMARY KEY,
  scenario_key       TEXT NOT NULL UNIQUE,      -- 'hubspot_handoff_push'
  provider_key       TEXT NOT NULL,             -- → integration_providers.provider_key
  tier               INTEGER NOT NULL DEFAULT 1,-- 1 native | 2 universal webhook | 3 roadmap
  direction          TEXT NOT NULL,             -- 'outbound' | 'inbound' | 'two_way'
  scenario_type      TEXT NOT NULL,             -- 'handoff_push' | 'feedback_loop' | 'suppression_sync'
  title              TEXT NOT NULL,
  description        TEXT,
  trigger_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_type        TEXT,                      -- ACTION_HANDLERS key (outbound only)
  field_schema       JSONB NOT NULL DEFAULT '[]'::jsonb,
  roadmap_feature_id INTEGER REFERENCES feature_requests(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'available', -- 'available' | 'coming_soon' | 'deprecated'
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT integration_scenarios_tier_check      CHECK (tier IN (1,2,3)),
  CONSTRAINT integration_scenarios_direction_check CHECK (direction IN ('outbound','inbound','two_way'))
);
CREATE INDEX IF NOT EXISTS integration_scenarios_provider_idx
  ON integration_scenarios (provider_key, status);

-- ── Active scenarios (TENANT data) — recipes a workspace turned on, per assistant ──
CREATE TABLE IF NOT EXISTS active_scenarios (
  id              SERIAL PRIMARY KEY,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  assistant_id    INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  scenario_id     INTEGER NOT NULL REFERENCES integration_scenarios(id) ON DELETE CASCADE,
  integration_id  INTEGER REFERENCES workspace_integrations(id) ON DELETE CASCADE,
  field_mappings  JSONB NOT NULL DEFAULT '{}'::jsonb,
  webhook_url     TEXT,
  is_enabled      BOOLEAN NOT NULL DEFAULT true,
  last_fired_at   TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);
-- One activation of a given recipe per assistant.
CREATE UNIQUE INDEX IF NOT EXISTS active_scenarios_assistant_scenario_unique
  ON active_scenarios (assistant_id, scenario_id);
CREATE INDEX IF NOT EXISTS active_scenarios_org_enabled_idx
  ON active_scenarios (organisation_id, is_enabled);
CREATE INDEX IF NOT EXISTS active_scenarios_scenario_enabled_idx
  ON active_scenarios (scenario_id, is_enabled);

-- ── Suppression list (TENANT data) — Scenario Type C target ──────────────────
-- Domains the autonomous discovery AI must never prospect. Domain normalisation
-- (lowercase, strip leading www.) MUST match discovered_leads so the guard is a join.
CREATE TABLE IF NOT EXISTS suppression_list (
  id                 SERIAL PRIMARY KEY,
  organisation_id    INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  domain             TEXT NOT NULL,
  reason             TEXT NOT NULL DEFAULT 'existing_customer',
  source             TEXT NOT NULL DEFAULT 'crm_sync',  -- 'crm_sync' | 'manual'
  source_scenario_id INTEGER REFERENCES active_scenarios(id) ON DELETE SET NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS suppression_list_org_domain_unique
  ON suppression_list (organisation_id, domain);
CREATE INDEX IF NOT EXISTS suppression_list_org_idx
  ON suppression_list (organisation_id);

-- ── Log correlation — link an outbound API call to the recipe that produced it ──
ALTER TABLE integration_api_calls
  ADD COLUMN IF NOT EXISTS active_scenario_id INTEGER
  REFERENCES active_scenarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS integration_api_calls_scenario_idx
  ON integration_api_calls (active_scenario_id, called_at);
