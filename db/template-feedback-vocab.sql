-- db/template-feedback-vocab.sql
-- Plan §2.6 (the ⭐ option) — close the `template_feedback.edit_reason` vocabulary.
--
-- The table was created by db/lead-threads.sql in Phase 2a with `edit_reason text` and NO
-- constraint. That was a gap, not a choice: `edit_reason` is the GROUP BY key for the entire
-- edit-pattern proposer (docs/strategy-agent-plan.md §4.1), and free text cannot be clustered — the
-- same argument that makes LOSS_REASONS a closed vocabulary.
--
-- ⚠️ TIMING. This is free to apply ONLY while the table is empty. `template_feedback` has had zero
-- writers since it was created, so there is nothing to clean up today. Once §2.6 starts writing,
-- adding this constraint becomes a migration with a data-repair step in front of it.
--
-- Vocabulary source of truth: src/config/template-feedback.ts EDIT_REASONS. The list appears in
-- THREE places (that file, db/schema.ts check(), and here); nothing across the TS/SQL boundary
-- enforces agreement, so tests/template-feedback.test.ts parses all three and asserts they match.
--
-- Apply manually via scripts/db-migrate.mjs. For PROD, pass the connection explicitly — the runner
-- defaults to the local .env database and that database IS staging:
--   export PROD_DATABASE_URL=$(netlify env:get NETLIFY_DATABASE_URL --context production)
--   npm run db:migrate:apply -- --only template-feedback-vocab --url-var PROD_DATABASE_URL --yes
--
-- ── Deploy ordering ─────────────────────────────────────────────────────────
-- APPLY BEFORE DEPLOY. The writer (src/utils/template-feedback.ts) validates against the same
-- vocabulary before inserting, so a code-first deploy cannot write a value this rejects — but it
-- would leave a window where the constraint is absent and the guarantee rests on the application
-- alone. Order it properly rather than relying on that.

BEGIN;

-- Guard: refuse to add the constraint if rows already violate it, rather than failing halfway with
-- a bare constraint error. An empty table is the expected state; anything else needs a human.
DO $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad
    FROM template_feedback
   WHERE edit_reason IS NOT NULL
     AND edit_reason NOT IN (
       'too_formal','too_casual','wrong_value_prop','wrong_pain_point',
       'too_long','factually_wrong','bad_subject','personalisation_missing','other');
  IF bad > 0 THEN
    RAISE EXCEPTION
      'template_feedback has % row(s) with an edit_reason outside the vocabulary. Map or clear them before applying this migration.', bad;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'template_feedback_edit_reason_check') THEN
    ALTER TABLE template_feedback ADD CONSTRAINT template_feedback_edit_reason_check
      CHECK (edit_reason IS NULL OR edit_reason IN (
        'too_formal','too_casual','wrong_value_prop','wrong_pain_point',
        'too_long','factually_wrong','bad_subject','personalisation_missing','other'));
  END IF;
END $$;

COMMIT;

-- ── Verify ──────────────────────────────────────────────────────────────────
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint WHERE conrelid = 'template_feedback'::regclass;
--
-- Prove it both accepts good values and rejects bogus ones without leaving test rows — wrap an
-- INSERT in a transaction that rolls back (docs/lead-generator-revenue-engine-plan.md §10).
