-- db/z-campaign-funnel-stage.sql — what a campaign is FOR in the funnel.
-- Design: docs/campaign-orchestrator-plan.md §9.6. Vocabulary: src/config/campaign-vocab.ts
-- (FUNNEL_STAGES, STAGE_OUTCOME_METRICS). Drizzle mirror: db/schema.ts (campaigns.funnelStage).
--
-- APPLY MANUALLY as the DB owner, to BOTH environments, BEFORE the code that reads it deploys.
-- Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only z-campaign-funnel-stage                              (staging)
--   npm run db:migrate:apply -- --only z-campaign-funnel-stage --url-var DATABASE_URL_PROD  (prod)
--
-- ⚠️ `z-` prefix: the runner sorts `-` before `.`, so a `campaign-…` name would run before
-- campaigns.sql on a fresh database. ⚠️ Deploy order: campaigns.ts `requireCampaign()` selects
-- every mirrored column, so the code must not reach a database without this column.
--
-- ── Why NOT NULL DEFAULT 'conversion' ───────────────────────────────────────
-- Every campaign created before this file existed was a lead campaign — `leads` was the default
-- outcome and the only order a plan could end in was a lead search or content in service of one.
-- 'conversion' is therefore the TRUE stage of every existing row, not a placeholder, and keeping
-- the column NOT NULL means no reader has to invent a meaning for "no stage".
--
-- ── Why the CHECK is inline ─────────────────────────────────────────────────
-- An inline, named constraint is created with the column and skipped with it on a re-run. A
-- separate DROP-then-ADD is the shape that once died half-way through a production migration and
-- silently skipped the rest of its file (migration-drop-then-add-constraint-trap).
--
-- No CHECK is added to outcome_metric: it never had one, and widening the metric list (engagement,
-- clicks, email_engagement) needs no DDL. The HTTP boundary validates it against the stage.

BEGIN;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS funnel_stage TEXT NOT NULL DEFAULT 'conversion'
  CONSTRAINT campaigns_funnel_stage_check
  CHECK (funnel_stage IN ('awareness','consideration','conversion','retention'));

COMMIT;

-- RLS: deliberately not enabled, as for every campaign table — see the foot of db/campaigns.sql.
