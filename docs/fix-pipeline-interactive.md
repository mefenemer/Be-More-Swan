# Fix pipeline: worked by Claude in an interactive session (owner decision, 2026-11-13)

Replaces passing issues to the GitHub Actions "AI developer" (`ai-fix.yml`), which could only read code and
mostly guessed. Claude in an interactive session can see the real system (deployed commits, the databases,
GitHub, the browser), run the tests and iterate, so the quality matches a normal session. The pipeline is
kept for what it is good at: holding the ticket, its status and the evidence.

## The process

1. **Issues are reported** (by users or automatically) and land in Admin ▸ Fix pipeline as **Reported**.
2. **The owner tells Claude to work them**, in a Claude Code session ("work the Reported tickets", or a list).
3. **Claude works each ticket**, recording everything on it as it goes, with `scripts/fix-tickets.ts`:
   - `start <id>`: Reported → **Fix In Progress**, held by "Claude (interactive)".
   - Investigates against the real system. `note <id>` records findings.
   - Writes the fix **and a repro test** (`tests/repro-issue-<id>.test.ts`, or `e2e/repro-issue-<id>.spec.ts`
     when a page shows the fault), runs it **before and after** the fix, and records the result:
     `proof <id> --root-cause confirmed|guessed|not_found --test … --before … --after …`.
     "Confirmed" is refused unless the test failed before and passes after.
   - Opens a PR into staging, then `pr <id>` → **Merge** (PR, summary and any SQL recorded).
   - `staging-sql <id>` puts additive SQL on the staging DB and checks it.
   - Merges the PR into staging, then `merged <id>`; `sync <id>` follows staging CI and the staging deploy.
   - Can't fix it? `status <id> more_info_required|backlog|on_hold|closed --file <why>`.
4. **The ticket's "Ready for production?" checklist** then shows root cause, repro test, SQL safety, SQL on
   staging, tests on staging and live on staging.
5. **The owner ships to production**: **Approve for production** on the ticket (runs the same SQL on prod,
   then merges the one fix into main once its checks pass), or a staging → main release PR.

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

## Access

Prod reads and writes through this tool need an allow rule in the Claude Code settings:
`Bash(npx tsx scripts/fix-tickets.ts --env prod:*)`.
