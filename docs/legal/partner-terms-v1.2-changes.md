# Partner Terms v1.2: draft changes for legal review

**Status:** PUBLISHED as v1.2 on 23 October 2026, by owner decision, ahead of legal review. The review still applies and will lead to a v1.3 if needed.
**Text:** `partner-terms.html`; `PARTNER_TERMS_VERSION = '1.2'`. Every partner is asked to accept again, and payouts are held until they do.
**4.5 as published:** softened by owner decision. Partners are solely responsible for their tax; VAT-registered partners give us their VAT number before the first payout, plus any tax details or forms we reasonably ask for; withholding and sanctions as drafted. The self-billing sentence and the list of tax details were cut, because neither is built.
**Why:** a legal review of v1.1 found gaps in cross-border protection. This draft covers the High findings (H1–H6) and the Medium findings (M1–M6). The Low findings were added before v1.2 reached prod: 2.1 (accepting for a business) and a new section 12 (entire agreement, notices, confidentiality, transfer, severability, no waiver, no third-party rights, events beyond our control, English prevails). The customer Terms' US-style dates were changed to UK format (formatting only, no version change).

Be More Swan Ltd is a UK company (ICO ZC272072). Partners can be anywhere in the world. They are paid in GBP by PayPal, Wise or UK bank transfer.

---

## What changed, clause by clause

| Clause | v1.1 | v1.2 draft | Finding |
| --- | --- | --- | --- |
| 3.1 | First introduction counts | + "our records decide who introduced a customer"; queries within 60 days of the payment | M6 |
| 3.2 | Rate after a 20% cost deduction | + "including any different rate we agree with you in writing" (special rates) | M6 |
| 3.3 | "may change … by giving notice" | "at least 30 days' notice (see section 8)" | H1 |
| 3.4 | "get a free trial and first paid month free" | "**currently** get …", so a change to the offer isn't a breach | M6 |
| 4.2 | Monthly payout run | "We **aim** to pay … by the end of the following month"; payouts need the current Terms accepted; FX and fees are the partner's; non-GBP payments use the sterling amount received | M4, H1 |
| 4.3 | Deducted from future payouts | Also covers chargebacks and breach; set-off against any sum owed; a shortfall after 60 days is a **debt repayable on demand**; reinstated if we win a dispute | H5 |
| 4.5 | Partner pays own tax; "we will agree how VAT is invoiced" | Sole responsibility worldwide; must provide legal name, tax residence, VAT/sales-tax number and forms; **UK VAT self-billing**; right to withhold tax; sanctions and AML refusal | H6 |
| 5.1 | "#ad", UK CAP Code | Label **before** engagement; CAP Code, DMCCA 2024, FTC 16 CFR 255 and 465, and local equivalents | H2 |
| 5.3 | Coupon sites; brand bidding on search; UK spam rules | + code-sharing extensions and forums; brand bidding on any search or social platform, including ad copy and display URL, with negative keywords; spam rules extended to CAN-SPAM, CASL and others, with sender ID, unsubscribe, opt-outs within 10 days, and no bought lists or Lead Generator contacts; + no translations or overstatement of the AI's capabilities | H3, M5 |
| 5.5 | (new) | AI-written content is the partner's; check it, keep the label, follow AI-disclosure rules, no AI testimonials presented as real | H2 |
| 6.1 | Independent partner | Independent contractor; no employment, agency, partnership or JV; **no authority to negotiate** or conclude contracts, prices, warranties, SLAs or refunds | M2 |
| 6.2 | May use our name and materials | Non-exclusive, revocable licence; goodwill is ours; remove marks within 7 days of ending | M5 |
| 7.2 | May suspend or end | **Immediately by notice**; wider grounds (spam, misleading promotion, reputation, sanctions); withhold up to 90 days while investigating; 30 days' notice to close or change the programme | H5 |
| 7.4 | (new) | Ending stops commission on later payments, including from earlier customers; listed sections survive | H5 |
| 8.1 | Material changes need acceptance | 30 days' notice; earnings cuts apply only to customers who first pay after the notice ends; payouts held until accepted; the last-accepted terms continue if the partner leaves | H1 |
| 9.3 | (new) | We are controller of partner data; the partner is an independent controller of their audience data (not joint); no sending us prospects' data; DPA covers their own business use; IDTA or Addendum for any transfer outside the UK | M3 |
| 10.1 | Cap = commission in the prior 12 months | Standard carve-outs; excludes loss of profit and indirect loss; cap = **greater of £100** and 12 months' commission | H4 |
| 10.2 | (new) | **Indemnity** from the partner for breach of sections 5, 6 or 9, their content, or breach of law, including regulator action against us as advertiser or instigator | H4 |
| 11.1 | English law, exclusive English courts | + non-contractual claims; **carve-out** letting us seek injunctions or enforce in the partner's own courts | M1 |
| 2.1 | Must be 18 and able to contract | + accepting for a business confirms authority to bind it; "you" means the business | L2 |
| 12 | (new) | Entire agreement (incl. written special rates), notices by email, confidentiality (incl. special rates), transfer (we may, you may not), severability, no waiver, no third-party rights, events beyond our control, English prevails over translations. 7.4 now also keeps section 12 | L1 |

## How the draft matches the code

The code already does these things (on prod since PR #479, 23 October 2026), so the draft describes how the system actually works:

- **Payouts wait for acceptance (4.2, 8.1):** they're held until the partner accepts the current Terms version.
- **Ended partners (7.4):** an "ended" status stops new commission, while what was earned before is still paid (7.3).
- **Won disputes (4.3):** commission is reinstated automatically.
- **Ad label first (5.1):** Partner Assistant drafts start with the label.

**Not built yet, but the draft promises it:**

- **4.5:** the self-billing and tax-details sentences were cut on publication (see Status). If the accountant advises self-billing, it needs building and a v1.3.
- **4.2 "by the end of the following month":** payout runs are started by hand, so someone has to run them on time.
- **3.1 60-day query window:** not tracked in the system. It's a contractual limit only.

## Questions for the solicitor or accountant

1. **The 20% deduction and v1.0 partners:** was it valid to apply the deduction to partners who accepted v1.0 (which required notice), from 22 October 2026? Should we make good the difference on customers locked in since then?
2. **Commercial agent risk:** could the Commercial Agents Regulations 1993 apply, or their EU equivalents for EU-based partners? Is the 6.1 wording ("no authority to negotiate") enough to avoid them?
3. **VAT:** the self-billing agreement, reverse charge for overseas partners, and whether "inclusive of VAT" works for UK VAT-registered partners.
4. **Tax forms:** which forms, if any, to collect from US and other overseas partners, and any reporting duties we have.
5. **Liability for partners' marketing:** our exposure under PECR as "instigator" of partners' marketing, and under the DMCCA for their practices.
6. **Fairness:** whether the 10.1 cap, the 7.3 forfeiture and the 4.3 debt wording pass the Unfair Contract Terms Act reasonableness test and the rule against penalties.
7. **Courts:** whether to keep exclusive English jurisdiction or move to LCIA arbitration, for enforcement in countries outside the Hague conventions, including the US.
8. **Sanctions and AML:** our screening duties for payouts to overseas individuals.
9. **Changes to the customer Terms:** whether they need matching changes. Their 21.9 / 1.4 points to the Partner Terms; 13.4 covers AI disclosure.

## Before v1.2 goes live

1. Legal and accounting sign-off, and any changes they ask for.
2. Build the self-billing section and tax-details collection, or remove those sentences from 4.5.
3. Update the Privacy Policy: Wise and PayPal as recipients, plus the tax and VAT details now collected.
4. Bump `PARTNER_TERMS_VERSION` to `1.2` and `PARTNER_TERMS_UPDATED` in `src/config/partner-terms.ts`, and the page's version line. Remove the DRAFT banner. Update the phrases `tests/partner-legal-data.test.ts` checks for.
5. Email partners at least 30 days before it takes effect (under the new 8.1, and the old 3.3 for rate changes). Every partner will then be asked to accept again, and their payouts are held until they do.
