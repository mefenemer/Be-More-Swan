-- db/z-retire-laptop-runner.sql — release work the retired laptop runner left unfinished.
--
-- The laptop runner (scripts/dev-issue-fixer.mjs and its endpoint admin-issue-handoff.ts) was
-- retired on 2026-11-12. Fixes and merges now run in GitHub Actions (src/utils/issue-ai-fix.ts,
-- src/utils/issue-cloud-merge.ts); after a failed merge, "Redo fix on latest staging" runs the AI
-- fix again; "Open hotfix PR" replaced "Push to prod". Nothing sets the runner's states any more,
-- but rows it had queued or claimed may still carry them:
--
--   dev_handoff_status 'queued', or 'in_progress' held by a laptop  → 'failed' (pass it on again)
--   dev_merge_status   'queued', or 'merging' held by a laptop      → 'ready'  (merge it again)
--   dev_merge_status   'conflict_queued' / 'conflict_resolving'     → 'failed' (redo or merge again)
--   dev_prod_status    'queued' / 'promoting'                       → 'failed' (open a hotfix PR)
--
-- Each released row gets a note in its ticket thread (author_id NULL, so the reporter never sees
-- it). Rows held by GitHub Actions (dev_runner_id = 'GitHub Actions') are never touched.
--
-- OPTIONAL: the app already treats these leftovers as actionable (the panel shows what to do and the
-- endpoint lets them be started again), so nothing breaks without it. It just tidies the data.
-- Idempotent: a second run finds nothing to release. Safe on BOTH staging and prod, any time.

BEGIN;

WITH released AS (
  UPDATE issue_reports
     SET dev_handoff_status = 'failed',
         dev_result = 'Left unfinished by the laptop runner, which was retired on 2026-11-12. Pass it to the developer again: it now runs in GitHub Actions.',
         dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
   WHERE dev_handoff_status = 'queued'
      OR (dev_handoff_status = 'in_progress' AND dev_runner_id IS DISTINCT FROM 'GitHub Actions')
  RETURNING id
)
INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
SELECT id, 'admin', NULL, '♻️ The laptop runner was retired before it finished this fix. Pass it to the developer again: fixes now run in GitHub Actions.', NULL
  FROM released;

WITH released AS (
  UPDATE issue_reports
     SET dev_merge_status = 'ready',
         dev_merge_result = 'Left unfinished by the retired laptop runner. Merge to staging again: merges now run in GitHub Actions.',
         dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
   WHERE dev_merge_status = 'queued'
      OR (dev_merge_status = 'merging' AND dev_runner_id IS DISTINCT FROM 'GitHub Actions')
  RETURNING id
)
INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
SELECT id, 'admin', NULL, '♻️ The laptop runner was retired before it finished this merge. Merge to staging again: it now runs in GitHub Actions (a PR that already merged is simply confirmed).', NULL
  FROM released;

WITH released AS (
  UPDATE issue_reports
     SET dev_merge_status = 'failed',
         dev_merge_result = 'The laptop runner was retired before it resolved this merge conflict. Press “Redo fix on latest staging”, or try the merge again.',
         dev_runner_id = NULL, dev_runner_heartbeat = NULL, updated_at = now()
   WHERE dev_merge_status IN ('conflict_queued', 'conflict_resolving')
  RETURNING id
)
INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
SELECT id, 'admin', NULL, '♻️ The laptop runner was retired before it resolved this merge conflict. Press “Redo fix on latest staging” to have the AI developer write the fix again, or try the merge again.', NULL
  FROM released;

WITH released AS (
  UPDATE issue_reports
     SET dev_prod_status = 'failed',
         dev_prod_result = 'An old “Push to prod” request the retired laptop runner never finished. Open a hotfix PR instead, or ship it with the next staging → main PR.',
         updated_at = now()
   WHERE dev_prod_status IN ('queued', 'promoting')
  RETURNING id
)
INSERT INTO issue_report_messages (issue_id, author_type, author_id, body, status)
SELECT id, 'admin', NULL, '♻️ An old “Push to prod” request was cleared when the laptop runner was retired. Open a hotfix PR to ship just this fix, or let it go with the next staging → main PR.', NULL
  FROM released;

COMMIT;

-- Check afterwards (expect 0):
--   SELECT count(*) FROM issue_reports
--    WHERE dev_handoff_status = 'queued'
--       OR (dev_handoff_status = 'in_progress' AND dev_runner_id IS DISTINCT FROM 'GitHub Actions')
--       OR dev_merge_status IN ('queued', 'conflict_queued', 'conflict_resolving')
--       OR (dev_merge_status = 'merging' AND dev_runner_id IS DISTINCT FROM 'GitHub Actions')
--       OR dev_prod_status IN ('queued', 'promoting');
