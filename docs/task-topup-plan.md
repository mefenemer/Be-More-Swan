# Self-serve top-ups (tasks — and the credit top-up we already advertise)

**Status:** plan only. No code written. Commercial decisions are called out as **[DECISION]** and are
blockers — they change the schema, not just the copy.

**Date:** 2026-07-22

---

## Why this exists

Hitting the monthly task cap is currently a dead end with exactly one exit: upgrade a tier. The
allowance is a hard stop (`atomicCapCheck` refuses the task; there is no metered billing anywhere),
which is good — see [the no-overage promise on the pricing page](../pricing.html) — but "hard stop"
plus "no way to buy a little more" means a customer who is 50 tasks short in week three must either
jump a whole tier or stop working for a week. On the £29 → £79 step that is a 172% price increase to
solve a 2% capacity problem.

## ⚠️ Finding that reshapes this work

**We already advertise a top-up that does not exist.** There is no customer-facing purchase flow for
AI credits — or for anything else. Every Stripe path in the codebase is subscription mode
(`create-subscription.ts`, `create-plan-checkout-intent.ts`, `billing-upgrade.ts`); a search for
`mode: 'payment'` returns nothing. The only way credits are ever added is
[`admin-ai-credits.ts`](../netlify/functions/admin-ai-credits.ts), which requires an **admin** to
grant them by hand.

Meanwhile the pricing page states, three times on the cards, "you can top up any time", and the
comparison table has a row **"Buy Extra Credit Top-Ups — Purchase additional credits any time your
allowance runs low"** ticked on all four tiers ([pricing.html:562](../pricing.html)).

So this is not "mirror the existing credit top-up for tasks". It is **build the first one-off
purchase flow in the product**, and it should serve credits and tasks from one mechanism. Until it
ships, those pricing claims should either be softened or backed by a documented manual process.

## What already exists that we can reuse

| Piece | Where | Reusable? |
|---|---|---|
| Per-org credit balance + `held` | `ai_credit_balance` | Yes — the model to copy |
| Append-only economic audit | `ai_credit_ledger` (`delta`, `reason`, `balanceAfter`) | Yes — copy the shape |
| Atomic cap enforcement | `src/utils/atomic-cap-check.ts` | **Must change** — see below |
| Task usage counter | `usage_counters.task_count`, per org, UTC month | Yes |
| Stripe customer + webhook | `stripe-webhook.ts` | Yes — add a new event branch |
| Admin manual grant | `admin-ai-credits.ts` | Yes — the fallback while this is unbuilt |

## The design problem

`usage_counters.task_count` counts **upwards** against a limit resolved from the plan. There is
nowhere to put "and 200 more this month". Two options:

**Option A — extra allowance column (recommended).** Add `usage_counters.task_allowance_bonus`.
`atomicCapCheck` compares against `limit + bonus`. A purchase increments the bonus for the current
period; it expires naturally when the period rolls over.
*Pro:* one column, no change to how usage is counted, and the expiry is free.
*Con:* bonus cannot roll over (see **[DECISION 2]**).

**Option B — a task credit balance mirroring `ai_credit_balance`.** A separate durable balance
consumed after the monthly allowance is exhausted.
*Pro:* rolls over naturally, and the ledger gives a clean audit trail.
*Con:* two counters to reconcile, and `atomicCapCheck`'s single-statement atomicity gets harder —
that guarantee is the reason the old check-then-insert race was removed (US-DB-1.4.1). Do not give
it up lightly.

Recommend **A** unless **[DECISION 2]** says top-ups must roll over, in which case B.

## Blocking decisions

- **[DECISION 1] Bundle size and price.** e.g. 250 tasks for £15? The reference point is marginal
  value per task at each tier: £79 ÷ 2,500 = £0.0316/task. A top-up should sit above that (so it
  never undercuts an upgrade) but below the cost of jumping a tier. Needs your call.
- **[DECISION 2] Do purchased tasks expire at month end?** Drives Option A vs B. Note AI credits
  *do* roll over and we say so publicly, so tasks not rolling over is an inconsistency to be
  deliberate about.
- **[DECISION 3] Cap purchases per period?** Without a cap, a customer can sit on £29 forever and
  buy their way to Tier 3 volumes — which is worse for us than the upgrade. Suggest capping bonus at
  ~1× the plan's base allowance, then prompting to upgrade.
- **[DECISION 4] Who may buy?** Owner only, or any workspace member? Affects the RBAC gate.
- **[DECISION 5] Refunds.** One-off purchases are consumed immediately. State the position before
  launch, not after the first request.

## Implementation sketch (once decided)

1. **Schema** — `db/task-topups.sql` (hand-written, manual apply, per `docs/db-migrations.md`):
   `usage_counters.task_allowance_bonus integer NOT NULL DEFAULT 0`, plus a `task_topup_purchases`
   audit table (org, user, stripe_payment_intent_id, tasks, amount, currency, period_start,
   created_at) with a **unique index on `stripe_payment_intent_id`** for webhook idempotency.
2. **Stripe** — one-off Price in `payment` mode. Must be created in test *and* live, and the price
   id surfaced through the same single-source price management used for plans (see
   `plan_prices`) rather than hardcoded. Multi-currency: the pricing page already supports
   GBP/USD/EUR/AUD/CAD, so the bundle needs a price per currency or an explicit
   GBP-only decision.
3. **Purchase endpoint** — `create-topup-checkout.ts`: auth, RBAC gate, **[DECISION 3]** cap check,
   Stripe Checkout session in `payment` mode, `client_reference_id` carrying org + period.
4. **Webhook** — `checkout.session.completed` with the top-up marker → increment
   `task_allowance_bonus` for the **period recorded at purchase time** (not "now" — a session
   completing across a month boundary must not credit the wrong period), insert the audit row,
   notify. Idempotent on payment intent id.
5. **Enforcement** — `atomicCapCheck` compares against `limit + bonus`. This is the single most
   sensitive change in the plan: keep it one atomic `UPDATE`, and extend
   `tests/` coverage before touching it.
6. **Resume** — a purchase should immediately un-pause quota-paused assistants. Do **not** duplicate
   that logic: [`resume-quota-paused.ts`](../netlify/functions/resume-quota-paused.ts) already
   resumes exactly the `paused_quota` rows once usage is back under the effective limit. Extract its
   per-org body into a shared helper and call it from the webhook so a purchase resumes work in
   seconds rather than at the next 00:15 UTC run.
7. **UI** — a "Buy more tasks" CTA on the `task_limit_reached` notification, on the workspace quota
   gate, and in Billing. Plus the honest version of the pricing copy.
8. **Comms** — update the `task_limit_reached` template (currently: upgrade or wait) and the
   `faq.html` "What happens when I reach my task limit?" answer, which was just rewritten to say
   there is no top-up.

## Do first, regardless

Whether or not the purchase flow gets built, **reconcile the advertised credit top-up with reality**
— either ship the flow, or change the pricing copy and the comparison-table row to describe the
manual process. Selling a capability that requires an admin to run a script by hand is the kind of
gap that surfaces as a refund request.
