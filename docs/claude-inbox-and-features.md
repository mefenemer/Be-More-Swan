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
  click merges it on GitHub (see docs/fix-pipeline-interactive.md) and, for a PR into main, moves the request to
  **Released without notifying anyone**. `withdraw-approval <id>` hides the button.

## Setup
- `db/z-claude-drafts-and-features.sql` and `db/z-pr-approval.sql` on BOTH databases (additive).
- Allow rules for prod: `Bash(npx tsx scripts/inbox-drafts.ts --env prod:*)` and
  `Bash(npx tsx scripts/feature-requests.ts --env prod:*)`.
