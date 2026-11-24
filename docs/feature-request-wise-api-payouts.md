# Feature request: pay partners through Wise's API

**Status:** idea only — not planned or built (owner, 2026-11-23: "We will not work on this now"). For the feature request list.

## Today

Admin → Money → Partners → Payouts:

1. **Create payout run** — works out who is owed what.
2. Download the run's Wise files (UK bank, US bank, euro bank, Wise email). They match Wise's own batch template (checked 2026-11-23).
3. In Wise Business: top up the **GBP balance** from EUR (the screen shows "this run needs £X"), upload the file under Batch payments, check, confirm.
4. Wise pays each partner's bank account directly.
5. Back in Admin: **Mark paid** — partners get their "payout sent" email.

The money already goes straight to partners' bank accounts through Wise; the manual part is the file download/upload and marking the run paid.

## The idea

Replace steps 2–5 with Wise's API:

- Creating a payout run also creates each partner as a **Wise recipient** (from their vaulted payout details) and the transfers as **one batch** in our Wise account, paid from the GBP balance.
- The owner **approves the batch with one tap in the Wise app** (Wise requires the account holder's confirmation — Strong Customer Authentication — for UK/EU accounts; it also means nothing can be paid without the owner).
- Be More Swan checks the GBP balance first and says exactly how much EUR to convert.
- Wise's status updates (webhooks) mark each transfer paid; the run is marked paid and partners are emailed automatically. A failed transfer shows on the run with Wise's reason.

## What it would need

- A Wise **API token** from Wise Business (Settings → API tokens) — first for Wise's **sandbox**, later live. Added by the owner to Netlify environment variables; never pasted into chat.
- A short plan first (like `docs/partner-onboarding-plan.md`): recipient creation per method (GBP sort code, USD ACH, EUR IBAN, Wise email), batch groups, funding/approval flow, webhooks, retries, audit log, what happens to the file-based route (keep as a fallback).
- Review against the Partner Terms (4.2 payouts) and the privacy page (payout details sent to Wise via API rather than by file).

## Related, also not started

- **Revolut Business** as a second "pay from" account for UK payouts — waits for Revolut's bulk-transfer template (owner to download). Could later use Revolut's Business API the same way.
- PayPal could be automated through PayPal's Payouts API.
