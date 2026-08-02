-- db/signal-inbox-1a.sql
-- Phase 1a of docs/lead-generator-revenue-engine-plan.md — the Signal Inbox over saved searches.
--
-- The "describe what you want your assistant to search for, saved as a search" capability ALREADY
-- EXISTS: discovery_campaigns + the "Find New Leads" modal, live on staging. Phase 1a does not
-- rebuild it — it surfaces its output as an inbox of inbound signals, categorised as
-- "<Assistant name> Search". The engine is untouched.
--
-- Hence this migration is deliberately tiny — two nullable columns, no backfill, no data movement:
--
--   discovery_campaigns.name        — a short label for the search. `idea` is a paragraph; the
--                                     inbox needs something chip-sized to filter by. NULL for every
--                                     pre-existing campaign; readers fall back to a truncated idea,
--                                     so nothing breaks and nothing needs backfilling.
--   discovery_jobs.signals_published_at — when a completed run's results were published to the inbox
--                                     and the user notified. This is the IDEMPOTENCY key for that
--                                     notification: a discovery run is cursor-resumable across ticks
--                                     and can be retried after a failure, so without a stamp one
--                                     logical run could notify the user several times.
--
-- NOTE: there is no `signals` table here. Saved-search signals are PROJECTED from discovered_leads
-- at read time rather than duplicated into a second store (plan §4.2a). A dual-write would need the
-- two kept in sync on every status change, which is the exact shape that has bitten this codebase
-- before (the Threads/YouTube dual-store bridge; the two asset tables that get confused). The
-- `signals` table arrives in Phase 1b and owns social engagements only — because nothing else
-- stores those.
--
-- Apply manually via scripts/db-migrate.mjs — no drizzle-kit push (see docs/db-migrations.md).
-- Idempotent: both columns are ADD COLUMN IF NOT EXISTS. Safe to run repeatedly.
--
-- ⚠️ APPLY THIS BEFORE DEPLOYING THE ACCOMPANYING CODE — it is NOT optional, and the failure is a
-- REGRESSION to a feature that already worked. Applying early is safe (both columns are nullable
-- with no default and every existing reader ignores them). Deploying early is NOT:
--   • discovery-campaigns.ts has no try/catch, and its `list`/`create`/`edit` actions all reference
--     `name` — without the column the "Find New Leads" modal 500s. This is the one that hurts.
--   • signal-inbox.ts degrades gracefully (returns MIGRATION_PENDING).
--   • process-discovery-jobs.ts degrades gracefully (publishSignals is wrapped).
-- This bit prod on 2026-08-02: both migrations were run twice against STAGING, because
-- scripts/db-migrate.mjs defaults to the local .env database and that database IS staging
-- (ep-blue-truth). IF NOT EXISTS made the second run report success. Two green runs, one database.
-- For prod, always pass the connection explicitly:
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only signal-inbox-1a --url-var PROD_DATABASE_URL --yes

ALTER TABLE discovery_campaigns
  ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE discovery_jobs
  ADD COLUMN IF NOT EXISTS signals_published_at timestamp;

-- The publisher claims completed-but-unpublished runs with this predicate on every tick, so it is
-- worth an index even though the table is small — it will grow one row per run per campaign forever.
CREATE INDEX IF NOT EXISTS discovery_jobs_unpublished_idx
  ON discovery_jobs (status, signals_published_at)
  WHERE signals_published_at IS NULL;

-- ── Verify (run manually after applying) ─────────────────────────────────────
--   SELECT column_name, is_nullable, data_type
--     FROM information_schema.columns
--    WHERE (table_name = 'discovery_campaigns' AND column_name = 'name')
--       OR (table_name = 'discovery_jobs'      AND column_name = 'signals_published_at');
--   -- expect 2 rows, both is_nullable = YES
--
-- Existing campaigns are unnamed by design — confirm the UI falls back rather than showing blanks:
--   SELECT count(*) FILTER (WHERE name IS NULL) AS unnamed, count(*) AS total FROM discovery_campaigns;
