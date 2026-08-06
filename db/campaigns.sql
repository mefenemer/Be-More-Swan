-- db/campaigns.sql — Campaign Assistant (roleKey `campaign_orchestrator`), Phase 1.
-- Design: docs/campaign-orchestrator-plan.md. Drizzle mirror: db/schema.ts
-- (campaigns / campaignBudgets / campaignOrders / campaignSpendEvents / campaignDecisions).
--
-- APPLY MANUALLY as the DB owner (project convention — new db/*.sql are not pushed by
-- drizzle-kit, and raw-SQL RLS policies must not be clobbered). Idempotent: safe to re-run.
--   npm run db:migrate:apply -- --only campaigns
--
-- ── What this models ─────────────────────────────────────────────────────────
-- A campaign is an allocation of TWO budgets against one objective:
--   * work  — pieces of work commissioned from other assistants: posts drafted, articles
--             written, searches run. One work item == one artefact we can point at. This is the
--             ONLY budget Phase 1 spends, and campaign_spend_events is its complete ledger.
--   * money — the customer's own external ad account. Phase 3, blocked on Meta / LinkedIn /
--             Google approvals we do not control (plan §1.1). Every money column below exists
--             and is CHECK-pinned to zero for organic campaigns so the Phase 3 code has nowhere
--             to drift to. Do NOT relax those checks to "make paid work" — see §1.3.
--
-- ⚠️ A WORK ITEM IS NOT A BILLING "TASK". The plan's monthly task allowance lives in
-- usage_counters.task_count and is incremented by atomicCapCheck — but only chat turns and a few
-- on-demand buttons go through it. The autonomous drafting engines (process-content-jobs.ts,
-- generate-post.ts, process-discovery-jobs.ts) do NOT call consumeTaskCredit, verified by reading
-- them 2026-08-06. So a campaign that commissions 50 posts moves usage_counters by ZERO, and
-- denominating the campaign budget in "tasks" would have put an authoritative-looking number in
-- front of the user that measures nothing — the same failure as a goal progress bar wired to
-- nothing. Work items are the orchestrator's own unit of account and this table is their only
-- ledger. The plan cap is read separately, as a GATE, and is labelled as a different thing.
-- If the drafting engines ever start metering, do not merge the two units — reconcile them.
--
-- The orchestrator produces nothing itself. Its artefacts are ORDERS to other assistants, and
-- DECISIONS a human is asked to approve. Both are mirrored into assistant_records so the existing
-- Data Hub and Review Queue render them with no new client renderer — same pattern as
-- discovered_leads. The tables below stay the source of truth; the mirror is a view surface.
-- Widening the assistant_records CHECKs for those two record types is db/campaign-records.sql.

BEGIN;

-- ── Campaigns ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaigns (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id       INTEGER NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- The objective in the founder's own words. This is the campaign's real identity and the
  -- thing the blueprint directive quotes verbatim into generation — keep it human.
  objective             TEXT NOT NULL,
  -- What "done" counts as. Closed vocabulary mirrored in src/config/campaign-vocab.ts.
  outcome_metric        TEXT NOT NULL DEFAULT 'leads',
  target_value          INTEGER,

  -- 'organic' is the only mode Phase 1 can create. 'paid'/'blended' are declared so the Phase 3
  -- code has a value to write, and are refused at the HTTP boundary until the rails exist.
  mode                  TEXT NOT NULL DEFAULT 'organic',
  status                TEXT NOT NULL DEFAULT 'draft',

  starts_at             TIMESTAMP,
  ends_at               TIMESTAMP,

  -- What the human has already turned down, as counts per reason. This is where the Reject button
  -- lands and where the next proposal reads from — see src/config/campaign-reject-reasons.ts.
  -- Counts rather than prose, because "four rejections for the same reason" has to survive as a
  -- number. Without this column the reject flow would be a status flip that teaches nothing.
  constraints           JSONB NOT NULL DEFAULT '{"rejections":{},"notes":[]}'::jsonb,

  -- Why it stopped, when it stopped itself. NULL while running. Paired with the resume path in
  -- the UI: a pause with no recorded reason is a pause nobody can safely undo.
  halt_reason           TEXT,
  halted_at             TIMESTAMP,

  -- Set when a human uses "Stop everything". Distinguishes an operator halt from a guardrail
  -- halt, because only one of them should resume automatically (neither does, but the campaign
  -- list has to be able to SAY which happened).
  halted_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,

  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_mode_check
    CHECK (mode IN ('organic','paid','blended')),
  CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft','active','throttled','paused','finished','archived')),
  -- A stopped campaign must say why. 'throttled' is excluded deliberately: throttling is the
  -- agent optimising and the campaign is still running, so it is not a halt.
  CONSTRAINT campaigns_halt_reason_check
    CHECK (status <> 'paused' OR halt_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS campaigns_assistant_idx
  ON campaigns (organisation_id, ai_assistant_id, status);
-- The dispatcher's hot path: campaigns eligible to act.
CREATE INDEX IF NOT EXISTS campaigns_active_idx
  ON campaigns (status, ends_at) WHERE status IN ('active','throttled');

-- ── Budgets: the two ceilings, one row per campaign ──────────────────────────
CREATE TABLE IF NOT EXISTS campaign_budgets (
  id                        SERIAL PRIMARY KEY,
  organisation_id           INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id               INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  -- WORKLOAD — the budget Phase 1 actually spends. Counted in artefacts, not billing tasks.
  max_work_items                 INTEGER NOT NULL DEFAULT 100,

  -- MONEY — Phase 3. Pinned to 0.00 for organic campaigns by the check below, which is the
  -- database half of "a £0 campaign can never spend". The HTTP boundary is the other half.
  max_spend_gbp             NUMERIC(10,2) NOT NULL DEFAULT 0.00,

  -- Autonomy. A reallocation costing at or below this many work items happens on its own;
  -- anything larger becomes a decision the human sees. 0 = propose everything, nothing automatic.
  autonomy_threshold_work  INTEGER NOT NULL DEFAULT 0,

  -- Runaway guards. Optimisation is a divergent process — a loop that reallocates every tick
  -- burns the whole allowance on churn. Both are enforced in the reallocation path, not here.
  max_reallocations_per_day INTEGER NOT NULL DEFAULT 3,
  min_reallocation_work    INTEGER NOT NULL DEFAULT 3,

  created_at                TIMESTAMP NOT NULL DEFAULT now(),
  updated_at                TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaign_budgets_max_work_check
    CHECK (max_work_items > 0),
  CONSTRAINT campaign_budgets_spend_nonneg_check
    CHECK (max_spend_gbp >= 0),
  CONSTRAINT campaign_budgets_autonomy_check
    CHECK (autonomy_threshold_work >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_budgets_campaign_uidx
  ON campaign_budgets (campaign_id);

-- The organic-money lock. Written as a trigger-free cross-table rule via a CHECK on a generated
-- comparison is not possible in Postgres, so it lives as a constraint trigger instead: the one
-- invariant worth paying for is "an organic campaign cannot carry a non-zero money ceiling".
CREATE OR REPLACE FUNCTION campaign_budgets_organic_is_free() RETURNS trigger AS $$
BEGIN
  IF NEW.max_spend_gbp <> 0 AND EXISTS (
    SELECT 1 FROM campaigns c WHERE c.id = NEW.campaign_id AND c.mode = 'organic'
  ) THEN
    RAISE EXCEPTION 'campaign % is organic: max_spend_gbp must be 0.00', NEW.campaign_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_budgets_organic_is_free_trg ON campaign_budgets;
CREATE TRIGGER campaign_budgets_organic_is_free_trg
  BEFORE INSERT OR UPDATE ON campaign_budgets
  FOR EACH ROW EXECUTE FUNCTION campaign_budgets_organic_is_free();

-- ── Orders: the instruction to another assistant ─────────────────────────────
-- The orchestrator's only output. Every row names a target assistant, what it was asked for,
-- what it cost in each currency, and the artefact that came back — so the chain
-- objective → order → artefact → outcome is one join, not a reconstruction.
CREATE TABLE IF NOT EXISTS campaign_orders (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  -- The colleague. Nullable assistant id (the instance can be deleted) but the role key is kept
  -- so a delivered order still reads correctly afterwards.
  target_assistant_id   INTEGER REFERENCES ai_assistants(id) ON DELETE SET NULL,
  target_role_key       TEXT NOT NULL,

  -- Closed vocabulary; mirrored in src/config/campaign-vocab.ts and asserted by a test.
  action                TEXT NOT NULL,
  -- The brief: keywords, persona, CTA, tone, counts. Read by the target assistant's generation
  -- path via the blueprint directive, not by the target's own UI.
  brief                 JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- What it was quoted at, in both currencies. cost_gbp stays 0.00 for the whole of Phase 1.
  cost_work_items            INTEGER NOT NULL DEFAULT 0,
  cost_gbp              NUMERIC(10,2) NOT NULL DEFAULT 0.00,

  status                TEXT NOT NULL DEFAULT 'queued',
  -- Set when status='blocked': the order this one is waiting on (teasers behind a pillar).
  blocked_on_order_id   INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL,

  -- What came back. artefact_kind names the table so the client can build the right link
  -- without a polymorphic join it would get wrong — see the vector_embeddings lesson.
  artefact_kind         TEXT,     -- 'scheduled_post' | 'blog_post' | 'discovery_campaign' | 'assistant_record'
  artefact_id           INTEGER,
  result_summary        TEXT,

  -- The Data Hub mirror row. Nullable: the mirror is best-effort and must never fail the order.
  assistant_record_id   INTEGER REFERENCES assistant_records(id) ON DELETE SET NULL,

  issued_at             TIMESTAMP,
  delivered_at          TIMESTAMP,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaign_orders_status_check
    CHECK (status IN ('queued','issued','in_review','delivered','blocked','cancelled','rejected')),
  CONSTRAINT campaign_orders_cost_check
    CHECK (cost_work_items >= 0 AND cost_gbp >= 0),
  CONSTRAINT campaign_orders_artefact_check
    CHECK (artefact_kind IS NULL OR artefact_kind IN ('scheduled_post','blog_post','discovery_campaign','assistant_record')),
  -- An order cannot block on itself.
  CONSTRAINT campaign_orders_no_self_block_check
    CHECK (blocked_on_order_id IS NULL OR blocked_on_order_id <> id)
);
CREATE INDEX IF NOT EXISTS campaign_orders_campaign_idx
  ON campaign_orders (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_orders_org_idx
  ON campaign_orders (organisation_id, created_at);
-- "What is this assistant currently on the hook for?" — the Campaigns tab's live line.
CREATE INDEX IF NOT EXISTS campaign_orders_target_idx
  ON campaign_orders (target_assistant_id, status);

-- ── Spend events: APPEND-ONLY ────────────────────────────────────────────────
-- One row per unit of either budget actually consumed. Append-only on purpose: a correction is a
-- new compensating row, never an edit, so the ledger can always be replayed. The same rule the
-- revenue ledger settled on — history that can be rewritten cannot be audited.
CREATE TABLE IF NOT EXISTS campaign_spend_events (
  id                    BIGSERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  order_id              INTEGER REFERENCES campaign_orders(id) ON DELETE SET NULL,

  -- 'work' | 'money'. Kept as separate rows rather than two columns so a query never has to
  -- decide which of two amounts is meaningful.
  currency              TEXT NOT NULL,
  -- Signed. A negative amount is a refund/compensation (a cancelled order releasing its quote).
  amount                NUMERIC(12,2) NOT NULL,
  reason                TEXT NOT NULL,
  occurred_at           TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaign_spend_currency_check
    CHECK (currency IN ('work','money'))
);
CREATE INDEX IF NOT EXISTS campaign_spend_campaign_idx
  ON campaign_spend_events (campaign_id, currency, occurred_at);

-- ── Decisions: what the human is asked to approve ────────────────────────────
-- Anything above the campaign's autonomy threshold lands here instead of happening. Mirrored into
-- assistant_records (record_type 'campaign_decision', approval_status 'pending_approval') so the
-- existing Review Queue renders it.
CREATE TABLE IF NOT EXISTS campaign_decisions (
  id                    SERIAL PRIMARY KEY,
  organisation_id       INTEGER NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  campaign_id           INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,

  kind                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  -- Why it believes this. Rendered as the card's "The evidence" list. Structured so the numbers
  -- stay checkable rather than being prose a model can drift.
  evidence              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The orders it would place if approved. Applied verbatim — the model does not get a second
  -- turn between approval and execution.
  proposed              JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What happens if the user does nothing. A decision card without this is a demand, not a choice.
  cost_of_inaction      TEXT,

  cost_work_items            INTEGER NOT NULL DEFAULT 0,
  cost_gbp              NUMERIC(10,2) NOT NULL DEFAULT 0.00,

  status                TEXT NOT NULL DEFAULT 'pending',
  -- Closed vocabulary; see src/config/campaign-reject-reasons.ts. The whole point of the reject
  -- flow is that this column is a GROUP BY key, so free text is not allowed here.
  reject_reason         TEXT,
  reject_note           TEXT,

  -- Every decision expires. An 8-week-old proposal built on 8-week-old evidence is not a
  -- decision the user should be able to approve by scrolling far enough down.
  expires_at            TIMESTAMP NOT NULL,
  decided_at            TIMESTAMP,
  decided_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,

  assistant_record_id   INTEGER REFERENCES assistant_records(id) ON DELETE SET NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT now(),
  updated_at            TIMESTAMP NOT NULL DEFAULT now(),

  CONSTRAINT campaign_decisions_kind_check
    CHECK (kind IN ('strategy','reallocation','escalation','halt')),
  CONSTRAINT campaign_decisions_status_check
    CHECK (status IN ('pending','approved','rejected','expired','superseded')),
  -- A rejection must carry a reason. This is the constraint that makes the feedback loop real
  -- rather than optional: without it, "reject" degrades to a status flip that teaches nothing,
  -- which is exactly what happened to lead rejection.
  CONSTRAINT campaign_decisions_reject_reason_check
    CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS campaign_decisions_campaign_idx
  ON campaign_decisions (campaign_id, status);
-- The Review Queue badge count, and the expiry sweeper.
CREATE INDEX IF NOT EXISTS campaign_decisions_pending_idx
  ON campaign_decisions (organisation_id, status, expires_at) WHERE status = 'pending';

COMMIT;

-- ── Row-level security: deliberately NOT enabled here ────────────────────────
-- RLS in this codebase is a separate, phased system that lives in db/rls/ — it needs the
-- least-privilege `app_user` role (db/rls/00-app-user-role.sql) and queries routed through
-- withTenant(), which sets `app.current_org`. The application connects as the table OWNER, and an
-- owner BYPASSES RLS, so enabling policies on these tables from this file would add a policy that
-- never evaluates while reading as though the tables were protected by the database. That is worse
-- than no policy: it invites the next reader to skip the application-level check.
--
-- Tenant isolation for these five tables is enforced in application code, exactly as it is for the
-- discovery_* and revenue_events tables: every action in netlify/functions/campaigns.ts goes
-- through requireTenant() and every query is scoped by organisation_id, with an explicit ownership
-- (IDOR) re-check on any id supplied by the caller.
--
-- Promoting them into RLS is an R-phase decision: add the five table names to the array in
-- db/rls/R1-crown-jewels.sql (which uses NULLIF(current_setting('app.current_org', true), '')::int
-- and carries both USING and WITH CHECK), and do it in the same change that routes these queries
-- through withTenant. Do not half-do it.
