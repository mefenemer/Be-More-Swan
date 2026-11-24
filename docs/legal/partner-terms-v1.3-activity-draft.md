# Partner Terms v1.3: activity clause and cost protection (DRAFT, not published)

**Status:** BUILT on branch `feat/partner-terms-v1.3` (23 November 2026), not merged or published. `partner-terms.html` is v1.3 and `PARTNER_TERMS_VERSION = '1.3'`. Built: the text below plus a new **6.3 Customers are ours** (customers belong to Be More Swan; commission is an introduction fee, not a share in the customer; no encouraging a customer to leave while a partner), the 7.5 summary box, the line next to the accept button, Subscription Payments only on `invoice.paid`, and the 3.5 caps in `partner-rate-periods.ts`, the admin form and the Partner Ops chat. Build items 5–14 are still to do, except sub-£50 balances on ending (now paid). **The financial review changes below were applied on top, and they override the 7.5(a), 7.5(h), 3.3, 4.2 and 8.1 text further down.**

**No existing partners (owner, 23 November 2026).** Nobody has accepted v1.2, so there's no change notice, no transition rules and nothing to protect for "customers from before v1.3". v1.3 is simply the launch contract. The first partner (possibly Angela) reviews and accepts it on their Partner page. **Publish v1.3 before approving the first partner**, so the first terms anyone accepts are v1.3. Admin-added partners start with no terms accepted, and payouts and promotion are blocked until they accept (`hasAcceptedCurrentTerms`).

**Why:**
1. **Passive income.** Nothing in v1.2 requires a partner to keep introducing customers. A partner could sign up their network, stop, and keep earning until each customer's 12-month window runs out, or for ever on a lifetime rate. Under v1.2, §7.2 doesn't let us end a partnership for inactivity.
2. **Cost risk.** The 20% cost deduction is fixed for each customer. Under v1.2 nothing protects us if real costs turn out higher. §3.2 also covers every payment, which is wider than the code (the code pays nothing on X credit packs). Lifetime rates, rates up to 100% and 0% deductions are all possible in the code.

**What v1.3 does:**
- **Inactivity:** if 6 months pass without a new paying customer, we may end the partnership with notice (1, 2 or 3 months depending on how long they've been a partner).
- **Cure:** a new customer, or a sign-up still in their free period, cancels or extends the notice.
- **Run-off:** 3 months of commission after ending.
- **Commission base:** plan subscription payments only.
- **Caps:** at most 24 months, a rate of at most 40%, a deduction of at least 20%, unless a director signs an agreement that overrides them.
- **Closing the programme:** made explicit, with the same run-off.

---

## New clause 7.5 (full text)

> **7.5 — Staying active.**
> (a) The programme is for partners who keep introducing new customers. You are not obliged to introduce anyone, but if your Active Period ends with no Qualifying Customer, we may end your partnership by giving you notice under this section. **If we do, commission stops on your existing customers too, except as set out in (h).**
> (b) A "Qualifying Customer" is a customer who counts under section 3.1, whether introduced through your invite link or your partner code, whose first payment that takes money (section 3.4) is a Subscription Payment made while your partnership is approved, and is not refunded, charged back or disputed within the holding period in section 4.1.
> (c) Your "Active Period" is 6 months, counted from the later of: (i) the date we most recently approved you; and (ii) the date of the first payment of your most recent Qualifying Customer. The following do not count: any time your partnership is suspended under section 7.2, unless we end your partnership for the reason we suspended it; and any day on which new customers could not sign up, start a trial or pay through your invite link or partner code because of us, for example sign-ups being paused or limited to a waiting list, the partner offer being withdrawn, or a fault in our systems. Months are counted from a date to the same date in the following month.
> (d) The notice is at least 1 month, or 2 months once you have been a partner for more than a year, or 3 months once you have been a partner for more than two years.
> (e) If a Qualifying Customer makes their first payment before the notice ends, the notice is withdrawn. If a customer who counts under section 3.1 signs up through your link or code before the notice ends and is still in their free period when it would end, the notice is extended until 7 days after their free period ends, and is withdrawn if they become a Qualifying Customer in that time.
> (f) If a first payment we relied on to withdraw a notice is refunded, charged back or disputed within the holding period, we may give you a new notice straight away.
> (g) Your Partner page shows the date your Active Period ends. We will not give you notice under this section before the date shown there.
> (h) If we end your partnership under this section, section 7.3 applies to commission you earned before it ended. Section 7.4 then applies, except that on every customer you introduced who is still within their commission period, you keep earning on payments made in the 3 months after your partnership ends.
> (i) Ending under this section is not a finding that you broke these terms, and you may apply again. If we approve you again, you earn only on customers who first pay after we re-approve you.

## Changes to other clauses

| Clause | v1.2 | v1.3 draft | Review |
| --- | --- | --- | --- |
| 3.2 | "From what the customer actually pays us, excluding VAT, we first take a fixed cost deduction…" | Replace the first two sentences: "**3.2 — How much.** Commission is earned only on Subscription Payments. A 'Subscription Payment' is what a customer actually pays us, excluding VAT, for their recurring Be More Swan plan (monthly or annual), including a payment for upgrading that plan. It does not include payments for add-ons; task, credit or booster packs; top-ups; usage or overage charges; one-off purchases; set-up or service fees; third-party services; money we collect for or on behalf of the customer's own customers (for example shop, booking, deposit or holiday-let payments); or any part of a payment covered by credit, vouchers or refer-a-friend rewards. From each Subscription Payment we first take a fixed cost deduction…" Add at the end: "The cost deduction is a fixed figure that we set. It is not an estimate of our actual costs for any customer and is not adjusted for them." | M4, M5 |
| 3.3 | Rates fixed for each customer | Add at the end: "This protects the rate on a customer while your partnership continues. It does not stop commission ending under section 7.4." | H5 |
| 3.5 | (new) | "**3.5 — Longest commission period and special rates.** Unless a written rate agreement signed by a director of Be More Swan Ltd expressly refers to and overrides this section, no commission period is longer than 24 months from the customer's first payment that takes money, no commission rate is higher than 40%, and no cost deduction is lower than 20%, whatever your Partner page shows. Either of us may end a special rate on 3 months' notice. Customers who first pay after the notice ends then earn the standard rate, and customers who first paid before keep the rate they locked in, subject to this section and section 7.4." | M5 |
| 7.2 | "We may close or change the programme by giving you 30 days' notice. While suspended…" | Replace the last two sentences: "We may close the programme by giving you notice of the length set out in section 7.5(d). Closing it ends every partnership, and section 7.4 then applies, except that you keep earning on payments made in the 3 months after closure from customers still within their commission period. If we reopen a partner programme within 6 months of closing it, partners who were in good standing at closure may rejoin on the rates they had. We may change the programme by giving you notice under section 8. While suspended you do not earn commission on new payments." | H5, M3 |
| 7.3 | Earned commission paid under section 4 | Add: "After your partnership ends, we pay any ready-to-pay balance at the next payout run even if it is below the minimum, once you have confirmed your payout details." | M7 |
| 7.4 | "When your partnership ends for any reason…" | "…for any reason, including under section 7.5, and subject to sections 7.2 and 7.5(h)…" Add: "After your partnership ends, your invite link and partner code no longer earn commission or refer-a-friend rewards." | L3 |
| 8.1 | 30 days' notice of changes | Add: "Your partnership ending under section 7, and the effect of section 7.4, is not a change to these terms." Future changes keep the existing 30-day notice. | H5 |
| Top of page | Version 1.2 | Version 1.3 · date. A short summary box at the top of 7.5 repeats the bold sentence in 7.5(a). | H4 |

## Telling the first partner (instead of a change notice)

No change email is needed. Because 7.5 is the clause most likely to be challenged as unclear, make sure the first partner sees it before accepting:

- The summary box at the top of 7.5 (bold: commission stops on existing customers if the partnership ends).
- One line next to the accept button on the Partner page and the application form: *"Please read section 7.5 (Staying active): if 6 months go by without a new paying customer through you, we may end your partnership, and commission on your existing customers then stops after 3 months."*
- For Angela, or any partner approved personally: mention it in the welcome message too.

## Internal policy (not in the terms)

Every partner past their Active Period end date is flagged in Admin → Partners and gets the same notice, unless an admin records a written reason for not sending it. We never end a partnership automatically, and never use 7.5 to pick off particular partners. *(Review L4: this is our answer to any good-faith or Braganza argument.)*

## What needs building

**Before the first partner accepts (the terms or the page depend on it):**
1. Publish the v1.3 text in `partner-terms.html`, bump `PARTNER_TERMS_VERSION` to `'1.3'` with a comment line, and update tests that pin the version.
2. The 7.5 summary box, plus the line next to the accept button.
3. **Subscription payments only:** `invoice.paid` commission (`stripe-webhook.ts` ~645–654) limited to `billing_reason` in (`subscription_cycle`, `subscription_update`) and to the plan's own price lines. Check the first-payment path too.
4. **Caps in code:** in `partner-rate-periods.ts`, rate ≤ 40%, deduction ≥ 20%, duration ≤ 24 months and no lifetime option, unless an override flag is set (director-signed).

**Before anyone could reach 6 months inactive (any time in the first ~5 months):**
5. **Activity clock:** a stable `approved_at` on `partners`, set on each approval. Don't use `decided_at`, which every suspend or reinstate overwrites.
6. **"Stay active by [date]" on the Partner page:** built from the clock, the latest Qualifying Customer, and days paused.
7. **Qualifying Customer logic:** exclude first payments that are refunded or disputed within the holding period. Don't count a renewal locked as `subscribed_at` after a suspension as a new customer, or stop that lock happening.
8. **Pause the clock** while the partner is suspended and while the registration lock (waitlist mode, `platform-config.ts`) is on.
9. **Admin flag plus notice state:** the sweep lists partners past their date. An admin sends the notice, with the period tiered by tenure, stored as `inactivity_notice_at` / `inactivity_notice_ends`. The notice is withdrawn automatically on a Qualifying Customer, and extended for a sign-up still in their free period.
10. **Run-off in the ledger:** today `ended` stops everything at once. Ending under 7.5 or closure must keep commission going for 3 months on customers still within their window.
11. **Re-approval:** customers who first paid before re-approval earn nothing (`admin-partners.ts` allows `ended → approved`). Compare `subscribed_at` against `approved_at`.
12. **Sub-£50 balances** are paid at the first payout run after ending.
13. **Ended partner's link:** stop attributing (no fallback to the refer-a-friend track in `isPartnerReferrer`).
14. **5-month warning email** (optional): "a month left to stay active".

## Owner decisions needed

1. **Periods:** keep 6 months of inactivity and a 3-month run-off?
2. **Caps in 3.5:** 24 months / 40% / 20% are the review's suggestions. Change them?
3. **Angela's rate:** if she's offered anything above the standard 25% / 12 months, it must fit within the 3.5 caps, or be a director-signed agreement that overrides them.

## Questions for the solicitor

1. **Commercial Agents Regulations 1993:** does a SaaS subscription with no perpetual licence count as "goods", given *Software Incubator v Computer Associates* [2024] UKSC 8? Is §6.1 (no authority to negotiate) enough to make partners introducers, not agents?
2. **EU-based partners:** do local agency rules apply to services (e.g. HGB §89b), and can they override English law under *Ingmar* (C-381/98)? Should EU partners get a longer run-off?
3. **Fairness:** do 7.5 and the 3-month run-off pass UCTA s3/s11 for business partners and CRA 2015 Part 2 for individual partners?

## Review findings, where they went

| Finding | Where in this draft |
| --- | --- |
| H1 run-off could never apply | 7.5(h): a plain 3-month run-off |
| H2 conflict with §8.1/§3.3 for existing partners | Not needed: there are no existing partners |
| H3 cure impossible in 30 days; outages on our side | 7.5(c), 7.5(e) |
| H4 the consequence must be clear | summary box, line next to the accept button |
| H5 closing the programme vs §3.3/§8.1 | 3.3, 7.2, 8.1 |
| M1 Qualifying Customer | 7.5(b), 7.5(f), build 7 |
| M2 start date, suspension | 7.5(c), build 5, 8 |
| M3 agency notice minimums | 7.5(d), 7.2 |
| M4 subscription payments only | 3.2, build 3 |
| M5 caps, fixed deduction | 3.2, 3.5, build 4 |
| M6 re-approval | 7.5(i), build 11 |
| M7 small balances | 7.3, build 12 |
| L1 counting | 7.5(c) |
| L2 page date | 7.5(g) |
| L3 ended link | 7.4, build 13 |
| L4 consistency | internal policy |
| L5 condition, not duty | 7.5(a) |

---

## Financial viability review: changes applied (owner, 23 November 2026)

The contract-expert review found the standard deal is cheap for us at any realistic cost level: about 20% of subscription revenue for 12 months, roughly 9% of lifetime revenue. Margin risk comes from heavy users on the £69 plan, which is a pricing problem, not a partner one. The owner chose to apply items 2–5:

| # | Change | Where |
| --- | --- | --- |
| 2 | **7.5 narrowed.** On a standard commission period (12 months or less), a partner ended for inactivity keeps earning until each customer's period ends. Only periods longer than 12 months stop, 3 months after ending. The summary box, the accept-button lines and the playbook rule all say this. Most of build items 5–11 and 14 now only matter once a special period longer than 12 months exists. | 7.5(a), 7.5(h), summary box, `partners.html`, `partner-content.html`, `partner-playbook.ts` |
| 3 | **Small balances paid.** A ready balance under the minimum is paid after 6 months if it is £10 or more. Ended partners are paid any balance (7.3). | 4.2; `underMinimumReason` in `partner-payout-batches.ts` |
| 4 | **Sterling only.** "Commission is earned only on payments a customer makes to us in pounds sterling." This matches the code, which records nothing on non-GBP payments. | 4.2 |
| 5 | **60 days' notice** for any change that reduces commission (30 days for other changes). Customers referred during a notice reach their first paying month about 44 days later, so 60 days covers them. | 3.3, 8.1 |

Not applied, owner's choice for later: state the commission as "20% of each Subscription Payment" instead of "25% after a 20% deduction"; a growth rate for active partners (3.6); payouts by the 15th of the following month; 50% off instead of the free first month; re-measuring cost per user.

---

## Deferred build: DONE (branch `feat/partner-activity-clause`, 23 November 2026)

Needs **db/z-partner-activity.sql on BOTH databases before the code deploys**.

- **Activity clock:** `approved_at` (latest approval), `partner_since` (current partnership), and paused days (one per night while suspended or while sign-ups are paused). Logic in `src/utils/partner-activity.ts`.
- **"Stay active by" date** on the Partner page (`partner-hub.ts` → `pt-activity`); an open notice shows instead.
- **Notices:** an admin sends one from Admin → Partners once the date has passed (1/2/3 months by tenure). It is emailed and appears in-app. The nightly sweep withdraws it on a Qualifying Customer and extends it for a sign-up still in their free period. "End (inactivity)" appears once a notice has run out; nothing ends automatically.
- **Run-off in the ledger:** an ended partner earns only through §7.5(h) (≤12-month customers run to term, longer ones 3 months) or §7.2 closure (3 months). A plain "End" asks why: left, breach, closure or other. The Partner Ops chat can't end anyone for inactivity.
- **Re-approval:** customers who first paid before `partner_since` earn nothing.
- **Ended link:** earns no refer-a-friend tokens (`isPartnerReferrer` includes ended).
- **Suspended partners:** terms now lock at a customer's real first payment (nothing is earned). This closes the review's M1 gap, where a renewal after suspension looked like a new customer.
- **Review fix:** ended partners are paid under the terms they last accepted (7.3).
- **3.2 said plainly:** "20% of each Subscription Payment". The 3.5 cap is now "32% of a Subscription Payment". Internally it is still 25% after a 20% fixed deduction (`effectiveShareBps`). The Partner page, application page, Partner Assistant and welcome greeting all show the plain share.

Not built: the optional 5-month warning email.
