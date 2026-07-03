# Pass to Developer — AI auto-fix runner

When an admin opens a reported issue in the **Testing → Issue Reports** panel of the admin
portal and clicks **🤖 Pass to Developer**, the issue is queued for an AI developer agent.
This document covers the local runner that does the actual fixing.

## How it works

```
Admin portal (cloud)                    Developer machine (this runner)
────────────────────                    ───────────────────────────────
Click "Pass to Developer"
  → issue.dev_handoff_status = queued
  → status = Fix In Progress
                                         npm run dev:issue-fixer  (polling)
                                           → claim oldest queued issue
                                           → git worktree off `staging`
                                           → claude -p (acceptEdits) edits files
                                           → commit + push + gh pr create
  issue ← POST result                    → report { ok, summary, branch, prUrl, sql? }
  → status = Fixed & Ready to Test
  → PR link + summary stored on the issue
  → reporter notified (in-app + email)
```

### When the fix needs a database change

This project never uses `drizzle-kit push` — schema changes ship as idempotent `db/*.sql`
applied by the DB owner. If a fix needs one, the runner asks Claude to (a) add the SQL to the
right `db/*.sql` file and `db/schema.ts`, and (b) emit the exact SQL between
`---SQL-MIGRATION-START---` / `---SQL-MIGRATION-END---` markers. The runner forwards that SQL
with the result, and then:

- The issue does **not** move to *Fixed & Ready to Test* and the reporter is **not** notified.
  It stays *Fix In Progress* with a 🗄️ **SQL to run** badge in the list.
- In the ticket, a **Database Migration** card shows the SQL. A **super-admin** reviews it
  (and may edit it), clicks **Run on staging Neon**, and sees the database's response inline.
- Only a **successful** run advances the issue to *Fixed & Ready to Test*, stores the DB
  output, and notifies the reporter. A failure is shown inline and the issue is left as-is.

The SQL runs on the deployment's owner connection (`NETLIFY_DATABASE_URL`, i.e. staging Neon on
the staging deploy) via the same simple-protocol path as `psql -f` — no implicit transaction
wrapper, so your idempotent files behave identically to a manual apply. Set
`MIGRATION_DATABASE_URL` on Netlify to run as a dedicated owner/migration role instead.
Executing migration SQL is gated to the `run_migration_sql` permission (**super-admin only**).

Every fix happens in a throwaway git worktree under the OS temp dir — your working tree is
never touched. The runner never commits to or pushes your current branch.

## Prerequisites

- This repo checked out, with `origin` set and the `staging` branch available.
- [`claude`](https://claude.com/claude-code) (Claude Code CLI) installed and authenticated.
- [`gh`](https://cli.github.com/) installed and authenticated (`gh auth login`).
- Node 18+.

## Setup

1. Set a shared secret on the Netlify deployment **and** locally — they must match:

   ```bash
   # Netlify env (and your local shell)
   DEV_HANDOFF_TOKEN=<a long random string>
   ```

   On Netlify: Site settings → Environment variables → add `DEV_HANDOFF_TOKEN`.
   Until this is set, the handoff endpoint returns 503 and the feature is disabled.

2. Apply the DB migration (adds the `dev_*` columns) as the DB owner:

   ```bash
   psql "$DATABASE_URL" -f db/issue-reports.sql   # idempotent — safe to re-run
   ```

3. Run the watcher:

   ```bash
   AURA_BASE_URL="https://staging--bemoreswan.netlify.app" \
   DEV_HANDOFF_TOKEN="…same token…" \
   npm run dev:issue-fixer
   ```

## Environment variables

| Var                | Required | Default                | Notes                                         |
|--------------------|----------|------------------------|-----------------------------------------------|
| `AURA_BASE_URL`    | yes      | —                      | Deployment to poll (staging URL, or localhost)|
| `DEV_HANDOFF_TOKEN`| yes      | —                      | Must match the Netlify env var                |
| `AURA_REPO`        | no       | this repo              | Path to the checkout to fix in                |
| `BASE_BRANCH`      | no       | `staging`              | Branch fixes are forked from / PR'd against   |
| `POLL_INTERVAL_MS` | no       | `15000`                | Idle poll cadence                             |
| `CLAUDE_BIN`       | no       | `claude`               | Claude Code CLI binary                        |
| `ONCE`             | no       | —                      | `ONCE=1` processes one issue then exits        |
| `RESUME_POLL_INTERVAL_MS` | no | `10000`             | Poll cadence while paused on a session limit  |

Plus, **on the Netlify deployment** (not the runner), optionally set `MIGRATION_DATABASE_URL` —
the owner/migration connection the ticket's "Run on staging Neon" button uses. Defaults to
`NETLIFY_DATABASE_URL` (the deploy's own owner DB).

## Notes & safety

- The runner uses `--permission-mode acceptEdits`, so Claude auto-applies file edits but
  cannot run arbitrary shell commands — all git/`gh` work is done by the script, not the model.
- If Claude produces no file changes, the issue is marked **failed** with the AI's notes and
  the admin is left a thread message; the visible status stays **Fix In Progress**.
- A failed `gh pr create` still pushes the branch — you'll see a warning in the log and the
  branch name is stored on the issue so you can open the PR manually.
- Run only one watcher per environment. (Claims are compare-and-swap, so a second instance is
  safe but unnecessary.)

## Claude session limits (pause & resume)

The runner fixes issues by shelling out to the Claude Code CLI, which has its own usage/session
limit. When that limit is hit, **no** fix can be produced — re-queueing an issue just fails again
immediately. So instead of burning the issue as a failure, the runner recovers gracefully:

1. On a session-limit error the runner **pauses** — it stops claiming, re-queues the issue it was
   on (so nothing is lost), and reports the block to the portal
   (`POST ?action=report-blocked`), including the reset time it parsed from the CLI error.
2. The **Issue Reports** panel shows an amber *"AI auto-fix runner paused — Claude session limit"*
   banner with the reset time and a **Resume runner** button (super-admin only).
3. On the **runner machine**, log into a Claude account with credit:

   ```bash
   claude        # then /logout if needed, and /login as the funded account
   ```

4. Press **Resume runner** in the portal. That flags `resume_requested`; the runner (the only
   thing that can reach the CLI) runs a cheap probe call to verify the new login:
   - **Probe passes** → the runner clears the block, resumes, and the re-queued issue is
     re-claimed automatically. No need to re-submit anything.
   - **Probe still limited** → the banner shows *why* and waits for you to log in properly and
     press Resume again.

The runner polls for the resume signal every `RESUME_POLL_INTERVAL_MS` (default 10s) while paused,
which also serves as a liveness heartbeat (`dev_runner_status.last_seen_at`). The portal never
authenticates Claude itself — it can't reach the runner machine — and no Claude credential is ever
stored; `dev_runner_status` only coordinates the human-in-the-loop re-login. Requires
`db/issue-reports.sql` applied (it adds the `dev_runner_status` table).
