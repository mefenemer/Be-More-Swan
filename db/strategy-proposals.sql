-- db/strategy-proposals.sql
-- Phase 5a of docs/lead-generator-revenue-engine-plan.md (§7) — the Strategy Agent's proposal
-- store. Design + the four deltas against §7: docs/strategy-agent-plan.md §3.
--
--   strategy_proposals — one proposed change to one tunable field, awaiting a human decision.
--
-- ── What this table is NOT ──────────────────────────────────────────────────
-- It is not a queue of pending actions. A row here changes NOTHING anywhere until a human clicks
-- Apply having read the diff. `status='pending'` is inert by construction, and that inertness is
-- the whole safety argument of the phase (§5.2): the proposer is LLM-driven and its input includes
-- text written by third parties arriving through a public webhook, so the guarantee cannot come
-- from the prompt. It comes from the only thing the function can write being a row that does
-- nothing.
--
-- ── Four additions vs §7's sketch, each load-bearing ────────────────────────
--   1. `source`         — two producers exist (win/loss outcomes, edit patterns). MIN_SAMPLE means
--                         a different thing per source and the evidence blob has a different shape,
--                         so the screen cannot honestly label "34" without knowing which it counts.
--   2. partial unique   — §7 says "one change per run" but never "one PENDING proposal per field",
--      index              and the run is weekly. Left alone, a field the agent is confident about
--                         accumulates a pending proposal every week, each with a `previous_value`
--                         snapshotted against a different world. Applying them in any order gives a
--                         different final state, and applying the oldest LAST silently reverts the
--                         other three. The index makes that unrepresentable.
--   3. applied_at /     — rollback restores previous_value and stamps rolled_back_at; the row stays
--      rolled_back_at     'applied' so history still shows it happened. A separate status would
--                         make "was this ever applied?" a two-value question.
--   4. previous_value   — makes Apply reversible without reconstructing what the field used to say.
--
-- ── Vocabulary source of truth ──────────────────────────────────────────────
-- src/config/strategy-proposals.ts. Each list appears in THREE places (that file, db/schema.ts
-- check(), and here); nothing across the TS/SQL boundary enforces agreement, so
-- tests/strategy-proposals.test.ts parses all three and asserts they match — the same discipline
-- as revenue-events and template-feedback, for the same reason: a value added in one place only
-- becomes a constraint violation inside a module that swallows errors, i.e. invisible.
--
-- ⚠️ Mirror any change into db/schema.ts INCLUDING the check()s and the partial unique index, or a
-- later `drizzle-kit push` reverts them.
--
-- ── Deploy ordering: APPLY BEFORE DEPLOYING ─────────────────────────────────
-- The read API returns MIGRATION_PENDING when the table is absent and the tab renders a specific
-- message for it, so a code-first deploy degrades honestly rather than erroring — but a proposal
-- written against a missing CHECK is the failure mode from the reject→regeneration build. Apply
-- first.
--
-- Idempotent: guarded throughout, safe to run repeatedly.
--
-- Apply manually via scripts/db-migrate.mjs (psql is not installed here). The runner defaults to
-- the local .env database and that database IS staging:
--   npm run db:migrate:apply -- --only strategy-proposals --yes
-- For PROD, pass the connection explicitly — `--url-var` takes a variable NAME, not a URL:
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only strategy-proposals --url-var PROD_DATABASE_URL --yes

BEGIN;

CREATE TABLE IF NOT EXISTS strategy_proposals (
  id                serial PRIMARY KEY,
  organisation_id   integer NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  ai_assistant_id   integer REFERENCES ai_assistants(id) ON DELETE CASCADE,

  -- Which proposer produced this. 'human' is not a proposer: it is the synthetic source used when
  -- §2.6's "Save as the new default" routes a human's own edit through applyStrategyChange(), so a
  -- human save and an agent pivot share one apply path, one audit row and one rollback (§5.4).
  -- Present in the constraint from the start rather than migrated in when that action is wired.
  source            text NOT NULL,

  -- Must be a key of STRATEGY_TUNABLE_FIELDS. Never accepted as a free string from the model — the
  -- allow-list is a key lookup against a frozen map, which is what makes the "never" list real.
  target_field      text NOT NULL,
  previous_value    jsonb,
  proposed_value    jsonb NOT NULL,

  -- { sampleSize, segments[], metrics{}, eventIds[] } — computed in SQL by the persist path and
  -- NEVER taken from the model. A model that invents "sampleSize: 400" must not be able to launder
  -- it into the UI (§5.2).
  evidence          jsonb NOT NULL,

  status            text NOT NULL DEFAULT 'pending',

  -- A CLOSED vocabulary, because a reject reason is an INPUT, not a record: the next run's prompt
  -- receives prior rejections, so declining teaches the loop rather than being a dead end.
  reject_reason     text,
  reject_note       text,                       -- free text, for humans; never fed to the model
  decided_by        integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at        timestamp,

  applied_at        timestamp,
  rolled_back_at    timestamp,

  -- Never auto-applies; lapses instead. The expiry sweep runs inside the weekly proposer run.
  expires_at        timestamp NOT NULL,
  created_at        timestamp NOT NULL DEFAULT now()
);

-- The review screen's only query: this org's proposals, newest first, filtered by status.
CREATE INDEX IF NOT EXISTS strategy_proposals_org_status_idx
  ON strategy_proposals (organisation_id, status, created_at);

-- ⚠️ LOAD-BEARING (see header note 2). At most one PENDING proposal per field per org.
-- The proposer must catch the conflict and SKIP rather than error: a run that dies on a duplicate
-- stops proposing for every other org in the batch.
CREATE UNIQUE INDEX IF NOT EXISTS strategy_proposals_pending_field_uidx
  ON strategy_proposals (organisation_id, target_field)
  WHERE status = 'pending';

-- ── Constraints ─────────────────────────────────────────────────────────────
-- Added separately and guarded, so re-running against an existing table repairs a missing
-- constraint rather than silently leaving it off (CREATE TABLE IF NOT EXISTS would skip it).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_proposals_status_check') THEN
    ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_status_check
      CHECK (status IN ('pending','applied','rejected','expired'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_proposals_source_check') THEN
    ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_source_check
      CHECK (source IN ('win_loss','edit_pattern','human'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_proposals_reject_reason_check') THEN
    ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_reject_reason_check
      CHECK (reject_reason IS NULL OR reject_reason IN (
        'sample_unrepresentative','already_tried','wrong_causation','off_brand',
        'bad_timing','too_narrow','too_broad','other'));
  END IF;

  -- A rejected proposal without a reason is a dead end rather than feedback — the whole point of
  -- the closed vocabulary is that declining teaches the next run.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_proposals_rejected_has_reason_check') THEN
    ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_rejected_has_reason_check
      CHECK (status <> 'rejected' OR reject_reason IS NOT NULL);
  END IF;

  -- Rollback is only meaningful for something that was applied. Guards the read path: the UI
  -- decides "can this be rolled back?" from applied_at IS NOT NULL AND rolled_back_at IS NULL.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'strategy_proposals_rollback_requires_apply_check') THEN
    ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_rollback_requires_apply_check
      CHECK (rolled_back_at IS NULL OR applied_at IS NOT NULL);
  END IF;
END $$;

COMMIT;
