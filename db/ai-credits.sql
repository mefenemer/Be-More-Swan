-- AI Generation Credits (Epic 2, US4) — credit-based consumption for native AI media generation.
--
-- Two tables:
--   ai_credit_balance  — one row per org: spendable balance + credits held by in-flight jobs,
--                        plus monthly-grant bookkeeping and autonomous-spend tracking (US5 cap).
--   ai_credit_ledger   — append-only audit of economic events (grants +, successful debits -,
--                        admin adjustments). Holds and hold-refunds are transient balance moves
--                        and are intentionally NOT ledgered — credits are only "spent" (and
--                        ledgered) on SUCCESSFUL generation (US4 AC: no deduction on failure).
--
-- Credit policy (decided 2026-06-24): monthly allowance ROLLS OVER — at the first generation of
-- a new UTC month the active plan's master_plans.features.monthly_ai_credits is ADDED to the
-- existing balance, so unused credits carry forward. See src/utils/ai-credits.ts.
--
-- Idempotent: safe to re-run. Apply manually as the DB owner (no drizzle-kit push — see the
-- no-db:push rule; raw-SQL RLS policies must not be clobbered).

CREATE TABLE IF NOT EXISTS ai_credit_balance (
  organisation_id          INTEGER PRIMARY KEY REFERENCES organisations(id) ON DELETE CASCADE,
  balance                  INTEGER NOT NULL DEFAULT 0,   -- spendable credits
  held                     INTEGER NOT NULL DEFAULT 0,   -- reserved by in-flight generation jobs
  last_granted_period      DATE,                          -- first-of-month (UTC) the monthly grant last applied
  -- US5: autonomous (assistant-driven) spend cap tracking, reset each period
  autonomous_period_start  DATE,
  autonomous_used          INTEGER NOT NULL DEFAULT 0,
  updated_at               TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT ai_credit_balance_nonneg CHECK (balance >= 0 AND held >= 0 AND autonomous_used >= 0)
);

CREATE TABLE IF NOT EXISTS ai_credit_ledger (
  id               SERIAL PRIMARY KEY,
  organisation_id  INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- actor (null for system/cron grants)
  delta            INTEGER NOT NULL,                                   -- +grant/+adjustment, -debit
  reason           TEXT NOT NULL,                                      -- see CHECK below
  job_id           INTEGER,                                            -- FK to media_generation_jobs.id (nullable; no hard FK — table created separately)
  balance_after    INTEGER,                                            -- balance snapshot post-event (audit)
  is_autonomous    BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT ai_credit_ledger_reason_check CHECK (reason IN (
    'monthly_grant', 'image_generation', 'video_generation', 'admin_adjustment'
  ))
);

-- Tenant-scoped audit lookups, newest first.
CREATE INDEX IF NOT EXISTS ai_credit_ledger_org_created_idx
  ON ai_credit_ledger (organisation_id, created_at DESC);
