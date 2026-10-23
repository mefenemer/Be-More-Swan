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
import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    partnerCommissions, partnerProgrammeSettings, partnerRatePeriods, partnerReferrals, partners, userReferrals,
} from '../../db/schema';
import {
    commissionPence, isWithinCommissionWindow, lockTerms, resolvePeriodAt, type RatePeriod,
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
    /** What the customer actually paid, excluding VAT, in pence. */
    netAmountPence: number;
    currency: string;
    paidAt: Date;
}

export type RecordOutcome =
    | { recorded: true; commissionPence: number; partnerId: number }
    | { recorded: false; reason: 'not_a_partner_referral' | 'no_amount' | 'currency' | 'no_rate' | 'outside_window' | 'duplicate' };

/** What a Stripe invoice actually collected, excluding VAT. Customer-balance credit is not money. */
export function invoiceNetPence(invoice: { amount_paid?: number | null; total?: number | null; total_excluding_tax?: number | null }): number {
    const paid = invoice.amount_paid ?? 0;
    const total = invoice.total ?? paid;
    const tax = Math.max(0, total - (invoice.total_excluding_tax ?? total));
    return Math.max(0, paid - tax);
}

/** What a Checkout Session collected, excluding VAT. */
export function sessionNetPence(session: { amount_total?: number | null; total_details?: { amount_tax?: number | null } | null }): number {
    return Math.max(0, (session.amount_total ?? 0) - (session.total_details?.amount_tax ?? 0));
}

/** The approved partner behind this customer's referral, if any. */
async function findPartnerReferral(db: Db, referredUserId: number) {
    const [row] = await db
        .select({ referralId: userReferrals.id, partnerId: partners.id, referralCode: userReferrals.referralCode, promoCode: partners.promoCode })
        .from(userReferrals)
        .innerJoin(partners, eq(partners.userId, userReferrals.referrerId))
        .where(and(eq(userReferrals.referredUserId, referredUserId), eq(partners.status, 'approved')))
        .limit(1);
    return row ?? null;
}

/**
 * True when this referrer is on the partner track — approved, or suspended (a suspended partner
 * earns nothing, and must not fall back to earning tokens either). Their referrals never earn a
 * token; referral-offer.ts marks them 'partner' instead of 'qualified'.
 */
export async function isPartnerReferrer(db: Db, referrerId: number): Promise<boolean> {
    const [row] = await db.select({ id: partners.id }).from(partners)
        .where(and(eq(partners.userId, referrerId), inArray(partners.status, ['approved', 'suspended'])))
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
    if (payment.currency.toUpperCase() !== PROGRAMME_CURRENCY) {
        console.error('[partner-ledger] payment in an unsupported currency — no commission recorded', payment);
        return { recorded: false, reason: 'currency' };
    }

    // Came in on the partner's memorable partner code rather than their link (invite-codes.ts)?
    const viaPartnerCode = !!ref.promoCode && ref.referralCode?.toUpperCase() === ref.promoCode.toUpperCase();
    const terms = await lockedTermsFor(db, ref.referralId, ref.partnerId, payment.paidAt, viaPartnerCode ? 'promo_code' : 'link');
    if (!terms || terms.rateBps === null || !terms.subscribedAt) {
        console.error('[partner-ledger] no rate period covers this payment — the programme has a gap', payment);
        return { recorded: false, reason: 'no_rate' };
    }
    if (!isWithinCommissionWindow(terms.subscribedAt, terms.durationMonths, payment.paidAt)) {
        return { recorded: false, reason: 'outside_window' };
    }

    // Locked before the cost deduction existed → null → 0%: what that customer was promised stands.
    const costDeductionBps = terms.costDeductionBps ?? 0;
    const amount = commissionPence(payment.netAmountPence, terms.rateBps, costDeductionBps);
    const availableAt = new Date(payment.paidAt.getTime() + (await holdingDays(db)) * DAY_MS);
    const inserted = await db.insert(partnerCommissions).values({
        partnerId: ref.partnerId,
        partnerReferralId: terms.id,
        kind: 'invoice',
        stripeInvoiceId: payment.paymentRef,
        stripeChargeId: payment.paymentIntentId,
        netAmountPence: payment.netAmountPence,
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

export interface ReversalInput {
    /** pi_… from the refund's or dispute's charge. */
    paymentIntentId: string | null;
    /** The invoice the payment belonged to, when known — a fallback match for rows stored without a PaymentIntent. */
    invoiceId?: string | null;
    /** Total refunded so far on this payment, in pence (Stripe's charge.amount_refunded). Ignored for a dispute. */
    amountRefundedPence: number;
    kind: 'refund' | 'dispute';
    at?: Date;
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

    for (const row of rows) {
        const net = row.netAmountPence ?? 0;
        const remaining = input.kind === 'dispute' ? 0 : Math.max(0, net - input.amountRefundedPence);
        const target = commissionPence(remaining, row.rateBps ?? 0, row.costDeductionBps);
        const reason = input.kind === 'dispute' ? DISPUTE_REASON : (remaining === 0 ? 'Payment refunded' : 'Payment partly refunded');

        if (row.status === 'voided') continue;
        if (row.status === 'pending' || row.status === 'payable') {
            if (target === 0) {
                await db.update(partnerCommissions)
                    .set({ status: 'voided', voidedAt: at, voidReason: reason })
                    .where(eq(partnerCommissions.id, row.id));
                adjusted++;
            } else if (target < row.commissionPence) {
                await db.update(partnerCommissions)
                    .set({ commissionPence: target, note: `${reason}: was ${row.commissionPence}p` })
                    .where(eq(partnerCommissions.id, row.id));
                adjusted++;
            }
            continue;
        }

        // Paid already: claw back the difference, net of any adjustment already made for this payment.
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
    return { adjusted };
}

/**
 * A dispute we WON (charge.dispute.closed, status 'won'): undo what reversePartnerCommission did
 * when it opened. Idempotent:
 *   - rows voided as 'Payment disputed' go back to pending (or payable, if their hold has ended) —
 *     unless a payout run or a refund has touched them since;
 *   - money clawed back after payout ('Payment disputed after payout') is returned by a positive
 *     adjustment, net of any already returned.
 */
export async function reinstateDisputedCommission(db: Db, input: {
    paymentIntentId: string | null; invoiceId?: string | null;
    /** Refunded on the charge so far (charge.amount_refunded) — that part stays unearned. */
    amountRefundedPence?: number; at?: Date;
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
        const remaining = Math.max(0, (row.netAmountPence ?? 0) - (input.amountRefundedPence ?? 0));
        const amount = commissionPence(remaining, row.rateBps ?? 0, row.costDeductionBps);
        if (amount <= 0) continue;   // refunded in full meanwhile: stays voided
        const status = row.availableAt && row.availableAt <= at ? 'payable' : 'pending';
        await db.update(partnerCommissions)
            .set({ status, commissionPence: amount, voidedAt: null, voidReason: null, note: `Dispute won — reinstated ${at.toISOString().slice(0, 10)}` })
            .where(and(eq(partnerCommissions.id, row.id), eq(partnerCommissions.status, 'voided')));
        reinstated++;
    }

    const adjustments = await db.select().from(partnerCommissions).where(and(eq(partnerCommissions.kind, 'adjustment'), match));
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
            partnerId: a.partnerId, partnerReferralId: a.partnerReferralId, kind: 'adjustment',
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
