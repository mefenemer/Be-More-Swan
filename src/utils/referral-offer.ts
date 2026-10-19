// src/utils/referral-offer.ts
// The referred friend's offer — "your first month free" — and the rule for when a referral counts.
//
// WHY THIS EXISTS (found 2026-10-17): the banner promised "20% off your first 3 months", but the
// plan picker applied a discount only if a Stripe COUPON existed whose id was the referrer's
// personal code (stripe.coupons.retrieve(referralCode)). No such coupons exist, so every referred
// friend paid full price. Worse, verify.ts drops ?ref when it sends a new user to the plan gate,
// so the code usually never reached checkout at all.
//
// So the offer is now decided on the SERVER from the user_referrals row register.ts writes at
// signup — never from a code the browser sends — and applied with one of two fixed coupons:
//   monthly → 100% off once           (the first monthly invoice is £0)
//   annual  → one month's worth once  (1/12 off the first yearly invoice)
// Both are found-or-created by a fixed id, so repeated checkouts reuse them.
//
// The friend's first invoice is now £0, so it can no longer be what qualifies the referral (the
// referrer would earn a token for a friend who never pays). qualifyPendingReferral() is only
// called once real money has been taken — see stripe-webhook.ts.

import type Stripe from 'stripe';
import { isPartnerReferrer } from './partner-ledger';
import { and, eq, notInArray } from 'drizzle-orm';
import { plans, userReferrals } from '../../db/schema';
import { createNotification } from './notify';
import { FREE_PLAN_TYPES } from '../config/beta-plan';

export const REFERRAL_OFFER_DISPLAY = 'your first month free';

export const REFERRAL_COUPON_IDS = {
    monthly: 'bms-referral-first-month-free',
    annual:  'bms-referral-first-month-free-annual',
} as const;

/** One month of a yearly invoice, as a Stripe percent_off (two decimal places). */
export const ANNUAL_ONE_MONTH_PERCENT_OFF = Math.round((100 / 12) * 100) / 100; // 8.33

type Db = any;

/**
 * The referral the user signed up with, if the offer still applies: the referral is pending and
 * the user has never held a PAID plan. A friend who subscribed, cancelled and came back does not
 * get a second free month.
 *
 * Free plans (the 14-day trial, beta) don't count: every new workspace gets a trial plan row the
 * moment its owner verifies (trial.ts), so counting it would mean no referred friend ever got the
 * offer. The free month applies to their first paid subscription, after the trial.
 */
export async function findReferralOffer(db: Db, userId: number): Promise<{ referralId: number; referralCode: string } | null> {
    const [referral] = await db
        .select({ id: userReferrals.id, referralCode: userReferrals.referralCode })
        .from(userReferrals)
        .where(and(eq(userReferrals.referredUserId, userId), eq(userReferrals.status, 'pending')))
        .limit(1);
    if (!referral) return null;

    const [paidPlan] = await db.select({ id: plans.id }).from(plans)
        .where(and(eq(plans.userId, userId), notInArray(plans.planType, [...FREE_PLAN_TYPES])))
        .limit(1);
    if (paidPlan) return null;

    return { referralId: referral.id, referralCode: referral.referralCode };
}

/** Find-or-create the fixed coupon for a billing cycle. Returns the coupon id. */
export async function resolveReferralCouponId(stripe: Stripe, billingCycle: 'monthly' | 'annual'): Promise<string> {
    const id = REFERRAL_COUPON_IDS[billingCycle];
    try {
        const existing = await stripe.coupons.retrieve(id);
        if (existing.valid) return existing.id;
    } catch (err: any) {
        if (err?.code !== 'resource_missing' && err?.statusCode !== 404) throw err;
    }
    const coupon = await stripe.coupons.create({
        id,
        name: 'Referral: first month free',
        percent_off: billingCycle === 'monthly' ? 100 : ANNUAL_ONE_MONTH_PERCENT_OFF,
        duration: 'once',
        metadata: { source: 'referral' },
    });
    return coupon.id;
}

/**
 * Mark the user's pending referral qualified and tell the referrer. Call only once the referred
 * user has actually paid something (amount > 0). Returns true if a referral was qualified.
 */
export async function qualifyPendingReferral(db: Db, userId: number): Promise<boolean> {
    const [pendingReferral] = await db
        .select({ id: userReferrals.id, referrerId: userReferrals.referrerId })
        .from(userReferrals)
        .where(and(eq(userReferrals.referredUserId, userId), eq(userReferrals.status, 'pending')))
        .limit(1);
    if (!pendingReferral) return false;

    // A partner's referral earns cash through partner-ledger.ts, never a token as well. 'partner'
    // keeps it out of the token vault (which counts 'qualified' rows only).
    if (await isPartnerReferrer(db, pendingReferral.referrerId)) {
        await db.update(userReferrals)
            .set({ status: 'partner', qualifiedAt: new Date() })
            .where(eq(userReferrals.id, pendingReferral.id));
        return false;
    }

    await db.update(userReferrals)
        .set({ status: 'qualified', qualifiedAt: new Date() })
        .where(eq(userReferrals.id, pendingReferral.id));

    await createNotification(db, 'referral_reward', {
        userId: pendingReferral.referrerId,
        metadata: { referralId: pendingReferral.id },
    });
    return true;
}
