# Task metering — one monthly task allowance

Since the 17 October 2026 cutover, customers have **one** usage number: a monthly task allowance.
AI media credits and X posting credits are retired.

## The rules

- **A task is one finished piece of work.** Weights live in `src/config/task-weights.ts`, the
  single source of truth:

  | Work | Tasks |
  |---|---|
  | Social post, blog article, lead search, email issue, email campaign, outreach email, site audit / draft / words | 1 |
  | AI image | 1 |
  | AI video, AI music | 20 (a shared track is 12) |
  | X post with a link | 10 (X charges us about $0.20 per post) |
  | X text post | 0 (part of the post's own task) |

- **Chat and editing helpers cost no tasks.** That covers chat turns, rewrite, overlay text,
  quality review, apply suggestions, compliance check, caption shortening, blog section rewrite,
  hooks and email line suggestions. Each has a per-organisation daily fair-use limit instead
  (`src/utils/fair-use.ts`). The defaults are 300 chat messages and 200 helper actions a day, set
  in `platform_config` as `fair_use_chat_per_day` and `fair_use_helpers_per_day`. Hitting the limit
  means "come back tomorrow", never an upgrade prompt.
- **Bonus tasks** (`task_bonus`) never expire. They are spent only after the monthly allowance is
  used up. They come from the cutover conversion, admin grants, and late X-pack webhooks.
- **The limit is a hard stop.** Work pauses and is never billed. Don't use the word "unlimited".

## Code map

| Piece | Where |
|---|---|
| Weights, labels | `src/config/task-weights.ts` |
| Capacity check, recording work, bonus grants | `src/utils/work-metering.ts`: `hasTaskCapacity(db, org, units)`, `recordCompletedWork(db, org, kind, { ref, assistantId })`, `getTaskUsage`, `grantBonusTasks` |
| Chat and helper metering | `src/utils/task-credit.ts` `meterInteraction(db, org, 'chat' \| 'helpers')`: with the flag off it is still `consumeTaskCredit` |
| Media | `src/utils/ai-credits.ts`: `holdCredits` / `holdAutonomousCredits` / `settleHold` keep their signatures. With the flag on, a hold is a capacity check and a successful settle records the work (`tasksForCredits`: image ×1, video and music ×4) |
| X | `holdXCredits` / `settleXHold`, same pattern. A refused link post is parked as `paused_credits` with reason `task_limit` and resumes on the 1st |
| Ledger | `task_ledger` holds one row per charge (`source='work'`) and per bonus grant. `usage_counters.task_count` is the fast counter; `reconcile-billing` checks that the two agree |
| Readers | `check-capacity` (`tasksRemaining`, `bonusTasks`, `unifiedTaskMetering`), `get-usage-summary` (`unit: 'tasks'`, by kind and by assistant), `get-ai-credit-balance` (`unit: 'tasks'`, costs as weights), `task-volume-check`, `resume-quota-paused`, `campaign-ledger.readPlanTaskGate` |

Media jobs still running (`media_generation_jobs` queued or processing in the last 2 hours) are
reserved against capacity, so parallel video requests can't overshoot. A charge that lands after
the cap is still recorded. That keeps the count honest, and every later request is refused.

## Rollout

1. Apply `db/task-ledger.sql` (staging, then prod). It is additive only and creates the
   `unified_task_metering` flag switched **off**.
2. Deploy the code. With the flag off, nothing changes for customers. The two exceptions are bug
   fixes that are safe on their own:
   - the "extra usage will be charged" autonomous-media dialog is gone (there was never an overage)
   - the task-limit cron now pauses per organisation and includes past-due plans
3. Test on your own workspaces: add their ids to `feature_flags.allowed_workspace_ids`.
4. **Customer notice**: with five paying customers at the time, the owner emailed each one directly
   rather than waiting 30 days; Terms v2.2 took effect the same day.
5. **17 October 2026 (mid-month)**: run `db/ops/task-allowance-cutover.sql` by hand, staging first.
   - In one transaction it converts balances to bonus tasks, raises the limits (600 / 2,750 /
     10,500, a placeholder until there is a month of data), hides the retired pricing rows and
     turns the flag on.
   - It is idempotent.
   - Deploy the public-copy changes at the same time.
6. **After one full period**:
   - delete the credit branches in `ai-credits.ts`, `consumeTaskCredit`, the X pack UI and
     checkout
   - stop writing to `ai_credit_balance` (keep it for the audit history)

## Copy that must switch at cutover (not flag-aware)

These are static, so they shipped with the cutover:

- `pricing.html`, `faq.html`, `index.html`, `terms_of_service.html` (v2.2, with `CURRENT_TOS_VERSION`),
  `checkout.html` and the help-article migration `db/help-articles-2026-12-tasks.sql`
- `explainers.js` (the media-source and brand-brief cost lines)
- `assistant-detail.html` "What are AI credits?"

The in-app surfaces that read `unit` or `unifiedTaskMetering` switch by themselves: Billing,
dashboard, My Content, the workspace generation gates, Blog Studio, Brand Designer and admin.

## Known data issues found on the way

- `db/ai-credit-grants.sql` sets saver 50 / buster 20, but `seed/data/master_plans.json` says saver
  20 / buster 50. Check the live database before relying on either. It matters only for the
  cutover's conversion, which reads actual balances.
- The seed has Busywork Buster at £99, while page fallbacks say £79. Check against Stripe.

## Mid-month cutover note

The switch happened on 16 October, not at a month boundary. October's `usage_counters.task_count`
therefore includes chat messages and helper clicks charged under the old rules before the switch,
with no ledger rows behind them. That is why `reconcile-billing` only compares counter and ledger from
1 November. Nobody is worse off: the limits were raised in the same transaction.
