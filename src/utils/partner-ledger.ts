// src/utils/partner-ledger.ts
// Affiliate Partner Programme — the commission ledger (docs/affiliate-partner-programme-plan.md §4.3).
//
// Called from stripe-webhook.ts on every customer payment that takes money, on refunds and on
// disputes, and from the nightly sweep. Partners earn CASH; ordinary customers who refer a friend
// stay on the token track (referral-offer.ts / referral-tokens.ts) — a referral is a partner
// referral only when its referrer has an APPROVED partners row at the time of the payment.
//
// The rules:
//   - The rate is fixed at the customer's FIRST payment that takes money: the period covering
//     that moment (partner's own period first, else programme-wide) is copied onto
//     partner_referrals and kept for the customer's whole commission window (partner-rate-periods.ts).
//   - Commission is on what the customer actually paid, excluding VAT, rounded down to the penny.
//   - One 'invoice' row per payment reference: the partial unique index on stripe_invoice_id makes
//     a redelivered webhook a no-op.
//   - Each row is 'pending' until the holding period ends, then the nightly sweep makes it
//     'payable'. Refunds and disputes reduce or void unpaid rows; an already-PAID row gets a
//     negative 'adjustment' carried into the next payout. A dispute we WIN undoes the dispute's
//     part (reinstateDisputedCommission).
//
// stripe_charge_id holds the payment's PaymentIntent id (pi_…), not a charge id: since Stripe API
// 'dahlia' an invoice exposes its PaymentIntent, not a charge, and refunds and disputes both carry
// payment_intent — so that is the key both sides can see.

import { notifyCommissionEarned } from './partner-notify';
import { runOffAllows } from './partner-activity';
import { UK_VAT_RATE_BPS } from './partner-statements';
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    partnerCommissions, partnerProgrammeSettings, partnerRatePeriods, partnerReferrals, partners, userReferrals,
} from '../../db/schema';
import {
    addMonthsUtc, commissionPence, isWithinCommissionWindow, lockTerms, resolvePeriodAt, type RatePeriod,
} from './partner-rate-periods';
import { applyCostRule, serviceSlices, sliceRef } from './partner-costs';
import { termsIncludeActualCosts } from '../config/partner-terms';

type Db = ReturnType<typeof getDb>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const PROGRAMME_CURRENCY = 'GBP';
/** What a dispute writes, and what a WON dispute looks for to undo it (reinstateDisputedCommission). */
export const DISPUTE_REASON = 'Payment disputed';
const DISPUTE_WON_NOTE = 'Dispute won — commission returned';

export interface PartnerPayment {
    /** The referred customer who paid. */
    userId: number;
    /** Unique per payment: the Stripe invoice id (in_…), or the PaymentIntent id when no invoice id is to hand. */
    paymentRef: string;
    /** pi_… — what refunds and disputes are matched on. */
    paymentIntentId: string | null;
    /** What the customer actually paid, excluding VAT, in pence (in `currency`'s minor units when not GBP). */
    netAmountPence: number;
    currency: string;
    paidAt: Date;
    /**
     * Partner Terms 3.2 (cross-border review): a payment in another currency counts at the sterling amount our
     * provider converted it into. The webhook works this out from Stripe's balance transaction; null when
     * it couldn't — then nothing is recorded and the webhook logs it for recording by hand.
     */
    gbpNetAmountPence?: number | null;
    /** The period this payment covers (invoice line), for the pro-rata and annual-holding rules (Terms 3.2, 4.1). */
    periodStart?: Date | null;
    periodEnd?: Date | null;
    /** True for an annual plan payment when the period isn't known (first payment via Checkout). */
    annual?: boolean;
    /** The card / payment processing fee Stripe charged on this payment, in pence (actual costs, Terms 3.2). Null = unknown. */
    cardFeePence?: number | null;
}

export type RecordOutcome =
    | { recorded: true; commissionPence: number; partnerId: number }
    | { recorded: false; reason: 'not_a_partner_referral' | 'no_amount' | 'currency' | 'no_rate' | 'outside_window' | 'duplicate'
        | 'suspended' | 'ended' | 'before_partnership' };

/** What a Stripe invoice actually collected, excluding VAT. Customer-balance credit is not money. */
export function invoiceNetPence(invoice: { amount_paid?: number | null; total?: number | null; total_excluding_tax?: number | null }): number {
    const paid = invoice.amount_paid ?? 0;
    const total = invoice.total ?? paid;
    const tax = Math.max(0, total - (invoice.total_excluding_tax ?? total));
    return Math.max(0, paid - tax);
}

/**
 * Partner Terms 1.3 §3.2: commission is earned only on Subscription Payments — the customer's
 * recurring plan, including upgrading it. Of the invoices that reach invoice.paid (the first one,
 * `subscription_create`, is handled by the checkout paths), only renewals and plan changes count;
 * one-off (`manual`), usage (`subscription_threshold`) and any other invoices earn nothing.
 * Packs and top-ups never get here: their Checkout sessions return before the plan path.
 */
const SUBSCRIPTION_PAYMENT_REASONS = new Set(['subscription_cycle', 'subscription_update']);
export function isSubscriptionPaymentInvoice(billingReason: string | null | undefined): boolean {
    return !!billingReason && SUBSCRIPTION_PAYMENT_REASONS.has(billingReason);
}

/** What a Checkout Session collected, excluding VAT. */
export function sessionNetPence(session: { amount_total?: number | null; total_details?: { amount_tax?: number | null } | null }): number {
    return Math.max(0, (session.amount_total ?? 0) - (session.total_details?.amount_tax ?? 0));
}

/**
 * The partner behind this customer's referral, if any: approved, suspended (terms still lock at the
 * real first payment, so §7.5(b) and the window are right — but nothing is earned) or ended (the
 * §7.2 / §7.5(h) run-off decides). Applied / rejected partners never earn.
 */
async function findPartnerReferral(db: Db, referredUserId: number) {
    const [row] = await db
        .select({
            referralId: userReferrals.id, partnerId: partners.id, referralCode: userReferrals.referralCode, promoCode: partners.promoCode,
            status: partners.status, partnerSince: partners.partnerSince, endedAt: partners.endedAt, endReason: partners.endReason,
        })
        .from(userReferrals)
        .innerJoin(partners, eq(partners.userId, userReferrals.referrerId))
        .where(and(eq(userReferrals.referredUserId, referredUserId), inArray(partners.status, ['approved', 'suspended', 'ended'])))
        .limit(1);
    return row ?? null;
}

/** Cheap pre-check (review of #823): is this customer a partner referral at all? Saves Stripe lookups. */
export async function hasPartnerReferral(db: Db, referredUserId: number): Promise<boolean> {
    return !!(await findPartnerReferral(db, referredUserId));
}

/**
 * True when this referrer is on the partner track — approved, suspended or ENDED. Their referrals
 * never earn a token; referral-offer.ts marks them 'partner' instead of 'qualified'. Ended is here
 * because Partner Terms 1.3 §7.4: after a partnership ends the link earns neither commission nor
 * refer-a-friend rewards.
 */
export async function isPartnerReferrer(db: Db, referrerId: number): Promise<boolean> {
    const [row] = await db.select({ id: partners.id }).from(partners)
        .where(and(eq(partners.userId, referrerId), inArray(partners.status, ['approved', 'suspended', 'ended'])))
        .limit(1);
    return !!row;
}

async function loadPeriods(db: Db, partnerId: number): Promise<RatePeriod[]> {
    return db.select({
        id: partnerRatePeriods.id,
        partnerId: partnerRatePeriods.partnerId,
        rateBps: partnerRatePeriods.rateBps,
        costDeductionBps: partnerRatePeriods.costDeductionBps,
        durationMonths: partnerRatePeriods.durationMonths,
        startsAt: partnerRatePeriods.startsAt,
        endsAt: partnerRatePeriods.endsAt,
    }).from(partnerRatePeriods)
        .where(or(isNull(partnerRatePeriods.partnerId), eq(partnerRatePeriods.partnerId, partnerId)));
}

async function holdingDays(db: Db): Promise<number> {
    const [row] = await db.select({ holdingDays: partnerProgrammeSettings.holdingDays })
        .from(partnerProgrammeSettings).where(eq(partnerProgrammeSettings.id, 1)).limit(1);
    return row?.holdingDays ?? 30;
}

/**
 * Get (or create) the partner_referrals row and lock its terms at this payment if this is the
 * first one. The lock is a conditional UPDATE (subscribed_at IS NULL), so two concurrent first
 * payments cannot lock different rates — the loser re-reads the winner's terms.
 */
async function lockedTermsFor(db: Db, referralId: number, partnerId: number, paidAt: Date, source: 'link' | 'promo_code' = 'link') {
    await db.insert(partnerReferrals).values({ referralId, partnerId, source }).onConflictDoNothing();
    const [pr] = await db.select().from(partnerReferrals).where(eq(partnerReferrals.referralId, referralId)).limit(1);
    if (!pr) return null;
    if (pr.subscribedAt && pr.rateBps !== null) return pr;

    const period = resolvePeriodAt(await loadPeriods(db, partnerId), partnerId, paidAt);
    if (!period) return null;
    const terms = lockTerms(period);
    // Which rule this customer follows is fixed now, with their terms: actual costs only if the partner had accepted the
    // Terms version with that rule; otherwise the fixed deduction they were promised (review of #827).
    const [partnerRow] = await db.select({ termsVersion: partners.termsVersion }).from(partners).where(eq(partners.id, partnerId)).limit(1);
    const costBasis = termsIncludeActualCosts(partnerRow?.termsVersion) ? 'actual' : 'fixed';
    await db.update(partnerReferrals)
        .set({ subscribedAt: paidAt, ratePeriodId: terms.ratePeriodId, rateBps: terms.rateBps, costDeductionBps: terms.costDeductionBps, durationMonths: terms.durationMonths, costBasis })
        .where(and(eq(partnerReferrals.id, pr.id), isNull(partnerReferrals.subscribedAt)));
    const [locked] = await db.select().from(partnerReferrals).where(eq(partnerReferrals.id, pr.id)).limit(1);
    return locked ?? null;
}

/** Record the commission a customer payment earns its partner, if any. Idempotent per paymentRef. */
export async function recordPartnerPayment(db: Db, payment: PartnerPayment): Promise<RecordOutcome> {
    if (!(payment.netAmountPence > 0)) return { recorded: false, reason: 'no_amount' };
    const ref = await findPartnerReferral(db, payment.userId);
    if (!ref) return { recorded: false, reason: 'not_a_partner_referral' };
    // Terms 3.2: another currency counts at the sterling amount our provider converted it into.
    let netPence = payment.netAmountPence;
    if (payment.currency.toUpperCase() !== PROGRAMME_CURRENCY) {
        if (!(typeof payment.gbpNetAmountPence === 'number' && payment.gbpNetAmountPence > 0)) {
            console.error('[partner-ledger] payment in another currency with no sterling amount — NOT recorded, record it by hand', payment);
            return { recorded: false, reason: 'currency' };
        }
        netPence = payment.gbpNetAmountPence;
    }

    // Ended: a customer who never paid before the end earns nothing, and nothing is locked for them (§7.4).
    if (ref.status === 'ended') {
        const [existing] = await db.select().from(partnerReferrals).where(eq(partnerReferrals.referralId, ref.referralId)).limit(1);
        if (!existing?.subscribedAt || !ref.endedAt || existing.subscribedAt.getTime() >= ref.endedAt.getTime()) return { recorded: false, reason: 'ended' };
        if (!runOffAllows(ref.endReason, ref.endedAt, existing.durationMonths, payment.paidAt)) return { recorded: false, reason: 'ended' };
    }

    // Came in on the partner's memorable partner code rather than their link (invite-codes.ts)?
    const viaPartnerCode = !!ref.promoCode && ref.referralCode?.toUpperCase() === ref.promoCode.toUpperCase();
    const terms = await lockedTermsFor(db, ref.referralId, ref.partnerId, payment.paidAt, viaPartnerCode ? 'promo_code' : 'link');
    if (!terms || terms.rateBps === null || !terms.subscribedAt) {
        console.error('[partner-ledger] no rate period covers this payment — the programme has a gap', payment);
        return { recorded: false, reason: 'no_rate' };
    }
    // Suspended: the terms are locked at the real first payment above, but nothing is earned (§7.2).
    // If THIS payment is the one that locked them, the customer never counts towards §7.5 (b).
    if (ref.status === 'suspended') {
        if (terms.subscribedAt.getTime() === payment.paidAt.getTime()) {
            await db.update(partnerReferrals).set({ lockedWhileSuspended: true }).where(eq(partnerReferrals.id, terms.id));
        }
        return { recorded: false, reason: 'suspended' };
    }
    // §7.5(i): after re-approval, only customers who first pay in the current partnership earn.
    if (ref.partnerSince && terms.subscribedAt.getTime() < ref.partnerSince.getTime()) return { recorded: false, reason: 'before_partnership' };
    if (!isWithinCommissionWindow(terms.subscribedAt, terms.durationMonths, payment.paidAt)) {
        return { recorded: false, reason: 'outside_window' };
    }

    // Locked before the cost deduction existed → null → 0%: what that customer was promised stands.
    // Since actual costs (Terms 3.2, docs/partner-actual-costs-plan.md) this is the MINIMUM deduction.
    const costDeductionBps = terms.costDeductionBps ?? 0;
    // Terms 3.2: a payment covering months beyond the commission period earns only on the months inside it.
    const windowEnd = terms.durationMonths === null ? null : addMonthsUtc(terms.subscribedAt, terms.durationMonths);
    const isAnnual = payment.annual === true || isAnnualPeriod(payment.periodStart ?? null, payment.periodEnd ?? null);
    // Terms 4.1: an annual Subscription Payment is held for at least 60 days.
    const holdDaysFixed = Math.max(await holdingDays(db), isAnnual ? ANNUAL_HOLDING_DAYS : 0);

    // A customer on the FIXED rule (locked before actual costs, or their partner hasn't accepted the Terms with it): one
    // row, the fixed deduction, released after the holding period exactly as before — no month-end costs (review of #827).
    if (terms.costBasis !== 'actual') {
        const eligiblePence = proRataPence(netPence, payment.periodStart ?? null, payment.periodEnd ?? null, windowEnd);
        const fixedAmount = commissionPence(eligiblePence, terms.rateBps, costDeductionBps);
        const availableAtFixed = new Date(payment.paidAt.getTime() + holdDaysFixed * DAY_MS);
        const ins = await db.insert(partnerCommissions).values({
            partnerId: ref.partnerId, partnerReferralId: terms.id, kind: 'invoice',
            stripeInvoiceId: payment.paymentRef, stripeChargeId: payment.paymentIntentId,
            netAmountPence: eligiblePence, rateBps: terms.rateBps, costDeductionBps, commissionPence: fixedAmount,
            currency: PROGRAMME_CURRENCY, status: 'pending', availableAt: availableAtFixed,
        }).onConflictDoNothing().returning({ id: partnerCommissions.id });
        if (!ins.length) return { recorded: false, reason: 'duplicate' };
        if (fixedAmount > 0) await notifyCommissionEarned(db, ref.partnerId, fixedAmount, availableAtFixed);
        return { recorded: true, commissionPence: fixedAmount, partnerId: ref.partnerId };
    }

    const periodStart = payment.periodStart ?? (isAnnual ? payment.paidAt : null);
    const periodEnd = payment.periodEnd ?? (isAnnual ? addMonthsUtc(payment.paidAt, 12) : null);
    // Each month of service is its own row (an annual payment → 12), worked out against that month's actual costs at
    // month end (partner-commission-sweep.ts trueUpCommissions). Recorded now provisionally at the minimum deduction,
    // and not releasable until its month has been checked.
    const slices = serviceSlices(netPence, periodStart, periodEnd, payment.paidAt)
        .filter((sl) => !windowEnd || sl.periodStart.getTime() < windowEnd.getTime());
    if (!slices.length) return { recorded: false, reason: 'outside_window' };
    const holdDays = holdDaysFixed;
    const holdUntil = payment.paidAt.getTime() + holdDays * DAY_MS;
    const values = slices.map((sl, i) => {
        // The month that straddles the end of the commission period earns only on its days inside it (pro rata).
        const eligible = proRataPence(sl.netPence, sl.periodStart, sl.periodEnd, windowEnd);
        return {
            partnerId: ref.partnerId,
            partnerReferralId: terms.id,
            kind: 'invoice',
            stripeInvoiceId: sliceRef(payment.paymentRef, sl, slices.length),
            stripeChargeId: payment.paymentIntentId,
            netAmountPence: eligible,
            rateBps: terms.rateBps!,
            costDeductionBps,
            commissionPence: commissionPence(eligible, terms.rateBps!, costDeductionBps),
            currency: PROGRAMME_CURRENCY,
            status: 'pending',
            servicePeriodStart: sl.periodStart,
            servicePeriodEnd: sl.periodEnd,
            // The whole payment's card fee belongs to its first month.
            cardFeePence: i === 0 && typeof payment.cardFeePence === 'number' ? Math.max(0, Math.round(payment.cardFeePence)) : null,
            availableAt: new Date(Math.max(holdUntil, sl.periodEnd.getTime())),
        };
    });
    const inserted = await db.insert(partnerCommissions).values(values).onConflictDoNothing().returning({ ref: partnerCommissions.stripeInvoiceId });
    if (!inserted.length) return { recorded: false, reason: 'duplicate' };
    // Only what was actually recorded now (a redelivery that finds some months already there adds — and announces — only the rest).
    const insertedRefs = new Set(inserted.map((r) => r.ref));
    const amount = values.filter((v) => insertedRefs.has(v.stripeInvoiceId)).reduce((n, v) => n + v.commissionPence, 0);
    // Tell the partner (in-app + email): "up to" — the month-end costs can lower it. Never throws; a redelivery never gets here.
    if (amount > 0) await notifyCommissionEarned(db, ref.partnerId, amount, values[0].availableAt);
    return { recorded: true, commissionPence: amount, partnerId: ref.partnerId };
}

/**
 * What a payment's commission row earns on `remainingNetPence` (after refunds): with its measured month-end costs once
 * checked (the customer used the service, so costs stay), else at the minimum deduction. Used by refunds and disputes.
 */
export function commissionForRow(row: {
    rateBps: number | null; costDeductionBps: number; costsCheckedAt?: Date | null;
    costPence?: number | null; cardFeePence?: number | null; carryInPence?: number | null;
}, remainingNetPence: number): number {
    if (!row.costsCheckedAt) return commissionPence(remainingNetPence, row.rateBps ?? 0, row.costDeductionBps);
    return applyCostRule({
        paymentPence: remainingNetPence, minDeductionBps: row.costDeductionBps, costPence: row.costPence ?? 0,
        cardFeePence: row.cardFeePence ?? 0, carryInPence: row.carryInPence ?? 0, rateBps: row.rateBps ?? 0,
    }).commissionPence;
}

/** Terms 4.1: annual Subscription Payments are held at least this long. */
export const ANNUAL_HOLDING_DAYS = 60;

/**
 * An annual plan payment covers ~365 days. 200 days, not 40: a monthly invoice with a proration line plus the next
 * month can span ~60 days and must not be held 60 days as if annual (review of #823).
 */
export function isAnnualPeriod(start: Date | null, end: Date | null): boolean {
    return !!(start && end && end.getTime() - start.getTime() > 200 * DAY_MS);
}

/**
 * Terms 3.2 pro rata: the part of a payment for the months inside the commission period. Full amount when
 * the period is unknown, has no end beyond the window, or the window is lifetime (null). Rounds down.
 */
export function proRataPence(netPence: number, periodStart: Date | null, periodEnd: Date | null, windowEnd: Date | null): number {
    if (!windowEnd || !periodStart || !periodEnd) return netPence;
    const span = periodEnd.getTime() - periodStart.getTime();
    if (span <= 0 || periodEnd.getTime() <= windowEnd.getTime()) return netPence;
    const inside = Math.max(0, windowEnd.getTime() - periodStart.getTime());
    return Math.floor((netPence * inside) / span);
}

/** Partner Terms 4.3: refunds and disputes more than 180 days after the payment don't touch commission. */
export const CLAWBACK_WINDOW_DAYS = 180;
export function isPastClawbackWindow(paidAt: Date, eventAt: Date): boolean {
    return eventAt.getTime() - paidAt.getTime() > CLAWBACK_WINDOW_DAYS * DAY_MS;
}

export interface ReversalInput {
    /** pi_… from the refund's or dispute's charge. */
    paymentIntentId: string | null;
    /** The invoice the payment belonged to, when known — a fallback match for rows stored without a PaymentIntent. */
    invoiceId?: string | null;
    /** Total refunded so far on this payment, in pence (Stripe's charge.amount_refunded). Ignored for a dispute. */
    amountRefundedPence: number;
    kind: 'refund' | 'dispute';
    at?: Date;
    /**
     * The charge's full amount (charge.amount), same currency as amountRefundedPence. When given, a refund
     * reduces commission by the refunded SHARE of the payment — right for any currency (a non-GBP payment's
     * row holds its sterling net, which a foreign-currency refund amount can't be subtracted from).
     */
    chargeAmountMinor?: number | null;
}

/**
 * What is left of a payment's net (excl. VAT, in sterling) after refunds: net × the charge's unrefunded share when
 * the charge amount is known (any currency, VAT-inclusive refunds), else net − refunded. Never below 0.
 */
export function remainingNetPence(netPence: number, chargeAmountMinor: number, refundedMinor: number): number {
    if (chargeAmountMinor > 0) return Math.max(0, Math.floor((netPence * Math.max(0, chargeAmountMinor - refundedMinor)) / chargeAmountMinor));
    return Math.max(0, netPence - refundedMinor);
}

const DISPUTE_OFFSET_NOTE = 'Payment disputed — earlier adjustment offset';
const REFUND_REASONS = ['Payment refunded', 'Payment partly refunded'];

/**
 * ONE RULE for refunds, disputes and won disputes (rewrite after the review of #824): everything recorded for a
 * payment — its invoice row (unless voided) plus every adjustment and bonus linked to it — must add up to what the
 * payment should earn now. The planner is pure so the tricky sequences are tested without a database
 * (tests/partner-ledger-reconcile.test.ts).
 *
 *   rowEditable  the invoice row is unpaid and not in an exported or paid run — it can be changed in place;
 *                otherwise (paid, or its file may already have been sent) only adjustments (−) / bonuses (+) are added.
 *   others       the sum of adjustments and payment-linked bonuses already recorded.
 * A dispute always voids an editable row with DISPUTE_REASON, so a later refund knows a dispute is open and a won
 * dispute can find it; any earlier refund adjustment is offset so the total is exactly 0 while disputed.
 */
export interface ReconcileState {
    rowStatus: 'pending' | 'payable' | 'paid' | 'voided';
    rowCommission: number;
    rowVoidReason: string | null;
    rowEditable: boolean;
    others: number;
    disputeAdjustmentsOpen: boolean;   // a paid/exported row's dispute clawback not yet returned
}
export type ReconcileEvent = { kind: 'refund' | 'dispute'; desired: number; reason: string } | { kind: 'dispute_won'; desired: number };
export interface ReconcilePlan {
    row: null | { void: true; reason: string } | { void: false; amount: number };
    extra: null | { pence: number; note: string };   // < 0 → 'adjustment', > 0 → 'bonus'
    closeDispute?: true;                              // also write a £0 'Dispute won' row
}

export function planReconcile(st: ReconcileState, ev: ReconcileEvent): ReconcilePlan {
    const none: ReconcilePlan = { row: null, extra: null };
    // An admin's own cancellation (fraud, breach) is never touched by Stripe events.
    if (st.rowStatus === 'voided' && st.rowVoidReason && st.rowVoidReason !== DISPUTE_REASON && !REFUND_REASONS.includes(st.rowVoidReason)) return none;
    const disputeOpen = (st.rowStatus === 'voided' && st.rowVoidReason === DISPUTE_REASON) || st.disputeAdjustmentsOpen;
    const rowCredited = st.rowStatus === 'voided' ? 0 : st.rowCommission;
    const total = rowCredited + st.others;
    const extraFor = (pence: number, note: string): ReconcilePlan['extra'] => (pence === 0 ? null : { pence, note });

    if (ev.kind === 'refund') {
        if (disputeOpen) return none;                     // the dispute decides; a won dispute applies refunds
        if (st.rowEditable && st.rowStatus !== 'voided') {
            const want = ev.desired - st.others;
            if (want <= 0) return { row: { void: true, reason: ev.reason }, extra: extraFor(Math.min(0, want), `${ev.reason} after adjustment`) };
            return want < st.rowCommission ? { row: { void: false, amount: want }, extra: null } : none;
        }
        const delta = ev.desired - total;
        return delta < 0 ? { row: null, extra: extraFor(delta, `${ev.reason} after payout`) } : none;
    }

    if (ev.kind === 'dispute') {
        if (disputeOpen) return none;                     // redelivered: already disputed
        if (st.rowEditable && st.rowStatus !== 'voided') {
            // Void (marks the dispute), then offset what's left so the total is 0.
            return { row: { void: true, reason: DISPUTE_REASON }, extra: extraFor(-st.others, DISPUTE_OFFSET_NOTE) };
        }
        const delta = 0 - total;
        return delta < 0 ? { row: null, extra: extraFor(delta, `${DISPUTE_REASON} after payout`) } : none;
    }

    // dispute_won: bring the total back to what the payment earns after any refunds.
    if (!disputeOpen) return none;
    if (st.disputeAdjustmentsOpen) {
        // The dispute was clawed back by an adjustment (row was paid / in an exported run): close it with ONE
        // 'Dispute won' bonus (even £0), so the dispute never stays "open" (review of #824).
        const delta = ev.desired - total;
        if (delta >= 0) return { row: null, extra: { pence: delta, note: DISPUTE_WON_NOTE } };
        // Not expected, but if it happens the dispute must still close: a £0 'Dispute won' row AND the adjustment.
        return { row: null, extra: { pence: delta, note: 'Payment refunded after payout' }, closeDispute: true };
    }
    // The row itself was voided as disputed: un-void it to what's earned, or record it as refunded.
    const want = ev.desired - st.others;
    if (want > 0) return { row: { void: false, amount: want }, extra: null };
    return { row: { void: true, reason: 'Payment refunded' }, extra: extraFor(want, 'Payment refunded after adjustment') };
}

interface ReversalRunInfo { inExportedOrPaid: boolean; draftBatchId: number | null }

async function runInfo(db: Db, row: typeof partnerCommissions.$inferSelect): Promise<ReversalRunInfo> {
    if (row.status === 'paid') return { inExportedOrPaid: true, draftBatchId: null };
    if (!row.payoutBatchId) return { inExportedOrPaid: false, draftBatchId: null };
    const [run] = (await db.execute(sql`SELECT status FROM partner_payout_batches WHERE id = ${row.payoutBatchId}`)) as unknown as Array<{ status: string }>;
    if (run?.status === 'draft') return { inExportedOrPaid: false, draftBatchId: row.payoutBatchId };
    return { inExportedOrPaid: true, draftBatchId: null };
}

/**
 * The planner's view of a payment, from its invoice row and the adjustment / bonus rows linked to it. Pure, and used by
 * BOTH stateFor and tests/partner-ledger-reconcile.test.ts so the two can never drift (review of #824).
 * Rows an admin has cancelled (status 'voided') don't count — neither towards the total nor the dispute open/closed check.
 */
export function deriveReconcileState(
    row: { status: string; commissionPence: number; voidReason: string | null; payoutBatchId: number | null },
    linked: Array<{ status: string; commissionPence: number; note: string | null }>,
    inExportedOrPaid: boolean,
): ReconcileState {
    const live = linked.filter((a) => a.status !== 'voided');
    const others = live.reduce((s, a) => s + a.commissionPence, 0);
    // Open = more dispute clawbacks than 'Dispute won' closures (counts, not sums: a won dispute after a partial
    // refund returns less than was clawed back, and must still close it).
    const clawbacks = live.filter((a) => a.note === `${DISPUTE_REASON} after payout`).length;
    const closures = live.filter((a) => a.note === DISPUTE_WON_NOTE).length;
    const status = row.status as ReconcileState['rowStatus'];
    return {
        rowStatus: status, rowCommission: row.commissionPence, rowVoidReason: row.voidReason ?? null,
        rowEditable: !inExportedOrPaid && (status !== 'voided' || !row.payoutBatchId),
        others, disputeAdjustmentsOpen: clawbacks > closures,
    };
}

async function stateFor(db: Db, row: typeof partnerCommissions.$inferSelect, info: ReversalRunInfo): Promise<ReconcileState> {
    const linked = await db.select().from(partnerCommissions).where(and(
        inArray(partnerCommissions.kind, ['adjustment', 'bonus']), eq(partnerCommissions.stripeInvoiceId, row.stripeInvoiceId!)));
    return deriveReconcileState(row, linked, info.inExportedOrPaid);
}

async function applyPlan(db: Db, row: typeof partnerCommissions.$inferSelect, plan: ReconcilePlan, at: Date, touched: Map<string, { batchId: number; partnerId: number }>, info: ReversalRunInfo): Promise<boolean> {
    if (!plan.row && !plan.extra) return false;
    // A £0 'Dispute won' bonus is written on purpose (it closes the dispute); other £0 extras never reach here.
    if (info.draftBatchId) touched.set(`${info.draftBatchId}:${row.partnerId}`, { batchId: info.draftBatchId, partnerId: row.partnerId });
    if (plan.row?.void) {
        // A voided row leaves any unpaid run, so marking the run paid can never pay (or un-void) it.
        await db.update(partnerCommissions).set({ status: 'voided', voidedAt: at, voidReason: plan.row.reason, payoutBatchId: null })
            .where(eq(partnerCommissions.id, row.id));
    } else if (plan.row) {
        // A month not yet costed goes back to 'pending' even if its date has passed: the true-up must run before it can be
        // released, or a won dispute would pay a heavy user's month at the provisional figure (review of #827).
        const uncosted = !!row.servicePeriodEnd && !row.costsCheckedAt;
        const status = row.status === 'voided' ? (!uncosted && row.availableAt && row.availableAt <= at ? 'payable' : 'pending') : row.status;
        await db.update(partnerCommissions).set({
            status, commissionPence: plan.row.amount, voidedAt: null, voidReason: null,
            note: row.status === 'voided' ? `Dispute won — reinstated ${at.toISOString().slice(0, 10)}` : `Adjusted: was ${row.commissionPence}p`,
        }).where(eq(partnerCommissions.id, row.id));
    }
    const insertExtra = (pence: number, note: string) => db.insert(partnerCommissions).values({
        partnerId: row.partnerId, partnerReferralId: row.partnerReferralId,
        kind: pence < 0 ? 'adjustment' : 'bonus',
        stripeInvoiceId: row.stripeInvoiceId, stripeChargeId: row.stripeChargeId,
        commissionPence: pence, currency: row.currency, status: 'payable', availableAt: at, note,
    });
    if (plan.extra) await insertExtra(plan.extra.pence, plan.extra.note);
    if (plan.closeDispute) await insertExtra(0, DISPUTE_WON_NOTE);
    return true;
}

/**
 * An annual payment is 12 rows `<ref>#m1…#m12` (actual costs, partner-costs.ts sliceRef). A refund or dispute that
 * carries only the invoice id (a first annual payment via Checkout is recorded without a PaymentIntent) must still find
 * all 12 — review of #827. Stripe ids contain `_`, a LIKE wildcard, so it is escaped (backslash is Postgres's default
 * LIKE escape); ids are letters, digits and `_` only, so nothing else needs escaping.
 */
export function sliceLikePattern(key: string): string {
    return key.replace(/_/g, '\\_') + '#m%';
}
function sliceRefMatchers(keys: string[]) {
    return keys.filter((k) => /^[A-Za-z0-9_]+$/.test(k)).map((k) => sql`${partnerCommissions.stripeInvoiceId} LIKE ${sliceLikePattern(k)}`);
}

/**
 * A refund or dispute on a payment: bring its commission to what the remaining payment earns (0 for a dispute).
 * Idempotent: targets come from the TOTAL refunded so far and the state already recorded. Partner Terms 4.3: a
 * refund or dispute more than 180 days after the payment changes nothing.
 */
export async function reversePartnerCommission(db: Db, input: ReversalInput): Promise<{ adjusted: number }> {
    const keys = [input.paymentIntentId, input.invoiceId].filter((k): k is string => !!k);
    if (!keys.length) return { adjusted: 0 };
    const rows = await db.select().from(partnerCommissions).where(and(
        eq(partnerCommissions.kind, 'invoice'),
        or(inArray(partnerCommissions.stripeChargeId, keys), inArray(partnerCommissions.stripeInvoiceId, keys), ...sliceRefMatchers(keys)),
    ));
    const at = input.at ?? new Date();
    let adjusted = 0;
    const touched = new Map<string, { batchId: number; partnerId: number }>();
    for (const row of rows) {
        if (isPastClawbackWindow(row.createdAt, at)) continue;
        const remaining = input.kind === 'dispute' ? 0 : remainingNetPence(row.netAmountPence ?? 0, input.chargeAmountMinor ?? 0, input.amountRefundedPence);
        const desired = commissionForRow(row, remaining);
        const reason = input.kind === 'dispute' ? DISPUTE_REASON : (remaining === 0 ? 'Payment refunded' : 'Payment partly refunded');
        const info = await runInfo(db, row);
        const plan = planReconcile(await stateFor(db, row, info), { kind: input.kind, desired, reason });
        if (await applyPlan(db, row, plan, at, touched, info)) adjusted++;
    }
    for (const r of touched.values()) await refreshRunAfterChange(db, r.batchId, r.partnerId);
    return { adjusted };
}

/**
 * A commission in a DRAFT run changed: recompute the partner's frozen VAT from what the run
 * now pays them, and the run's total, so exports and statements stay consistent (review of #823). Paid runs never change.
 */
async function refreshRunAfterChange(db: Db, batchId: number, partnerId: number): Promise<void> {
    const [run] = (await db.execute(sql`SELECT status FROM partner_payout_batches WHERE id = ${batchId}`)) as unknown as Array<{ status: string }>;
    if (!run || run.status !== 'draft') return;
    const [{ amount }] = (await db.execute(sql`
        SELECT COALESCE(SUM(commission_pence), 0)::int AS amount FROM partner_commissions
         WHERE payout_batch_id = ${batchId} AND partner_id = ${partnerId}`)) as unknown as Array<{ amount: number }>;
    await db.execute(sql`
        UPDATE partner_payout_vat SET vat_pence = CASE WHEN vat_number IS NULL OR ${Number(amount)} <= 0 THEN 0
                                                       ELSE ROUND(${Number(amount)} * ${UK_VAT_RATE_BPS}::numeric / 10000)::int END
         WHERE batch_id = ${batchId} AND partner_id = ${partnerId}`);
    await db.execute(sql`
        UPDATE partner_payout_batches SET total_pence = (SELECT COALESCE(SUM(commission_pence), 0)::int FROM partner_commissions WHERE payout_batch_id = ${batchId}),
               partner_count = (SELECT COUNT(DISTINCT partner_id)::int FROM partner_commissions WHERE payout_batch_id = ${batchId})
         WHERE id = ${batchId}`);
}

/**
 * A dispute we WON (charge.dispute.closed, status 'won'): bring the payment's commission back to what it earns after
 * any refunds (same one rule as reversePartnerCommission). Idempotent: a second delivery finds the total already right.
 */
export async function reinstateDisputedCommission(db: Db, input: {
    paymentIntentId: string | null; invoiceId?: string | null;
    /** Refunded on the charge so far (charge.amount_refunded) — that part stays unearned. */
    amountRefundedPence?: number; at?: Date;
    /** The charge's own amount, in its currency: the refunded SHARE is used, like reversePartnerCommission. */
    chargeAmountMinor?: number | null;
}): Promise<{ reinstated: number }> {
    const keys = [input.paymentIntentId, input.invoiceId].filter((k): k is string => !!k);
    if (!keys.length) return { reinstated: 0 };
    const at = input.at ?? new Date();
    const rows = await db.select().from(partnerCommissions).where(and(
        eq(partnerCommissions.kind, 'invoice'),
        or(inArray(partnerCommissions.stripeChargeId, keys), inArray(partnerCommissions.stripeInvoiceId, keys), ...sliceRefMatchers(keys)),
    ));
    let reinstated = 0;
    const touched = new Map<string, { batchId: number; partnerId: number }>();
    for (const row of rows) {
        const st0 = await stateFor(db, row, await runInfo(db, row));
        // Only act if a dispute is actually open on this payment (a stray 'won' event changes nothing).
        if (!((st0.rowStatus === 'voided' && st0.rowVoidReason === DISPUTE_REASON) || st0.disputeAdjustmentsOpen)) continue;
        const remaining = remainingNetPence(row.netAmountPence ?? 0, input.chargeAmountMinor ?? 0, input.amountRefundedPence ?? 0);
        const desired = commissionForRow(row, remaining);
        const info = await runInfo(db, row);
        const plan = planReconcile(st0, { kind: 'dispute_won', desired });
        await applyPlan(db, row, plan, at, touched, info);
        // "Reinstated" = money actually put back (a row un-voided, or a positive bonus), not a dispute merely closed.
        if ((plan.row && !plan.row.void) || (plan.extra && plan.extra.pence > 0)) reinstated++;
    }
    for (const r of touched.values()) await refreshRunAfterChange(db, r.batchId, r.partnerId);
    return { reinstated };
}

/**
 * Nightly: pending commissions whose holding period has ended become payable — but only once their month's actual
 * costs have been checked (trueUpCommissions, which runs first). Rows from before actual costs (no service period),
 * bonuses and adjustments release as before.
 */
export async function releaseDueCommissions(db: Db, now: Date = new Date()): Promise<{ released: number }> {
    const released = await db.update(partnerCommissions)
        .set({ status: 'payable' })
        .where(and(eq(partnerCommissions.status, 'pending'), lte(partnerCommissions.availableAt, now),
            or(sql`${partnerCommissions.costsCheckedAt} IS NOT NULL`, sql`${partnerCommissions.servicePeriodEnd} IS NULL`, sql`${partnerCommissions.kind} <> 'invoice'`)))
        .returning({ id: partnerCommissions.id });
    return { released: released.length };
}
