# Claude in the Inbox and on Feature requests (owner decisions, 2026-11-13)

Three kinds of customer request, three places (support-inbox.ts already routes them):

| What | Where | Claude's part | The owner's part |
|---|---|---|---|
| **Bugs** | Fix pipeline | Investigates, fixes, proves, moves the ticket (`scripts/fix-tickets.ts`, docs/fix-pipeline-interactive.md) | Ships to production; all communication |
| **Questions** | Inbox (support tickets) | **Drafts a reply** on the ticket (`scripts/inbox-drafts.ts`) | Reviews, edits and **sends** it (Send Reply clears the draft) |
| **Feature requests** | Feature requests board | Builds the ones the owner chooses and moves them along the board (`scripts/feature-requests.ts`) | Chooses what to build; ships; tells submitters and voters |

## Inbox drafts
- `list` shows questions waiting on us; `show <id>` the question and thread; `draft <id> --file reply.md
  [--note why.md]` saves the draft; `discard <id>` removes it.
- In Admin ▸ Inbox ▸ the ticket, the reply box opens **pre-filled with the draft**, under a "✍️ Draft by Claude"
  banner with Claude's note (what it checked) and a Discard button. Nothing is sent until the owner presses
  Send Reply. Never sent by the tool.

## Feature requests
- `start <id>` → In progress with a **🛠️ Claude working** pill on the card; `note`, `pr`, `status <id> …`,
  `release`. Notes and the PR appear in the request's edit panel under "Claude's work".
- The tool never notifies the submitter or voters. When the owner moves a card on the board, the board's own
  notifications still apply.

- PR pills (Staging PR / Prod PR, links to GitHub) on the card and in the edit panel; `prod-pr <id> --pr <url>`
  records a PR into main. `ask-approval <id> --pr <url> [--file why.md]` shows **✅ Approve PR #N**; the owner's
  click merges it on GitHub (see docs/fix-pipeline-interactive.md); for a PR into main the request moves to
  **Released, without notifying anyone, once the production deploy contains it** (see below). `withdraw-approval <id>` hides the button.

## Feature requests use the Fix pipeline's checks (owner, 2026-11-13)

"It must do the same thing before I start using it." So a feature Claude builds goes through the same steps as
a fix (`src/utils/feature-proof.ts`, `db/z-feature-pipeline-proof.sql`):

1. `start <id>` → In progress. Claude builds it.
2. `proof <id> --test <path> --before <exit> --after <exit> --file why.md`: a test of the new behaviour that
   **fails on the old code and passes with the feature** (the feature's version of a repro test).
3. Opens a PR into staging, then `pr <id> --pr <url> --file summary.md [--sql change.sql]`. The SQL is recorded,
   hashed and classified; only **additive** SQL runs unattended. A new PR resets every later check.
4. `staging-sql <id>`: the SQL goes on the staging DB and is checked. Not-additive SQL: the owner runs it by hand
   and tells Claude, who records it with `sql-done <id> staging|production` (owner's word only).
5. The PR merges into staging (Claude, or the owner's Approve button), then `merged <id>`. Staging CI on the
   merge commit and the staging deploy are followed (`sync <id>`, and every 30 minutes automatically).
6. The request's edit panel shows **Ready for production?**: proof test, SQL safety, SQL on staging, SQL on
   production, tests on staging, live on staging, live on production.
7. When the owner says to ship: `prod-sql <id>` (same SQL that passed on staging), just before the merge into main.
8. The owner merges into main (Approve button, or a staging → main release). **Approve refuses to merge while
   the SQL is not on that PR's database** (staging PR → staging DB; PR into main → prod DB).
9. **Go-live**: the request moves to **Released only once the production deploy contains it** (the 30-minute
   Issues live check, `check-fixes-live`), with a note and no notification. Claude never sets Released itself.

**Switched off until approval (hold).** Some features ship with their code in production but switched off
(waiting on LinkedIn or Google to approve an app, or in beta). `hold <id> --file why.md` keeps such a request at
In Progress: the go-live check skips it and the checklist shows **⏸️ Switched off (held)** with the reason.
`unhold <id>` only when the owner has switched it on; the next live check then moves it to Released.
Needs `db/z-feature-go-live-hold.sql` on both databases.

**Work already in main** (built before these checks, or committed straight to staging and released):
`shipped <id> --pr <PR into main> --file note.md` records the PR into main, the merge to staging, CI on the
released commit and whether staging has it. Hold a switched-off feature BEFORE running it.

`inspect --file q.sql` runs one read-only SELECT for investigating, as in the Fix pipeline.
Before `db/z-feature-pipeline-proof.sql` reaches a database, none of this shows there and Approve on a PR into
main still moves the request straight to Released (the old behaviour); `pr --sql` is refused there.

## Setup
- `db/z-feature-pipeline-proof.sql` and `db/z-feature-go-live-hold.sql` on BOTH databases (additive), for the checks above.
- `db/z-claude-drafts-and-features.sql` and `db/z-pr-approval.sql` on BOTH databases (additive).
- Allow rules for prod: `Bash(npx tsx scripts/inbox-drafts.ts --env prod:*)` and
  `Bash(npx tsx scripts/feature-requests.ts --env prod:*)`.
