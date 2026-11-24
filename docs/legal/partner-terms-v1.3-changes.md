# Partner Terms v1.3: what changed

**Status:** published with PR #819 (owner request, 23 November 2026: "Partner Terms 4.2 still says payouts are in pounds to a UK bank, PayPal or Wise — update this"). Not yet reviewed by a solicitor.
**Text:** `partner-terms.html`; `PARTNER_TERMS_VERSION = '1.3'`. Every partner is asked to accept again on their Partner page. Until they do, commission still builds up but payouts and the Partner Assistant wait (`hasAcceptedCurrentTerms`).
**Why:** partners can now choose to be paid into a US bank account (`us_bank`, paid through Wise in USD; Angela, our first partner, is a US LLC) or a euro bank account by IBAN (`eu_bank`, paid through Wise in EUR; owner, 2026-11-23: "Yes, add EUR"). The euro wording was folded into 1.3 before 1.3 reached prod, so there is no 1.4. Clause 4.2 listed only PayPal, Wise and UK bank transfer, all in sterling.

| Clause | v1.2 | v1.3 |
| --- | --- | --- |
| 4.2 | "We pay in pounds sterling by PayPal, Wise or transfer to a UK bank account." | "Commission is worked out and paid in pounds sterling, by PayPal, Wise, transfer to a UK bank account, or transfer through Wise to a US bank account or a euro bank account (by IBAN). For a US or euro bank account, Wise converts the sterling amount to US dollars or euros at its exchange rate on the day of the payout, so the amount you receive can vary from one payout to the next." |

This note covers only the payment-method sentence. The same 1.3 also changes 4.2 in two other ways (small balances paid after 6 months; commission only on sterling payments), and other clauses, all described in `partner-terms-v1.3-activity-draft.md`. Otherwise in 4.2: conversion and fees are the partner's, and non-GBP customer payments use the sterling amount received.

**Notice (8.1):** 8.1 promises at least 30 days' notice of ANY change to these terms, and lets us hold payouts until the new version is accepted. v1.3 only adds a way to be paid and reduces no one's earnings. But bumping the version holds payouts and the Partner Assistant straight away until a partner accepts on their Partner page. That has no effect today, because no partners are approved on prod. Once there are live partners, a change like this should be emailed with 30 days' notice before the version goes live (or published without a version bump if it only adds an option, so nobody is blocked).

**For a solicitor, when there is one:**
- US partners and tax forms. We don't collect W-9 / W-8BEN(-E). 4.5 already says partners give us tax forms we reasonably ask for.
- Wise's FX margin and fees on the USD leg: 4.2 puts them on the partner. Confirm that's acceptable for US recipients.


## Also in v1.3 (23 November 2026, before publication)

- **4.3:** "A commission cancelled because of a dispute is reinstated if we win the dispute, **or if it closes without the payment being taken back.**" This covers a card issuer's inquiry that closes as `warning_closed` (owner decision). The webhook only reinstates when no other dispute on the same charge is still open or was lost.
