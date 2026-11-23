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
    await db.update(partnerReferrals)
        .set({ subscribedAt: paidAt, ratePeriodId: terms.ratePeriodId, rateBps: terms.rateBps, costDeductionBps: terms.costDeductionBps, durationMonths: terms.durationMonths })
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
    const costDeductionBps = terms.costDeductionBps ?? 0;
    // Terms 3.2: a payment covering months beyond the commission period earns only on the months inside it.
    const windowEnd = terms.durationMonths === null ? null : addMonthsUtc(terms.subscribedAt, terms.durationMonths);
    const eligiblePence = proRataPence(netPence, payment.periodStart ?? null, payment.periodEnd ?? null, windowEnd);
    const amount = commissionPence(eligiblePence, terms.rateBps, costDeductionBps);
    // Terms 4.1: an annual Subscription Payment is held for at least 60 days.
    const isAnnual = payment.annual === true || isAnnualPeriod(payment.periodStart ?? null, payment.periodEnd ?? null);
    const holdDays = Math.max(await holdingDays(db), isAnnual ? ANNUAL_HOLDING_DAYS : 0);
    const availableAt = new Date(payment.paidAt.getTime() + holdDays * DAY_MS);
    const inserted = await db.insert(partnerCommissions).values({
        partnerId: ref.partnerId,
        partnerReferralId: terms.id,
        kind: 'invoice',
        stripeInvoiceId: payment.paymentRef,
        stripeChargeId: payment.paymentIntentId,
        netAmountPence: eligiblePence,
        rateBps: terms.rateBps,
        costDeductionBps,
        commissionPence: amount,
        currency: PROGRAMME_CURRENCY,
        status: 'pending',
        availableAt,
    }).onConflictDoNothing().returning({ id: partnerCommissions.id });
    if (!inserted.length) return { recorded: false, reason: 'duplicate' };
    // Tell the partner (in-app + email). Never throws; a redelivery never gets here (duplicate above).
    if (amount > 0) await notifyCommissionEarned(db, ref.partnerId, amount, availableAt);
    return { recorded: true, commissionPence: amount, partnerId: ref.partnerId };
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
 * Reduce or void the commission on a refunded or disputed payment. Idempotent: the target is
 * recomputed from the TOTAL refunded so far, so a redelivered or second partial refund lands on
 * the same answer.
 *   - unpaid (pending / payable): commission reduced to what the remaining payment earns, or
 *     voided when nothing remains (always voided for a dispute);
 *   - already paid: a negative 'adjustment' for the difference not yet adjusted.
 */
export async function reversePartnerCommission(db: Db, input: ReversalInput): Promise<{ adjusted: number }> {
    const keys = [input.paymentIntentId, input.invoiceId].filter((k): k is string => !!k);
    if (!keys.length) return { adjusted: 0 };
    const rows = await db.select().from(partnerCommissions).where(and(
        eq(partnerCommissions.kind, 'invoice'),
        or(inArray(partnerCommissions.stripeChargeId, keys), inArray(partnerCommissions.stripeInvoiceId, keys)),
    ));
    const at = input.at ?? new Date();
    let adjusted = 0;
    const touchedRuns = new Map<string, { batchId: number; partnerId: number }>();

    for (const row of rows) {
        // A row in a run whose file is already EXPORTED may already have been sent: treat it like a paid row (leave it,
        // add a negative adjustment below) so the run, its statement and the 180-day clawback stay true. Only a DRAFT
        // run is changed in place (review of #823).
        let inExportedRun = false;
        if (row.payoutBatchId && (row.status === 'pending' || row.status === 'payable')) {
            const [run] = (await db.execute(sql`SELECT status FROM partner_payout_batches WHERE id = ${row.payoutBatchId}`)) as unknown as Array<{ status: string }>;
            inExportedRun = run?.status === 'exported';
            if (run?.status === 'draft') touchedRuns.set(`${row.payoutBatchId}:${row.partnerId}`, { batchId: row.payoutBatchId, partnerId: row.partnerId });
        }
        // Partner Terms 4.3 (cross-border review): only a refund or dispute within 180 days of the payment
        // reduces commission. The row is written by the webhook at the payment, so its created_at is the
        // payment time (a commission entered late by hand gets a later created_at — in the partner's favour).
        if (isPastClawbackWindow(row.createdAt, at)) continue;
        const remaining = input.kind === 'dispute' ? 0
            : remainingNetPence(row.netAmountPence ?? 0, input.chargeAmountMinor ?? 0, input.amountRefundedPence);
        const target = commissionPence(remaining, row.rateBps ?? 0, row.costDeductionBps);
        const reason = input.kind === 'dispute' ? DISPUTE_REASON : (remaining === 0 ? 'Payment refunded' : 'Payment partly refunded');

        if (row.status === 'voided') continue;
        if ((row.status === 'pending' || row.status === 'payable') && !inExportedRun) {
            // Adjustments already recorded for this payment (e.g. while it sat in an exported run that was then
            // cancelled) count too: row + adjustments must end at `target`, never below it (review of #823).
            const [{ adj }] = await db.select({ adj: sql<number>`COALESCE(SUM(${partnerCommissions.commissionPence}), 0)::int` })
                .from(partnerCommissions)
                .where(and(eq(partnerCommissions.kind, 'adjustment'), eq(partnerCommissions.stripeInvoiceId, row.stripeInvoiceId!)));
            const rowTarget = Math.max(0, target - Number(adj));   // adj is ≤ 0
            if (rowTarget === 0) {
                // A voided row leaves any unpaid run, so marking the run paid can never pay (or un-void) it.
                await db.update(partnerCommissions)
                    .set({ status: 'voided', voidedAt: at, voidReason: reason, payoutBatchId: null })
                    .where(eq(partnerCommissions.id, row.id));
                adjusted++;
            } else if (rowTarget < row.commissionPence) {
                await db.update(partnerCommissions)
                    .set({ commissionPence: rowTarget, note: `${reason}: was ${row.commissionPence}p` })
                    .where(eq(partnerCommissions.id, row.id));
                adjusted++;
            }
            continue;
        }

        // Paid already (or in an exported run): claw back the difference, net of any adjustment already made for this payment.
        const [{ sum }] = await db.select({ sum: sql<number>`COALESCE(SUM(${partnerCommissions.commissionPence}), 0)::int` })
            .from(partnerCommissions)
            .where(and(eq(partnerCommissions.kind, 'adjustment'), eq(partnerCommissions.stripeInvoiceId, row.stripeInvoiceId!)));
        const owedBack = row.commissionPence - target + Number(sum);   // sum is ≤ 0
        if (owedBack > 0) {
            await db.insert(partnerCommissions).values({
                partnerId: row.partnerId,
                partnerReferralId: row.partnerReferralId,
                kind: 'adjustment',
                stripeInvoiceId: row.stripeInvoiceId,
                stripeChargeId: row.stripeChargeId,
                commissionPence: -owedBack,
                currency: row.currency,
                status: 'payable',
                availableAt: at,
                note: `${reason} after payout`,
            });
            adjusted++;
        }
    }
    for (const r of touchedRuns.values()) await refreshRunAfterChange(db, r.batchId, r.partnerId);
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
 * A dispute we WON (charge.dispute.closed, status 'won'): undo what reversePartnerCommission did
 * when it opened. Idempotent:
 *   - rows voided as 'Payment disputed' go back to pending (or payable, if their hold has ended) —
 *     unless a payout run or a refund has touched them since;
 *   - money clawed back after payout ('Payment disputed after payout') is returned as a 'bonus' row
 *     (adjustments must be negative — partner_commissions_sign_check), net of any already returned.
 */
/**
 * What is left of a payment's net (excl. VAT, in sterling) after refunds: net × the charge's unrefunded share when
 * the charge amount is known (any currency, VAT-inclusive refunds), else net − refunded. Never below 0.
 */
export function remainingNetPence(netPence: number, chargeAmountMinor: number, refundedMinor: number): number {
    if (chargeAmountMinor > 0) return Math.max(0, Math.floor((netPence * Math.max(0, chargeAmountMinor - refundedMinor)) / chargeAmountMinor));
    return Math.max(0, netPence - refundedMinor);
}

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
    const match = or(inArray(partnerCommissions.stripeChargeId, keys), inArray(partnerCommissions.stripeInvoiceId, keys));
    let reinstated = 0;

    const voided = await db.select().from(partnerCommissions).where(and(
        eq(partnerCommissions.kind, 'invoice'), eq(partnerCommissions.status, 'voided'),
        eq(partnerCommissions.voidReason, DISPUTE_REASON), isNull(partnerCommissions.payoutBatchId), match,
    ));
    for (const row of voided) {
        // Same proportion as a refund (review of #823): net × unrefunded share of the charge, so VAT and other
        // currencies come out right. Falls back to net − refunded when the charge amount is unknown (GBP-only).
        const remaining = remainingNetPence(row.netAmountPence ?? 0, input.chargeAmountMinor ?? 0, input.amountRefundedPence ?? 0);
        const amount = commissionPence(remaining, row.rateBps ?? 0, row.costDeductionBps);
        if (amount <= 0) continue;   // refunded in full meanwhile: stays voided
        const status = row.availableAt && row.availableAt <= at ? 'payable' : 'pending';
        await db.update(partnerCommissions)
            .set({ status, commissionPence: amount, voidedAt: null, voidReason: null, note: `Dispute won — reinstated ${at.toISOString().slice(0, 10)}` })
            .where(and(eq(partnerCommissions.id, row.id), eq(partnerCommissions.status, 'voided')));
        reinstated++;
    }

    const adjustments = await db.select().from(partnerCommissions).where(and(inArray(partnerCommissions.kind, ['adjustment', 'bonus']), match));
    const byPayment = new Map<string, { partnerId: number; partnerReferralId: number | null; stripeChargeId: string | null; currency: string; net: number }>();
    for (const a of adjustments) {
        if (a.note !== `${DISPUTE_REASON} after payout` && a.note !== DISPUTE_WON_NOTE) continue;
        const key = a.stripeInvoiceId ?? '';
        const cur = byPayment.get(key) ?? { partnerId: a.partnerId, partnerReferralId: a.partnerReferralId, stripeChargeId: a.stripeChargeId, currency: a.currency, net: 0 };
        cur.net += a.commissionPence;
        byPayment.set(key, cur);
    }
    for (const [invoiceRef, a] of byPayment) {
        if (a.net >= 0) continue;   // already returned
        await db.insert(partnerCommissions).values({
            partnerId: a.partnerId, partnerReferralId: a.partnerReferralId, kind: 'bonus',
            stripeInvoiceId: invoiceRef || null, stripeChargeId: a.stripeChargeId,
            commissionPence: -a.net, currency: a.currency, status: 'payable', availableAt: at, note: DISPUTE_WON_NOTE,
        });
        reinstated++;
    }
    return { reinstated };
}

/** Nightly: pending commissions whose holding period has ended become payable. */
export async function releaseDueCommissions(db: Db, now: Date = new Date()): Promise<{ released: number }> {
    const released = await db.update(partnerCommissions)
        .set({ status: 'payable' })
        .where(and(eq(partnerCommissions.status, 'pending'), lte(partnerCommissions.availableAt, now)))
        .returning({ id: partnerCommissions.id });
    return { released: released.length };
}
