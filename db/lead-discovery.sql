-- Lead Generator — Outbound Discovery Layer.
-- Design: docs/lead-generator-discovery-plan.md. Drizzle mirror: db/schema.ts
-- (discoveryCampaigns / discoverySchedules / discoveryGuardrails / discoveryJobs /
-- discoveredLeads). Turns the inbound Lead Qualifier (roleKey `lead_qualifier`)
-- into a proactive outbound discovery engine.
--
-- NOTE: distinct from the `leads` table (Be More Swan's OWN trial/upgrade sales
-- pipeline). Qualified discovered_leads are mirrored into assistant_records
-- (record_type 'lead', approval_status 'pending_approval') so the existing Data Hub /
-- Review Queue / Calendar UI renders them unchanged.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push —
-- see the no-db:push rule).

-- ── Campaigns: the user-authored "Idea / Blueprint" ──────────────────────────
CREATE TABLE IF NOT EXISTS discovery_campaigns (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  idea              TEXT NOT NULL,
  target_persona    JSONB,
  status            TEXT NOT NULL DEFAULT 'draft',
  icp_snapshot      JSONB,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT discovery_campaigns_status_check
    CHECK (status IN ('draft','active','paused','archived'))
);
CREATE INDEX IF NOT EXISTS discovery_campaigns_assistant_idx
  ON discovery_campaigns (organisation_id, ai_assistant_id, status);

-- ── Schedules: declarative cadence, read by the dispatcher ───────────────────
CREATE TABLE IF NOT EXISTS discovery_schedules (
  id                SERIAL PRIMARY KEY,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id       INTEGER NOT NULL REFERENCES discovery_campaigns(id) ON DELETE CASCADE,
  cadence           TEXT NOT NULL DEFAULT 'weekly',        -- 'one_off' | 'daily' | 'weekly'
  days_of_week      JSONB,                                 -- [1] = Monday
  run_at_hour_utc   INTEGER NOT NULL DEFAULT 8,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  is_enabled        BOOLEAN NOT NULL DEFAULT true,
  last_run_at       TIMESTAMP,
  next_run_at       TIMESTAMP,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT discovery_schedules_cadence_check
    CHECK (cadence IN ('one_off','daily','weekly'))
);
CREATE INDEX IF NOT EXISTS discovery_schedules_due_idx
  ON discovery_schedules (is_enabled, next_run_at);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_schedules_campaign_uidx
  ON discovery_schedules (campaign_id);

-- ── Guardrails: per-campaign cost ceilings + brand-safety lists ──────────────
CREATE TABLE IF NOT EXISTS discovery_guardrails (
  id                        SERIAL PRIMARY KEY,
  organisation_id           INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id               INTEGER NOT NULL REFERENCES discovery_campaigns(id) ON DELETE CASCADE,
  max_leads_per_run         INTEGER NOT NULL DEFAULT 50,
  max_leads_per_month       INTEGER NOT NULL DEFAULT 500,
  max_search_calls_per_run  INTEGER NOT NULL DEFAULT 100,
  max_tokens_per_run        INTEGER NOT NULL DEFAULT 200000,
  max_cost_gbp_per_run      NUMERIC(10,2) NOT NULL DEFAULT 2.00,
  negative_keywords         JSONB,
  excluded_domains          JSONB,
  require_human_approval    BOOLEAN NOT NULL DEFAULT true,
  created_at                TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                TIMESTAMP NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS discovery_guardrails_campaign_uidx
  ON discovery_guardrails (campaign_id);

-- ── Jobs: the queue, drained with FOR UPDATE SKIP LOCKED ─────────────────────
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id                SERIAL PRIMARY KEY,
  job_id            TEXT NOT NULL UNIQUE,
  organisation_id   INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id       INTEGER NOT NULL REFERENCES discovery_campaigns(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'queued',        -- queued | processing | completed | failed
  stage             TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  next_retry_at     TIMESTAMP,
  error_message     TEXT,
  trigger_type      TEXT NOT NULL DEFAULT 'scheduled',     -- 'scheduled' | 'on_demand'
  cursor            JSONB,
  leads_found       INTEGER NOT NULL DEFAULT 0,
  search_calls_made INTEGER NOT NULL DEFAULT 0,
  tokens_used       INTEGER NOT NULL DEFAULT 0,
  cost_gbp          NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT discovery_jobs_status_values_check
    CHECK (status IN ('queued','processing','completed','failed'))
);
CREATE INDEX IF NOT EXISTS discovery_jobs_status_idx
  ON discovery_jobs (status, next_retry_at);
CREATE INDEX IF NOT EXISTS discovery_jobs_campaign_idx
  ON discovery_jobs (campaign_id, status);

-- ── Discovered leads: raw output + provenance; dedupe on (campaign, domain) ───
CREATE TABLE IF NOT EXISTS discovered_leads (
  id                  SERIAL PRIMARY KEY,
  organisation_id     INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id         INTEGER NOT NULL REFERENCES discovery_campaigns(id) ON DELETE CASCADE,
  job_id              INTEGER REFERENCES discovery_jobs(id) ON DELETE SET NULL,
  company_name        TEXT NOT NULL,
  domain              TEXT,                                 -- normalised (lowercased, no www)
  contact_name        TEXT,
  contact_email       TEXT,
  source_url          TEXT,
  discovered_via      TEXT,                                 -- 'niche_scrape' | 'intent_signal' | 'footprint'
  matched_query       TEXT,
  signals             JSONB,
  score               INTEGER,
  rating              TEXT,                                 -- 'hot' | 'warm' | 'cold'
  scoring_card        JSONB,
  status              TEXT NOT NULL DEFAULT 'discovered',   -- discovered → qualified → promoted → discarded
  assistant_record_id INTEGER REFERENCES assistant_records(id) ON DELETE SET NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT now(),
  updated_at          TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT discovered_leads_status_check
    CHECK (status IN ('discovered','qualified','promoted','discarded'))
);
-- Dedupe: one row per (campaign, domain) when a domain is known.
CREATE UNIQUE INDEX IF NOT EXISTS discovered_leads_campaign_domain_uidx
  ON discovered_leads (campaign_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS discovered_leads_campaign_status_idx
  ON discovered_leads (campaign_id, status);
