# Fix pipeline: worked by Claude in an interactive session (owner decision, 2026-11-13)

Replaces the GitHub Actions "AI developer" (`ai-fix.yml`, "Pass to Developer", "Redo fix"), which could only
read code and mostly guessed. It was **removed on 2026-11-13** (owner: inferior). Claude in an interactive session can see the real system (deployed commits, the databases,
GitHub, the browser), run the tests and iterate, so the quality matches a normal session. The pipeline is
kept for what it is good at: holding the ticket, its status and the evidence.

## The process

1. **Issues are reported** (by users or automatically) and land in Admin ▸ Fix pipeline as **Reported**.
2. **The owner tells Claude to work them**, in a Claude Code session ("work the Reported tickets", or a list).
3. **Claude works each ticket**, recording everything on it as it goes, with `scripts/fix-tickets.ts`:
   - `start <id>`: Reported → **Investigation In Progress** (the reporter sees this), held by "Claude (interactive)".
   - Investigates against the real system. `note <id>` records findings.
   - `fixing <id>`: cause found → **Fix In Progress**.
   - Writes the fix **and a repro test** (`tests/repro-issue-<id>.test.ts`, or `e2e/repro-issue-<id>.spec.ts`
     when a page shows the fault), runs it **before and after** the fix, and records the result:
     `proof <id> --root-cause confirmed|guessed|not_found --test … --before … --after …`.
     "Confirmed" is refused unless the test failed before and passes after.
   - Opens a PR into staging, then `pr <id>` → **Merge** (PR, summary and any SQL recorded).
   - `staging-sql <id>` puts additive SQL on the staging DB and checks it (ticket row "SQL on staging").
   - Merges the PR into staging, then `merged <id>`; `sync <id>` follows staging CI and the staging deploy.
   - Can't fix it? `status <id> more_info_required|on_hold|closed --file <why>` (`on_hold` shows as **Waiting on
     Others**: blocked on someone outside, e.g. Meta).
4. **The ticket's "Ready for production?" checklist** then shows root cause, repro test, SQL safety, SQL on
   staging, tests on staging and live on staging.
5. **The owner ships to production.** Prod SQL first ("SQL on production" row): Approve for production runs
   it itself; for a staging → main release, Claude runs `prod-sql <id>` only when the owner says to ship,
   just before the merge (additive SQL is safe ahead of the code).
6. **The owner ships the code**: **Approve for production** on the ticket (runs the same SQL on prod,
   then merges the one fix into main once its checks pass), or a staging → main release PR.

## What the admin sees

- A pulsing **🛠️ Claude working** pill on the board card and the open ticket while Claude holds it (every step
  refreshes it; it clears after the merge to staging, on `status`, on `release`, or 30 minutes after the last step).
- The Fix pipeline screen refreshes itself within about 15 seconds of any change (it checks a version stamp;
  the open ticket is not redrawn while you are typing in it).

## PR pills and the Approve button (owner, 2026-11-13)

- **Pills**: "Staging PR #N" (`dev_pr_url`, set by `pr`) and "Prod PR #N" (`prod_pr_url`, or a hotfix PR) show on
  the board card and at the top of the open ticket as soon as they are recorded; each opens the PR on GitHub.
  `prod-pr <id> --pr <url>` records a PR into main (e.g. the staging → main release that carries the fix).
- **Approve**: when Claude wants the owner to approve a PR, `ask-approval <id> --pr <url> [--file why.md]`. The
  card and ticket then show **✅ Approve prod|staging PR #N**. The click approves it on GitHub where GitHub allows
  (never on your own PR, which is every PR Claude opens as you; main needs 0 reviews, so the merge is the gate),
  merges it (or turns on auto-merge while checks run), moves the ticket on (staging → merged to staging; main →
  "Merged to prod", then the live check moves it to Fixed & Ready to Test) and hides the button.
  `withdraw-approval <id>` hides it without merging. A fix's SQL must already be on that PR's database.
- Setup: `db/z-pr-approval.sql` on BOTH DBs; Netlify `GITHUB_PR_APPROVE_TOKEN` (fine-grained, this repo:
  Contents + Pull requests read/write), else it falls back to `GITHUB_HOTFIX_TOKEN`. Code: `src/utils/pr-approval.ts`.

## Rules

- **Claude never contacts the reporter.** Its notes have no author, so the reporter's Issues page never
  shows them, and the tool never sends a notification. The reporter only sees the ticket's status. The owner
  does all communication.
- `--env prod` or `--env staging` is always required; there is no default database.
- Additive SQL only runs automatically; anything else is shown to the owner to run by hand.
- Claude never presses Approve for production and never merges to main.

## Still automatic (owner to decide)

The hourly live check (`src/utils/issue-fix-live.ts`) still tells the reporter "fixed and live" when the
prod deploy contains the fix, and closes a ticket 7 days later with a last notification. Those are the
system's messages, not Claude's.

## Statuses (owner, 2026-11-13)

Reported → Investigation In Progress → Fix In Progress → Merge → (Fixed & Ready to Test, set by the live check)
→ Closed. Side states: More Info Required (waiting on the reporter), Waiting on Others (`on_hold`: waiting on
someone outside), On Roadmap. **Backlog was removed** (`db/z-issue-remove-backlog.sql` moves any to Reported).

## Database

`db/z-issue-investigating.sql` adds the Investigation In Progress status (both DBs, run by the owner). Until it
runs, `start` uses Fix In Progress and says so.

## Access

Prod reads and writes through this tool need an allow rule in the Claude Code settings:
`Bash(npx tsx scripts/fix-tickets.ts --env prod:*)`.
