-- db/z-campaign-audience.sql — who a campaign is FOR, and who it must leave alone.
-- Design: docs/campaign-orchestrator-plan.md §9.2. Pure helpers: src/config/campaign-audience.ts.
-- Drizzle mirror: db/schema.ts (campaigns.audience, campaigns.excludeExistingCustomers).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-audience
--
-- ⚠️ The `z-` prefix is load-bearing. The runner sorts `-` before `.`, so `campaign-audience.sql`
-- would run BEFORE `campaigns.sql` on a fresh database and fail on a table that does not exist yet
-- (db/z-ai-music-generation.sql is the same fix for the same reason).
--
-- ⚠️ Deploy order is not optional: campaigns.ts `requireCampaign()` does `db.select().from(campaigns)`,
-- which names every column in the drizzle mirror. Code that knows these columns, running against a
-- database that does not, breaks the WHOLE Campaigns tab — not just the audience fields.
--
-- ── audience ────────────────────────────────────────────────────────────────
-- { persona?: string, description?: string, excludeDomains?: string[] }. NULLABLE: "not said yet"
-- is a real state, and the directive simply omits the line rather than inventing an audience.
-- jsonb rather than three columns because 9.7 (email nurture) adds a segment id here, and an
-- Email Marketing segment is the same idea — who this is for — expressed as a list.
--
-- ── exclude_existing_customers ──────────────────────────────────────────────
-- DEFAULT TRUE. An acquisition campaign that spends a month's lead searches finding companies the
-- business already sells to is the failure the marketing review named, and the safe default is the
-- one that wastes nothing. A retention campaign (customers ARE the audience) turns it off by hand;
-- §9.6's funnel stage will set that default automatically.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS audience JSONB;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS exclude_existing_customers BOOLEAN NOT NULL DEFAULT TRUE;

COMMIT;

-- RLS: deliberately not enabled, as for every campaign table — see the foot of db/campaigns.sql.
