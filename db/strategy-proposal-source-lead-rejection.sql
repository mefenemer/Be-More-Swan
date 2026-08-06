-- db/strategy-proposal-source-lead-rejection.sql
-- Admit 'lead_rejection' to the strategy_proposals source vocabulary.
--
-- The third agent proposer: `edit_pattern` asks what was wrong with the MESSAGE, `lead_rejection`
-- what was wrong with the targeting that surfaced the lead at all. Its evidence is
-- lead_reject_feedback (db/lead-reject-feedback.sql), which must exist first.
--
-- Vocabulary source of truth: src/config/strategy-proposals.ts PROPOSAL_SOURCES. Declared in TWO
-- places (that file and the CHECK created by db/strategy-proposals.sql); tests/strategy-agent.test.ts
-- asserts they agree.
--
-- Apply manually via scripts/db-migrate.mjs. For PROD, pass the connection explicitly — the runner
-- defaults to the local .env database and that database IS staging:
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only strategy-proposal-source-lead-rejection --url-var PROD_DATABASE_URL --yes
--
-- ── Deploy ordering ─────────────────────────────────────────────────────────
-- APPLY BEFORE DEPLOY. proposeChange() validates the source against PROPOSAL_SOURCES and would
-- happily pass 'lead_rejection' to an INSERT the old CHECK rejects. That failure is swallowed
-- (proposeChange returns null and logs), so the run would report "the writer refused the proposal"
-- every week with no other symptom.

BEGIN;

-- Widen rather than recreate blindly: DROP + ADD in one transaction so the table is never briefly
-- unconstrained, and so a re-run is a no-op rather than an error.
ALTER TABLE strategy_proposals DROP CONSTRAINT IF EXISTS strategy_proposals_source_check;

ALTER TABLE strategy_proposals ADD CONSTRAINT strategy_proposals_source_check
  CHECK (source IN ('win_loss','edit_pattern','lead_rejection','human'));

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname = 'strategy_proposals_source_check';
--
-- Widening a CHECK cannot invalidate an existing row — every value the old constraint allowed is
-- still allowed — so unlike db/lead-reject-feedback.sql this needs no pre-flight data guard.
