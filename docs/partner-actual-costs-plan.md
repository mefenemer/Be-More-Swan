# Partner commission after ACTUAL costs — Plan

Owner, 2026-11-23: "the 20% cost deduction is only an estimate and is subject to change month on month … If all
of Angela's referrals are heavy users, Be More Swan cannot be negatively impacted … If costs exceed what users pay,
we will have to consider increasing the monthly price — how do we protect the company?"

**Status:** all decisions taken (D1–D4 and D5–D6 OK'd by the owner, 2026-11-23). **Built** on branch
`feat/partner-actual-costs`: `partner-costs.ts` (rule, slices, ECB), `partner-costs-db.ts` (costs, rate, true-up),
ledger + sweep + webhook card fee, Terms 3.2 (and the frozen v1.3 copy), Partner page breakdown, assistant, admin ledger.
⚠️ NEW SQL `db/z-partner-actual-costs.sql` — both DBs before deploy. Cost-logging audit (§5) still to do: providers that
don't write to `ai_usage_log` aren't counted yet (the 20% minimum still applies to them). Builds on the partner programme (`docs/affiliate-partner-programme-plan.md`) and Partner Terms
v1.3 (not on prod yet — nobody has accepted it, so the contract can still change without anyone's consent).

## 1. Decisions

| # | Question | Decided |
|---|---|---|
| D1 | The deduction | **The higher of 20% (the published minimum) or that customer's actual costs that month.** |
| D2 | What counts as costs | **AI model usage, image / video / voice generation, the meeting note-taker bot, email sending — and card processing fees.** |
| D3 | When a month's costs exceed what the customer paid | **Carry the shortfall forward** against that customer's next commissionable payments (never charged to the partner). |
| D4 | Angela | **50% after costs on this basis, for the first 12 months of each customer, for customers who first pay 27 Oct 2026 – 26 Oct 2027**, in a director-signed agreement that overrides Terms 3.5. Draft: `docs/legal/angela-special-commission-agreement-draft.md`. |
| D5 ✅ | **Annual plans** — a year paid up front, costs arrive over 12 months | **Proposed:** treat an annual payment as 12 monthly slices; each month's commission is worked out (and released) once that month's costs are known. Same rule as monthly plans, no guessing. Alternative: one commission at the end of the 60-day hold using costs so far ×6 — simpler but an estimate. |
| D6 ✅ | **Dollars → pounds** for costs logged in USD | **Proposed:** the European Central Bank's daily USD/GBP rate, saved each day; the rate used is stored on each commission row. Alternative: a rate the admin sets each month. |

## 2. The rule (per customer, per month of service)

```
deduction   = max( minimum% × payment ,  actual costs for that month )     actual costs = AI + media + bot + email + card fee
available   = payment − deduction − shortfall carried in from earlier months
commission  = rate × max(0, available)
carried out = max(0, −available)                                            → taken off the next month(s) for this customer
```

- `payment` = what the customer paid for that month, excluding VAT (Terms 3.2 "Subscription Payment").
- Commission is never below zero, and the partner never owes us because of costs.
- A carried shortfall is never paid back to us by the partner; it only reduces that customer's later commission.
  When the customer's commission period ends, any shortfall left simply lapses.
- **Light user:** costs under 20% → 20% comes off (covers support, hosting, overheads we don't measure per customer).
  **Heavy user:** real costs come off. **Loss-making customer:** commission 0, shortfall carried forward.
- Worked example (Angela, 50%, £69 plan): light month costs £4 → deduction £13.80 (20%) → £27.60 commission;
  heavy month costs £30 → £19.50; month where costs are £75 → £0 and £6 carried into next month.

## 3. Price rises

Commission is a share of what the customer actually pays, so raising prices raises commission in proportion while
Be More Swan keeps the same share after costs. The Terms (and Angela's agreement) say plainly that we set and change
prices, plans, features and usage limits at any time, and commission follows what customers actually pay. Nothing to
build — wording only (§5).

## 4. Timing (why commission waits for the month's costs)

Today commission is worked out the moment a customer pays and then held 30 days. Costs for the month a payment covers
mostly come AFTER the payment. So:

1. At payment: record a **provisional** commission using the 20% minimum (as today), plus the **card fee** (from
   Stripe's balance transaction, already fetched for currency conversion).
2. At the end of the holding period (the nightly sweep, before it can become "ready to pay"): add up that customer's
   logged costs for the payment's service period, convert to pounds (D6), apply the rule and the carried shortfall,
   and **adjust the commission** — it's still "waiting", so nothing paid is ever changed.
3. Annual plans: D5.

The 30-day hold already roughly matches a monthly period; if a month isn't over yet at release, release waits for it.

## 5. Changes

**Contract**
- Terms 3.2: the deduction becomes "the higher of [20%] of the Subscription Payment or the Cost of Service for that
  customer in that month", with **Cost of Service** defined (AI model usage, image / video / voice generation, meeting
  bot minutes, email sending, card processing fees — as recorded by our systems), the carry-forward, and the minimum
  changeable for future customers on notice (3.3/8.1 already do this).
- Terms 3.5 cap (32% of a payment) stays as an upper limit.
- New sentence: we set and change prices, plans, features and limits; commission follows what customers actually pay.
- Partner Terms version: 1.3 is unpublished on prod, so this goes into 1.3 (or 1.4 if 1.3 is released first).
- Angela's agreement (D4).

**Data** (one SQL file, both DBs before deploy)
- `partner_commissions`: `min_deduction_bps` (today's `cost_deduction_bps`), `service_period_start/end`,
  `cost_pence` (AI + media + bot + email), `card_fee_pence`, `deduction_pence`, `deduction_basis` ('minimum' | 'actual'),
  `carry_in_pence`, `carry_out_pence`, `usd_gbp_rate`, `costs_checked_at`.
- `partner_referrals`: `cost_carry_pence` (the running shortfall for that customer).
- If D6 = ECB: a small `fx_rates` table filled daily.

**Code**
- Cost audit: confirm every paid provider writes its cost to `ai_usage_log` per workspace (Claude, image, video, voice,
  Recall bot, email); add the ones that don't.
- `partner-ledger.ts`: provisional record + card fee; `partner-commission-sweep.ts`: the true-up before release;
  refunds/disputes keep working on the adjusted amount.
- Partner page: each commission row shows payment → costs taken off (and "20% minimum" or "actual costs") → carried in
  → commission; the ⓘ texts, the greeting's example ("every £79 earns you **up to** £31.60") and the Partner Assistant
  explain the rule. Customers stay "Customer 3" — only totals, never what they used.
- Admin: rows where actual costs beat the minimum, and each customer's carried shortfall.

**Tests** — the rule (light / heavy / loss / carry across months / lapse at end of window), card fee, FX, annual slices
(D5), refunds after a true-up, and that a paid row is never changed.

## 6. Not in this plan

- Charging a partner anything because of costs (never).
- Changing commission already paid.
- The Wise API (separate feature request).
