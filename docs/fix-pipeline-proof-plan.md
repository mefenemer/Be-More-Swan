# Fix pipeline: proof before production — BUILT on staging (2026-11-12)

> ⚠️ 2026-11-13: the cloud AI developer (ai-fix.yml, its prove/publish jobs, screenshots from the repro run) was
> removed. Claude records the root cause and repro result from a session (docs/fix-pipeline-interactive.md).
> The checklist, staging SQL, Approve for production and the hotfix auto-merge below still apply.

Owner decisions (2026-11-12):
- **Proof = a reproduction test.** Claude writes a test that reproduces the reported fault. It must FAIL on
  the code before the fix and PASS after it. Only that upgrades the root cause from "Guessed" to "Confirmed".
- **Approve for production = SQL, then merge.** One click runs the SQL that already passed on staging against
  the prod DB, then merges that one fix into main. If the prod SQL fails, nothing merges.
- **Only additive SQL runs automatically:** CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
  INSERT … ON CONFLICT DO NOTHING (help articles), COMMENT. Anything else (DROP, DELETE, UPDATE, ALTER TYPE,
  DO $$ blocks, …) is refused and left for the owner to run by hand.
- The owner gives the final approval. Nothing reaches prod without that click.

## What the ticket shows before the owner approves

A "Ready for production?" checklist on every AI-fixed issue. **Approve for production** is enabled only when
the SQL and staging rows are green. Root cause and Repro test are shown as ⚠️ when not confirmed: the button
then asks a second time ("Approve anyway?"), because some faults (bad data on prod) can't be reproduced.

| Row | Green when | Set by |
|---|---|---|
| Root cause | **Confirmed** (the repro test failed before the fix and passes after). Otherwise **Guessed** or **Not found**, with Claude's evidence | ai-fix workflow |
| Repro test | `tests/repro-issue-<id>.test.ts` (Node) or `e2e/repro-issue-<id>.spec.ts` (browser) failed on the old code and passed on the fixed code. Not counted if it reads source files as text or failed only because new code was missing | ai-fix workflow (prove job, no secrets) |
| SQL safety | No SQL, or every statement is additive | app, when the PR is read |
| SQL on staging | Applied to the staging DB and its check query passed (or no SQL) | Merge to staging |
| Tests on staging | Staging CI ("Typecheck + tests", RLS) passed on the merge commit, which includes the repro test | app follows the staging CI run |
| Live on staging | The staging deploy's commit contains the fix | existing live check |

## Stages

1. **Pass to Developer** (ai-fix.yml), extended:
   - The prompt requires a `---ROOT-CAUSE---` block (status + evidence: file:line and how the reported
     symptom follows) and a repro test at `tests/repro-issue-<id>.test.ts` or `e2e/repro-issue-<id>.spec.ts`
     (top level, so staging CI keeps running it as a regression test).
   - Jobs: **fix** (Claude, file tools only) → **prove** (no secrets, read-only token: runs the repro test
     on staging as it was, then with the fix) → **publish** (opens the PR; never runs model code).
     Fail-then-pass → "Confirmed". Pass-before → it doesn't reproduce the fault → "Guessed".
     Fail-after → the fix doesn't work → no PR.
   - The results go into the PR body between markers; the app reads them into the issue as it already does
     for the summary and SQL.
2. **Merge to staging**, extended: before merging, the SQL (if any, and only if additive) runs on the
   **staging DB**, then a check query confirms the change exists (e.g. the column is there). If it fails,
   nothing merges. Fixes the bug found today: Run SQL used whichever site's DB it was clicked on and always
   said "staging".
3. **Staging proof**, new: the app follows the staging CI run on the merge commit and the staging deploy,
   and ticks the last two rows.
4. **Approve for production**, replaces "Open hotfix PR":
   1. Re-checks every row server side (the UI is not trusted).
   2. Runs the **same SQL text** (hash must match what passed on staging) on the prod DB, with the same
      check query. Fails → stop, thread the error, nothing merges.
   3. Starts hotfix-pr.yml (cherry-pick the one fix onto main), which now also merges the PR once main's
      required checks pass. A cherry-pick conflict (the fix depends on staging work not on main yet) fails
      cleanly and says "ship with the next release instead".
   4. The existing live check tells the reporter once prod is running it.

## Where SQL runs from

The Fix pipeline lives on the prod site (bemoreswan.com), so:
- **Prod SQL:** the prod function's own DB connection. No new secret.
- **Staging SQL:** a new Netlify env var `STAGING_DATABASE_URL` in the **production** context only.
- The staging site's own board (issues found on staging) keeps today's flow; Approve for production is
  shown only on the prod board.

## Data

`db/z-issue-fix-proof.sql`, on both DBs: issue_reports gains
`dev_root_cause_status` ('confirmed' | 'guessed' | 'not_found'), `dev_root_cause`, `dev_repro_result` (jsonb),
`dev_sql_safety` ('none' | 'additive' | 'manual'), `dev_sql_hash`, `dev_staging_sql_status/_result/_ran_at`,
`dev_staging_ci_status/_url`, `dev_prod_sql_status/_result/_ran_at`, `dev_prod_approved_by/_at`.
Existing `dev_sql_status` keeps meaning "pending → applied on staging".

## Owner setup (once)

- Netlify `STAGING_DATABASE_URL` (production context) = the staging Neon URL.
- Repo setting: allow auto-merge (Settings → General → Pull Requests), so a hotfix PR merges itself once
  its required checks pass.
- Run `db/z-issue-fix-proof.sql` on staging and prod (the last migration run by hand for this feature).

## As built (staging, 2026-11-12)

- `src/utils/issue-sql.ts` additive classifier, runner + checks, hash, which DB is which. Run SQL now uses the
  STAGING DB everywhere (it used the clicked site's DB and said "staging").
- `src/utils/issue-fix-proof.ts` proof block, checklist, ensureStagingSql, staging CI / deploy sync,
  screenshot import, approveForProduction. `netlify/functions/build-info.ts` (staging's commit).
- `.github/workflows/ai-fix.yml` fix → prove → publish; `hotfix-pr.yml` `auto_merge` input.
- `admin.html` "Ready for production?" card + Approve button; screenshots in the thread.
- Tests: issue-sql, issue-fix-proof, ai-fix-proof-workflow (runs the workflow's own scripts).
- ⚠️ Approve's auto-merge needs main's `hotfix-pr.yml` to have the new input, so it works only after this
  reaches main. Until then the dispatch answers 422 and the ticket says so.

## Build order (original)

1. SQL classifier + run-on-DB helper (additive allowlist, statement splitter, check query, hash) with tests.
   Fix the "Executed on staging" wording at the same time.
2. ai-fix.yml: root-cause block, repro test, the no-secrets repro job; PR body markers; app parsing.
3. Merge to staging runs staging SQL first; staging CI + deploy rows.
4. Approve for production endpoint + hotfix auto-merge.
5. Checklist UI on the issue panel and board card badge ("Confirmed" / "Guessed").

## Screenshots on the ticket (owner request 2026-11-12)

Claude in ai-fix.yml has file tools only, so it can't drive a browser itself. Instead:
- **As built:** Claude writes the repro as a Playwright spec (`e2e/repro-issue-<id>.spec.ts`, functions stubbed,
  no login needed) whenever a picture helps. The prove job runs it with `E2E_SCREENSHOT=on`, keeps the
  end-of-test screenshot before and after the fix in the run's `ai-fix-proof` artifact, and the app copies
  them into the ticket thread (`issue_report_messages.image_data/image_mime`, PNG ≤ 1.5 MB, up to 4).
- Screenshots are evidence for the owner, not a gate: a missing screenshot never blocks approval.
- The reporter's own screenshot is already passed to Claude (d3ccfe28).

Build order slot: after step 2 (it reuses the repro job).

## Limits

- The repro test runs in Node, not a browser against live staging. It proves the code fault, not every
  user-visible symptom. A browser repro against staging needs a staging test login; that is phase 2.
- Data-only faults (a row in a bad state on prod) can't be reproduced in CI; they show "Not found" and need
  the owner's judgement.
