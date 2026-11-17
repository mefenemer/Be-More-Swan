# Review tiers, a second-opinion reviewer and an approval record — PLAN (2026-11-17)

> Status: **decisions taken 2026-11-17; Phases 1 + 2 BUILT** (PR #682, branch feat/review-tiers-phase1 → staging).
> Phases 3–4 not started.

## Owner decisions (2026-11-17)

- **D1** ✅ High-tier list as drafted, **plus own-domain connect and Stripe Connect payouts / shop payments.**
- **D2** ✅ Custom reviewer agent (`.claude/agents/code-reviewer.md`), not the built-in `/code-review`.
- **D3** ✅ **Opus 5.5 for every review**, medium and high.
- **D4** ✅ Low-tier PRs merge to staging without the owner (phase 4, after phase 2 results look right).
- **D5** ❌ No separate GitHub bot account for now.
- **D6** ✅ Release PRs (staging→main) list their PRs by tier, high first.

## Phase 1 as built

- `src/config/review-tiers.ts` — the path → tier rules (billing, payouts, auth, tokens, publish-send, data,
  own-domain, platform = high; docs/tests and styles/media = low; everything else medium). SQL judged on the
  lines it adds via `classifySql`; unknown SQL text counts as high.
- `src/utils/pr-evidence.ts` — reads a unified diff, fills the evidence template, checks a PR body's block
  (missing lines, block claiming a lower tier than the files).
- `scripts/pr-tier.ts` — `[<pr>]`, `template [<pr>]`, `check <pr>`, `release <pr>` (D6: paste its output into
  the release PR body). Read-only.
- `.github/pull_request_template.md` — the block, for PRs opened on GitHub.
- `tests/review-tiers.test.ts` — owner areas are high, no function/util/config is ever low, every rule still
  matches a real file, SQL rules, evidence checks.
- **Convention from now on (Claude):** every PR body carries the evidence block from `pr-tier.ts template`;
  every release PR body carries `pr-tier.ts release` output. Nothing refuses a PR without it yet (phase 2).

## Why

Today every PR reaches the owner the same way. A typo fix and a change to Stripe, the token vault or prod SQL
both get the same "Approve PR #N" button. The session that wrote the change also tests it and asks for
approval, so nobody independent has read the diff before the owner does. The owner can't read every diff, so
in practice approvals are given on trust.

Several past incidents were the kind a second reader usually catches: the inverted AI video gate, the AI media
gate that was dead in prod, cost writes that were fire-and-forget and got lost (fixed d430869f).

The idea (from a talk on reviewing agent-written code): **change what people review, not how fast they
review.**
1. Sort each change by risk.
2. Let an agent review it first.
3. Give the person approving it an evidence pack.

Two rules hold at every stage:
- **The agent that wrote a change never approves it.** A separate person or agent does.
- **Every approval is on the record:** who or what approved it, and what they based it on.

## What we already have

| Piece | Where | Gap |
|---|---|---|
| Owner gives the final approval | Approve button (`src/utils/pr-approval.ts`), `ask-approval` in `scripts/fix-tickets.ts` / `scripts/feature-requests.ts` | Every PR is authored by the owner's GitHub account, so GitHub records no reviewer. The button merges. |
| Evidence: confirmed/guessed root cause, repro test fails before and passes after, SQL safety, SQL on staging, staging CI, live on staging | `src/utils/issue-fix-proof.ts`, `src/utils/feature-proof.ts`, checklist cards in `admin.html` | Only covers Fix and Feature tickets. Ordinary session work and staging→main release PRs have none. No review verdict, no risk level. |
| Unattended SQL limited to additive statements | `src/utils/issue-sql.ts` (`classifySql`) | Already a risk tier in all but name. |
| Approval stored | `approval_pr_url`, `approval_note`, `approval_requested_at` | A merge done with `gh pr merge` on the owner's word skips it (see the `shipped` workaround in feature-pipeline-parity). |

## Phase 2 as built

- `.claude/agents/code-reviewer.md` — read-only reviewer, **model claude-opus-5-5** (D3), given ONLY a PR number.
  House checklist: inverted/dead gates, un-awaited writes, `orgId` from the request, non-additive SQL,
  double-firing customer actions, GUI ↔ chat parity, claims vs code. `.gitignore` now tracks this one file
  under `.claude/` (the other agents stay local).
- The reviewer records its verdict with `scripts/pr-tier.ts record-review <pr> --sha <commit> --verdict
  pass|notes|changes --file <findings.md>`: a PR comment with a hidden `swan-review v1` marker naming the
  commit. Refused if the PR has moved past that commit.
- `src/utils/pr-review.ts` `reviewGate()` — a medium/high PR into staging needs a verdict for its **current
  head commit**; Changes needed blocks unless `--override-review "<why>"` (shown to the owner); low tier and
  PRs into main (releases, hotfixes) pass with a note.
- `ask-approval` (scripts/fix-tickets.ts, scripts/feature-requests.ts) runs the gate and puts its line first in
  the approval note: tier · verdict · "reviewed commit <sha>" · link. `pr-tier.ts check` and
  `pr-tier.ts review-status` show the same.
- **Approve click** (src/utils/pr-approval.ts): when the note names a reviewed commit, the merge is pinned to it
  (`sha` on the merge, `expectedHeadOid` on auto-merge) and refused if the PR changed after the review.
- Approve card (admin.html `_approvalNoteHtml`): verdict line bold, "merges only commit abc1234", link to the
  review.

**How Claude uses it:** open the PR → spawn the `code-reviewer` agent with the PR number only → fix any
Changes needed, push, review again → `ask-approval`. For PRs outside the pipelines, `pr-tier.ts check <pr>`
must pass before asking the owner.

## 1. Risk tiers

Every PR gets a tier, worked out **from the files it changes** (not chosen by the author), so it can't be
talked down. The highest matching rule wins.

| Tier | Matches (first draft, D1) | What happens |
|---|---|---|
| **High** | Billing / Stripe / plans / coupons / task costs; Stripe Connect payouts + shop payments; own-domain connect; auth, invites, roles, `orgId` checks; token vault + OAuth connectors; anything that **publishes or sends** on a customer's behalf (social post, blog publish, email send, Email Assistant actions); deletions + data export; `db/*.sql` with any non-additive statement; RLS; `netlify.toml` redirects/headers; GitHub workflows; secrets/env handling | Second-opinion review **plus** full evidence pack. The owner approves it as its own PR, never bundled. |
| **Medium** | Any other `netlify/functions/**`, `src/utils/**`, prompts, new UI in `workspace.html` / `admin.html`, additive SQL | Second-opinion review, then the owner's Approve. |
| **Low** | Copy/help articles, CSS-only, `docs/**`, tests only, `public/` static pages with no script | Merges to **staging** once CI passes. The owner sees it only in the staging→main release PR summary. |

Built as one path → tier map, `src/config/review-tiers.ts`, with a test that fails if a new
`netlify/functions/*.ts` file matches no rule (no silent "low"). A tiny helper, `scripts/pr-tier.ts <pr>`,
prints the tier and the rule that matched it.

## 2. Second-opinion reviewer (agent reviews first)

- A new **read-only** agent, `.claude/agents/code-reviewer.md`, with a fresh context. It gets **only the diff,
  the PR description and the repo**, never the writing session's reasoning, so it isn't anchored on the
  author's view. Tools: Read, Grep, Glob, Bash (read-only: `git`, `gh pr diff`, running tests).
- What it checks: correctness bugs, inverted or dead gates, missing `await`s, auth/`orgId` trust, SQL safety,
  the GUI and the chat path both changed (assistant-gui-chat-parity), archived-assistant filters,
  silent fallbacks to prod. Each finding carries file:line and a concrete failure scenario.
- Verdict: **Pass**, **Pass with notes** or **Changes needed**, plus findings. The writing session fixes
  "Changes needed" and the reviewer runs **again on the new diff** (up to 2 rounds; then it goes to the owner
  with the open findings shown).
- Runs on every medium and high PR **before `ask-approval`**. `ask-approval` refuses a medium/high PR with no
  verdict for its current head commit (a later push makes the old verdict stale).
- Cost: one reviewer run per PR (Opus 5.5 for every tier — D3). Comes from Claude Code usage,
  not the product's Anthropic bill.

Decided (D2): custom agent, because the house checks are where past incidents came from.

## 3. Evidence pack for every PR

Make the existing checklist card the one format for **all** PRs, not just tickets. Written into the PR body
between markers (the app already reads markers for SQL/root cause), so it shows on GitHub and on the board:

```
---EVIDENCE---
Tier: High (rule: billing — src/utils/stripe-*.ts)
What changed + why: 2–4 plain sentences
Root cause: Confirmed | Guessed | n/a (feature)
Proof: tests/repro-…test.ts failed before, passes after | e2e smoke | screenshot
SQL: none | additive (staging ✅) | NEEDS OWNER (non-additive)
Review: Pass with notes — reviewer run on <sha>, 2 notes (link)
Risk if wrong: who notices and how bad (e.g. "every customer's Monday posts don't go out")
Rollback: revert the PR | SQL down-step | flag off
---END-EVIDENCE---
```

The **Risk if wrong** and **Rollback** lines are new, and the most useful for the owner deciding fast.

## 4. Approval record

- New table `pr_approvals` (db/z-pr-approvals.sql, additive): `pr_number, base, head_sha, tier, author
  ('claude-session' | 'owner'), reviewer_verdict, reviewer_sha, approved_by ('owner' | 'auto-low-tier'),
  approved_via ('button' | 'chat' | 'ci'), evidence_json, merged_at`.
- Written by: the Approve button; the low-tier auto-merge; and a **merge sweep** on the existing
  check-fixes-live tick that records any merge into staging/main with no row (the `gh pr merge` in chat case)
  as `approved_via='chat'`, so nothing is ever missing.
- Admin → Systems gets a small "Approvals" list: last 30 merges, tier, verdict, who approved it. A merge with
  no verdict on a medium/high PR shows ⚠️.
- GitHub still shows no reviewer (owner's account authors every PR). Fixing that needs a separate bot account
  to author PRs (D5). Not needed for the record above.

## Phases

| Phase | What | Size |
|---|---|---|
| 1 | Tier map + `pr-tier.ts` + test; evidence block in every PR body (convention only, no gate yet) | small |
| 2 | Reviewer agent; `ask-approval` needs a verdict for medium/high; verdict shown on the checklist card | medium |
| 3 | `pr_approvals` table, merge sweep, Approvals list on Systems | small–medium |
| 4 | Low-tier auto-merge to staging (only after 2 weeks of phase 2 results look right) | small |

Nothing changes for main: staging→main stays the owner's merge in every tier.

## What we are NOT doing

- No human second reviewer, no review SLAs, no CODEOWNERS — this is a two-party team.
- No auto-merge to **main** for any tier.
- No blocking on reviewer "notes" — only "Changes needed" blocks, and even then the owner can approve anyway
  (shown as overridden in the record).

## Original questions

Answered 2026-11-17 — see Owner decisions at the top.
