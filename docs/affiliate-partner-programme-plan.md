# Affiliate Partner Programme — Plan

Added 2026-10-18, from an external proposal (build our own Rewardful / FirstPromoter / Tolt) reviewed
against the code as built. Status: **step 1 built 2026-10-18** (branch `feat/affiliate-partners`, not merged): tables
(`db/z-affiliate-partners.sql` + `db/schema.ts` mirror — applied to staging + prod 2026-10-18 by the owner) and the
rate-period rules (`src/utils/partner-rate-periods.ts`, `tests/partner-rate-periods.test.ts`).
**Step 2 built 2026-10-18** (same branch, no new SQL): the ledger (`src/utils/partner-ledger.ts`) wired into
`stripe-webhook.ts` on all three payment paths, a new `charge.refunded` handler + the dispute handler,
nightly release (`partner-commission-sweep.ts`, staging poke `run-partner-sweep.ts`), partner referrals
qualify as `user_referrals.status = 'partner'` (no token). Tests: `partner-ledger.test.ts`,
`partner-ledger-db.test.ts` (real Postgres, CI rls job). ⚠️ **Enable `charge.refunded` on the Stripe
webhook endpoint in BOTH environments** before relying on refunds.
**Step 3 built 2026-10-18** (same branch, no new SQL): Admin → Revenue → Partners (`admin.html` view `partners`,
API `admin-partners.ts`, permission `manage_partners` = billing_admin+): programme rate timeline (schedule /
edit / delete upcoming), payout rules, partner list with approve / reject / suspend / reinstate, per-partner
special rates, "Add partner" for an existing account. Every write audited. Tests: `admin-partners.test.ts`.
**Step 3b built 2026-10-18** — the admin CHAT path (§4.5), first shipped GUI-only by mistake: a Partner Ops
panel on the same screen (`admin-partners-chat.ts`, Claude Opus 5.5 at low effort with a refusal fallback to
Opus 4.8, 21s budget under the 26s limit). Reads through `src/utils/partner-ops.ts` (the same queries as the
screen: list, partner detail, top referrers, pre-payout audit with same-card / same-domain / reversal /
burst signs, recruitment by AI actions — BMS records no logins). Never writes: changes come back as cards
(`src/utils/partner-ops-proposals.ts`) whose button POSTs the exact admin-partners.ts request. Drafts emails,
never sends. Tests: `partner-ops-chat.test.ts`, `partner-ops-db.test.ts` (CI).
**Step 4 built 2026-10-18** — owner decision: **apply first, account on approval**. `partners.html` (public,
`noindex`, NOT linked from nav/footer/sitemap until launch; terms read live from `partner-programme-public.ts`)
→ `partner-apply.ts` (no account; honeypot + fill time + per-IP/email limits; links an existing account by
email) → admin approves → `partner_approved_create_account` email with a one-time link
`register.html?partner=<token>` (sha256 stored, 14 days) that the edge + `register.ts` let past the sign-up
lock for the applicant's own email only; "Resend account link" on the screen and as a chat card.
`/invite/<code>` → `invite.html` (200 rewrite, root-relative paths, noindex; counts a visit per approved
partner per day in `partner_link_stats`; waitlist-aware). register.html has a visible **Invited by** field
(what is sent is what is on screen). SQL `db/z-affiliate-partner-applications.sql` applied to staging + prod 2026-10-18 (verified on prod). Not done: no automatic rejection email; a new partner account lands in the
normal trial workspace until the partner hub (step 5). Tests: `partner-applications.test.ts`,
`partner-applications-db.test.ts` (CI).
**Step 5 built 2026-10-18** — owner decision: the hub lives **inside the workspace** (view `partner`,
`partner-content.html`, API `partner-hub.ts`). check-capacity returns `partnerStatus`; an approved/suspended
partner with no paid plan is NEVER hard-gated — they land on the Partner page, and "See plans" opens the
dismissible picker. Sidebar "Partner" shows only to partners (5 locales). Refer a Friend sends partners to
it (their code earns cash, not tokens). Payout details: PayPal / Wise / UK bank, stored in the VAULT
(`aura/partner-<id>/payout`), masked summary only on the row; a change waits for an emailed link that opens the
signed-in Partner page where they press Confirm (24 h, once, own row only), then a "changed" email. Customers
are shown as "Customer N", never named. SQL `db/z-affiliate-partner-payouts.sql` applied to staging + prod 2026-10-18 (verified on prod). Not done: partner assistant/chat (step 8); GDPR export/erase of partner rows
and vault secrets (step 9). Tests: `partner-hub.test.ts`, `partner-payouts-db.test.ts` (CI).
**Step 6 built 2026-10-18** (no new SQL) — Admin → Revenue → Partners gains **Payouts** (who is due and why
others aren't; "Create payout run" locks the rows under an advisory lock; per-method files: Wise bank, Wise
email, PayPal; Mark paid / Cancel run) and **Commission ledger** (filters, Cancel with a reason the partner
sees, Add bonus). Logic in `src/utils/partner-payout-batches.ts`; every write and every file download
(which decrypts bank details from the vault) audited. Partner Ops chat got the same actions as cards + ledger
/ payouts read tools; it can never produce payment files. ⚠️ **Wise headers** (`WISE_BANK_HEADERS`,
`WISE_EMAIL_HEADERS`) come from Wise's documented field names — compare once with the template downloaded
from Wise before the first real run. PayPal's format is PayPal's documented one (no header row). Tests:
`partner-payout-runs.test.ts`, `partner-payout-runs-db.test.ts` (CI).
**Step 7 built 2026-10-18** — owner decision: **BMS partner codes, NOT Stripe promotion codes** (a promotion
code is tied to one coupon; the friend offer needs a different coupon for monthly vs annual, so a monthly
"100% off once" code on an annual plan would give a free year). An admin sets/changes/turns off a memorable
code per approved partner (Partners → Details, or a Partner Ops card; audited). `src/utils/invite-codes.ts` is
the ONE resolver for every code (referral code or partner code) — used by sign-up's "Invited by",
`/invite/<code>`, the offer banner, and a new **"Have an invite code?"** box on the plan picker
(`referral-claim.ts`: shown only when the server says the account is eligible — not already invited, never
paid, not their own code). Checkout still applies the friend offer from `user_referrals`, with the right
coupon per cycle. The ledger records partner-code customers as `source = 'promo_code'`. Partner page shows
the code. SQL `db/z-affiliate-partner-codes.sql` applied to staging + prod 2026-10-18 (verified on prod).
Not browser-checked: the plan-picker box (it lives inside the signed-in workspace). Tests:
`partner-codes.test.ts`, `partner-codes-db.test.ts` (CI).
**Step 8 built 2026-10-19** — the partner's **Partner Assistant**, a chat panel on their Partner page
(`partner-assistant.ts`, Claude Opus 5.5 low effort + Opus 4.8 refusal fallback, 21s budget). Owner decision:
**free, 50 messages in any 30 days, not counted as plan tasks** (usage still logged). Drafts go through
`deliver_draft` → `src/utils/partner-promo.ts`, which guarantees their link (or partner code) and an ad label
(#ad / P.S. / spoken for video — CAP Code). Describes BMS ONLY from `bms_facts` (live plan prices; names no
social networks or integrations). Answers money questions from their real numbers; suggests next steps.
Hand-offs (cards) open THEIR Social Media Manager / Email Marketing / Lead Generator chat with the brief typed
in — only assistants they have. Payout details never pass through the model (a card to the form). Also fixed:
three Tailwind classes missing from the built CSS in both chat panels (log height now inline). Not verified:
a live Claude conversation (same as the admin chat). Tests: `partner-assistant.test.ts`.
**Step 9 built 2026-10-19** — `partner-terms.html` (v1.0, noindex until launch; **a draft for legal review**),
accepted on the application form (required tick) or on the Partner page (`accept_terms`), recorded as
`partners.terms_version` / `terms_accepted_at` (`src/config/partner-terms.ts`). Owner decision: the customer
Terms only gain clause 1.4 pointing to the Partner Terms — **no ToS version bump**, no re-acceptance prompt.
privacy.html: partner data, invited people (first name shown; partners see "Customer N"), payout details in
the vault, retention rows (declined applications 12 months; payout details until changed/left/erased;
commission records 7 years). Data export: `you.partner` (own record, commissions, visits; customers as a
COUNT). Erasure: `src/utils/partner-erasure.ts` from admin GDPR erase, `deleteUserAndSoleOrgs` and
account-delete-execute — identifying fields + vault payout details go, the ledger stays (tax law), partner
left suspended; declined no-account applications purged nightly after 12 months; "Erase application"
(screen + chat card). Notifications: commission earned and payout sent, in-app (opens the Partner page) and
email (`src/utils/partner-notify.ts`, never throws). ⚠️ **NEW SQL: `db/z-affiliate-partner-terms.sql` —
apply to both environments before deploying.** Tests: `partner-legal-data.test.ts`,
`partner-erasure-db.test.ts` (CI).
**Remaining before launch:** legal review of the Partner Terms and privacy wording; compare the Wise CSV headers
with a downloaded Wise template; turn on `charge.refunded` on both Stripe webhook endpoints; one live run of
each chat; link `/partners` from the site and remove `noindex` from partners.html / partner-terms.html when the
owner opens the programme. Nothing
else below is built unless marked ✅ (already exists, reused).

Related: [campaign-orchestrator-plan.md](./campaign-orchestrator-plan.md) §9.0 (GUI/chat parity),
[task-metering.md](./task-metering.md), `src/utils/referral-offer.ts`, `src/utils/referral-tokens.ts`.

---

## 1. Requirements (from the owner)

1. Build it natively in BMS — no third-party affiliate platform.
2. **Two separate tracks** (decided 2026-10-18):
   - **Refer a friend** — ordinary customers who happen to refer someone. ✅ Exists. Earns tokens
     (5 → a free assistant). **Unchanged by this plan.**
   - **Affiliate partners** — people actively promoting BMS. Earn **cash commission**. New.
3. **Commission is configurable by the admin** — not hard-coded — as **dated rate periods**
   (decided 2026-10-18): each rate has a start and end date, and a partner's new subscriber gets
   the rate of the period they subscribed in, for that subscriber's whole commission window. This
   lets rates change over time (launch offers, seasonal pushes) without touching past promises.
4. Everything a partner or admin can do is possible **both** in the GUI and by chatting to an
   assistant (standard BMS rule), and the assistant can hand work to other assistants.
5. The assistant suggests how a partner can convert their leads or find new ones (e.g. the Lead
   Generator).
6. No tracking cookies (see §4.2).

## 2. Programme defaults (admin can change all of these)

Checked against Rewardful's and FirstPromoter's own affiliate programmes and published SaaS
benchmarks (20–30% recurring, ~24% average, 20% B2B median) on 2026-10-18. Tolt's own terms could
not be read.

| Setting | Starting default | Evidence |
|---|---|---|
| Commission rate (first programme period, open-ended from launch) | 25% | Rewardful 25%; FirstPromoter 20% or 25→35% tiered |
| Duration (set per period) | First 12 months of the customer's payments | Both: 12 months |
| Holding period | 30 days after the payment | Rewardful: due 30 days after generated; FirstPromoter Net 30 |
| Minimum payout | £50 (smaller balances roll over) | Rewardful $50 |
| Who can join | Apply → admin approves | Rewardful approves every partner |
| Partner's audience gets | Same as a referred friend: trial, then first month free | Judgement — sites don't say |
| Partner needs a paid BMS plan | No — free partner-only login | Judgement |

Rules copied from Rewardful's terms: no self-referral, **no coupon/voucher sites**, **no commission on
someone who was already a BMS customer**, no commission on refunded payments.

## 3. What already exists (reuse, don't rebuild)

- ✅ `users.referral_code` — every user has a code.
- ✅ `?ref=` is read by `register.html` and sent as `referralRef`; `register.ts` (~line 321) writes a
  `user_referrals` row at signup with a self-referral block. Attribution is **already cookieless**.
- ✅ `user_referrals` (referrer, referred, status pending → qualified, `qualifiedAt`) — unique on the
  referred user, so one referrer per customer.
- ✅ `stripe-webhook.ts`: `invoice.paid` already calls `qualifyPendingReferral` on the first invoice
  with `amount_paid > 0`. ⚠️ The **first** payment of a new subscription is recorded in
  `checkout.session.completed` / `payment_intent.succeeded`, and `subscription_create` invoices are
  skipped in `invoice.paid` (~line 206) — commission must be written on **both** paths or every
  partner loses month one.
- ✅ `charge.dispute.created` handler exists. ⚠️ There is **no `charge.refunded` handler** — needs
  adding, and the event enabling on the Stripe webhook endpoint in **both** environments.
- ✅ Admin → Revenue → Coupons (`admin-coupons.ts`) — real Stripe coupons + promotion codes. Partner
  promo codes reuse this.
- ✅ Chat handoffs: `HandoffProposalCard` in `chat-orchestrator.ts` (user approves; payload capped).
- ✅ Work metering (`work-metering.ts`) for any background drafting.

## 4. Design

### 4.1 Data (Postgres / Drizzle, one SQL file, apply before deploy)

- **`partner_programme_settings`** — single row for the non-rate settings: `holding_days`,
  `min_payout_pence`, `currency` ('GBP'), `updated_by`, `updated_at`. Every change written to the
  admin audit log.
- **`partner_rate_periods`** — the commission rates, over time:
  `partner_id` (NULL = programme-wide; set = that partner only), `rate_bps` (2500 = 25%), `duration_months`
  (NULL = lifetime), `starts_at`, `ends_at` (NULL = open-ended), `label` (e.g. "Launch month"),
  `created_by`. Rules, enforced on the server:
  - **No overlaps** within the same scope (programme-wide, or one partner).
  - **Programme-wide periods have no gaps** — some programme period always covers today, so a
    subscriber can never land on "no rate". The latest one is open-ended.
  - A **partner period beats the programme period** for the same date. Partner periods may have
    gaps (the programme period fills them).
  - **Once a period has started, its rate and duration are frozen** — only its end date can move
    (end it early, or extend it). To change the rate: end the current period and add a new one.
    Future periods are fully editable or deletable. This is what makes the promise to past
    subscribers safe.
- **`partners`** — one per user: `user_id` (unique), `status` (applied | approved | suspended |
  rejected), application answers (how they'll promote, audience size, links), `promo_code_id`
  (Stripe, optional), payout method + **encrypted** payout details, `approved_by`, `approved_at`.
  (Per-partner rates live in `partner_rate_periods`, not here.)
- **`partner_referrals`** — the partner side of a `user_referrals` row (one each, unique on
  `referral_id`): `partner_id`, `source` (`link` | `promo_code` | `manual`), and the **locked
  terms** written when the referred customer first pays: `subscribed_at`, `rate_period_id`,
  `rate_bps`, `duration_months`. Copied, not just linked, so later admin
  edits can never change what was promised. A separate table rather than new `user_referrals`
  columns: Drizzle names every column on a plain select, so a new column there would break every
  existing referral read until the SQL was applied. A referral is a partner referral when it has a
  `partner_referrals` row; otherwise it stays on the token track exactly as today. ⚠️ A partner's
  referrals must **not** also earn tokens — pick one track at qualification.
- **`partner_commissions`** — the ledger: `partner_id`, `referral_id`, `stripe_invoice_id`
  (**UNIQUE** — Stripe retries can't pay twice), `stripe_charge_id`, `net_amount_pence` (excl. VAT),
  `rate_bps` (**snapshot of the rate used**), `commission_pence`, `status` (pending | payable | paid
  | voided), `available_at`, `payout_batch_id`, `void_reason`.
- **`partner_payout_batches`** — `created_by`, totals, `exported_at`, `paid_at`.
- **Clicks** — a per-partner daily counter (`partner_link_stats(partner_id, day, clicks)`), counted on the
  server when `/invite/<code>` loads. No IP, no device storage.

### 4.2 Attribution (no cookies)

The code travels in the URL into the signup form — nothing is stored on the visitor's device, so
no consent banner question. Three routes in:

1. **`/invite/<code>`** — a public page: "Alex invited you — 14-day trial, then your first month
   free", with the sign-up button carrying `?ref=<code>` to `register.html`. ✅ register already
   handles the rest.
2. **"Invited by" field** on registration — visible, pre-filled from `?ref=`, typeable for someone
   who heard a podcast.
3. **Optional per-partner Stripe promotion code** (admin turns it on per partner, because codes leak
   to voucher sites). Applied in `create-plan-checkout-intent.ts` alongside the existing friend
   offer; the webhook attributes on the promotion code when no referral exists yet.

### 4.3 Commission ledger

- **Locking the rate:** the first time a partner's referred customer **becomes a paying
  subscriber**, find the period covering that moment (partner period first, else programme) and
  copy its rate + duration onto the `user_referrals` row. "Subscribes" = first payment that takes
  money, not trial sign-up — a trial started in one period and paid in the next gets the next
  period's rate. (Same moment the friend track already uses to qualify.)
- On every paid invoice (both first-payment paths and `invoice.paid`), with `amount > 0`:
  referred user → approved partner → within the locked duration from `subscribed_at` → commission
  at the **locked** rate → insert `pending` with `available_at = now + holding_days`. Commission is
  on the subtotal **excluding VAT**.
- `charge.refunded` / `charge.dispute.created` → void pending or payable rows. Already paid → a
  negative adjustment carried into the next payout.
- Nightly: `pending` past `available_at` → `payable`. Add to the existing nightly sweep, and ⚠️
  verify it actually runs (memory: two nightly sweeps never ran).
- **Rate changes apply to new subscribers only** — a subscriber keeps the rate of the period they
  subscribed in for their whole window, and each ledger row also snapshots the rate it was earned
  at.

### 4.4 Payouts

Start manual: admin creates a batch of partners with payable ≥ minimum → **Export Wise batch CSV**
→ pays in Wise → **Mark batch paid**. Stripe Connect / automated payouts later if volume justifies
it. UK: partners invoice us (or we self-bill); record VAT registration. Accountant to confirm
before the first payout.

### 4.5 Admin — Admin → Revenue → Partners (next to Coupons)

1. **Rates** — a timeline of programme-wide periods (past, current, upcoming): add a period, end
   the current one, edit or delete upcoming ones. Started periods show their rate as read-only with
   "applies to customers who subscribed between these dates". Holding period / minimum payout
   beside it.
2. **Applications** — approve / reject, with the application answers.
3. **Partners** — directory; per-partner rate periods (same timeline, scoped to one partner, shown
   against the programme rate they override); promo code on/off; suspend.
4. **Ledger** — every commission, status badges, void, manual bonus.
5. **Payouts** — fraud flags (self-referral, same payout details across partners, refund spikes),
   batch → CSV → mark paid.

Chat path: the admin can ask for the same things in the admin assistant — read freely, writes
via a proposal card the admin clicks.

### 4.6 Partner side

- **Apply**: a public `/partners` page → creates a user (partner-only, no plan) + `partners` row in
  `applied`. Existing customers apply from inside the app with one click. ⚠️ Respect the waitlist
  registration lock.
- **Partner hub** (extend `referral-content.html`, or a sibling page for partners): link + code,
  clicks, sign-ups, paying customers, pending / payable / paid, payout history, payout settings.
  Partner-only users see this and nothing else, with an "use BMS for your own business" upsell.
- **Payout details changes** (GUI or chat) need an email confirmation and send a notification —
  this is what an account thief would change.

### 4.7 The assistant

A partner mode of an assistant (not a new role at first) that can:

- Answer "what am I being paid on the 1st?" from the ledger (read-only).
- Draft promotion in the partner's own voice with their link inserted **and an ad disclosure
  (#ad / affiliate)** always added (ASA/CAP).
- Hand off via `HandoffProposalCard`: posts → Social Assistant, emails → Email Marketing Assistant,
  finding prospects → Lead Generator.
- Suggest from real numbers only (e.g. "40 clicks, 0 sign-ups this month").
- Free partner-only users: drafting goes through work metering with a hard monthly cap, prompt
  locked to promoting BMS.

### 4.8 Legal and paperwork

Partner terms page; terms of service bump (with the login prompt, and update the modal copy);
privacy policy covers partner payout data; data export and GDPR erase include partner rows;
notification templates (approved, commission earned, payout sent).

## 5. Build order

1. SQL + Drizzle schema (§4.1). Apply to staging, then prod before deploy.
2. Ledger: webhook writes on both first-payment paths + `invoice.paid`, `charge.refunded` handler,
   nightly flip, rate lock at first subscription. Tests for idempotency, VAT exclusion, duration
   window, refund void, no double-earning with tokens, and rate periods: partner beats programme,
   boundary instants (subscribed exactly at `starts_at` / `ends_at`), trial in one period + paid
   in the next, no overlaps, no programme gaps, started period's rate frozen.
3. Admin Rates + Applications + Partners.
4. `/partners` apply page, `/invite/<code>`, "Invited by" field, click counter.
5. Partner hub.
6. Ledger + Payouts admin views, Wise CSV.
7. Optional partner promo codes.
8. Assistant partner mode + handoffs + suggestions.
9. Legal pages, help articles, notifications. Then go-live.

## 6. Open questions

1. ~~Rate changes and existing referrals~~ — **decided 2026-10-18:** dated rate periods; a
   subscriber keeps the rate of the period they subscribed in (§4.1, §4.3).
2. Can an existing customer be both? (Suggest: once approved as a partner, their new referrals earn
   cash; earned tokens stay spendable.)
3. Currency: GBP only to start?

## 7. Not building (yet)

- "Track 2" from the proposal — users promoting **other companies'** affiliate offers. Different
  product, brand and disclosure risk, overlaps Social/Email/Campaign. Revisit if customers ask.
- Multi-tier (partners earning on partners they recruit).
- Volume tiers (rate rising with a partner's active customers). Dated periods per partner cover
  most of the same need by hand; add tiers only if manual bumps become a chore.
- Automated payouts / tax-form collection.
