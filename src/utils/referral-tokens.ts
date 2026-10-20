// src/utils/referral-tokens.ts
// Referral Program Expansion — token vault math.
//
// A referral token is "earned" when a referred friend makes their first paid invoice
// (user_referrals.status: pending → qualified, qualifiedAt set). It only becomes
// SPENDABLE once it has matured: qualifiedAt + 14 days has elapsed AND the referred
// friend's plan is still active (a refund/cancel inside the window leaves the plan
// inactive, so the token never matures — AC4.1, fraud protection).
//
// availableTokens = matured-&-still-active qualified referrals. Spending flips those
// rows to 'spent', so they drop out of this set (the reward_redemptions ledger is the
// audit trail). Legacy 'rewarded' rows (already auto-credited £10) are excluded.
//
// What a token is worth — "give a month, get a month" (owner, 2026-10-20): ONE token = one free
// month of the referrer's own plan, as account credit off their next bill. It replaced "1 token =
// £10, or 5 = a free assistant": every assistant is on the £69 plan now, and an extra slot on the
// £29 plan gave away what the upgrade sells. Slots already granted (bonus_assistants) are kept.

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, masterPlans, userReferrals, organisations, userOrganisations } from '../../db/schema';
import { FREE_PLAN_TYPES } from '../config/beta-plan';

type Db = ReturnType<typeof getDb>;

export const REFUND_WINDOW_DAYS = 14;
/** Redemption type for one token → one free month. Older types ('credit_10', 'free_assistant') stay in the ledger only. */
export const FREE_MONTH = 'free_month';

/**
 * A free month for this user: their paid plan's monthly list price (master data), and the Stripe
 * customer to credit. null on a trial/beta plan or with no billing account — nothing to take a
 * month off yet; the tokens wait. Annual subscribers get the same monthly figure, held as credit
 * against their renewal.
 */
export async function freeMonthFor(db: Pick<Db, 'select'>, userId: number): Promise<{ amountGbp: number; stripeCustomerId: string } | null> {
    const [row] = await db
        .select({ price: masterPlans.monthlyPriceGbp, stripeCustomerId: plans.stripeCustomerId })
        .from(plans)
        .innerJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.userId, userId), eq(plans.status, 'active'), notInArray(plans.planType, [...FREE_PLAN_TYPES])))
        .limit(1);
    const amountGbp = Number(row?.price);
    if (!row?.stripeCustomerId || !(amountGbp > 0)) return null;
    return { amountGbp, stripeCustomerId: row.stripeCustomerId };
}

export interface ReferralTokenState {
    /** Spendable balance = matured referral tokens + milestone bonus tokens. */
    availableTokens: number;
    /** Qualified but still inside the 14-day window (not yet spendable). */
    maturingTokens: number;
    /** Ids of the matured referrals, oldest-first (FIFO spend order). */
    maturedReferralIds: number[];
    /** Milestone-granted bonus tokens (organisations.bonus_referral_tokens) — spent before referral rows. */
    bonusTokens: number;
}

/** Look up the milestone bonus-token balance for the caller's org. */
async function getBonusTokens(db: Db, referrerId: number): Promise<number> {
    const [row] = await db
        .select({ bonus: organisations.bonusReferralTokens })
        .from(userOrganisations)
        .leftJoin(organisations, eq(userOrganisations.organisationId, organisations.id))
        .where(eq(userOrganisations.userId, referrerId))
        .limit(1);
    return row?.bonus ?? 0;
}

export async function getReferralTokenState(db: Db, referrerId: number): Promise<ReferralTokenState> {
    const matureCutoff = new Date(Date.now() - REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const bonusTokens = await getBonusTokens(db, referrerId);

    const qualified = await db.select({
        id: userReferrals.id,
        qualifiedAt: userReferrals.qualifiedAt,
        referredUserId: userReferrals.referredUserId,
    }).from(userReferrals)
        .where(and(eq(userReferrals.referrerId, referrerId), eq(userReferrals.status, 'qualified')));

    if (qualified.length === 0) {
        return { availableTokens: bonusTokens, maturingTokens: 0, maturedReferralIds: [], bonusTokens };
    }

    // Which referred friends still hold an active plan?
    const referredIds = qualified.map(r => r.referredUserId);
    const activePlans = await db.select({ userId: plans.userId }).from(plans)
        .where(and(inArray(plans.userId, referredIds), eq(plans.status, 'active')));
    const activeSet = new Set(activePlans.map(p => p.userId));

    const matured = qualified
        .filter(r => activeSet.has(r.referredUserId) && r.qualifiedAt && r.qualifiedAt <= matureCutoff)
        .sort((a, b) => (a.qualifiedAt!.getTime()) - (b.qualifiedAt!.getTime()));

    const maturing = qualified.filter(r =>
        activeSet.has(r.referredUserId) && (!r.qualifiedAt || r.qualifiedAt > matureCutoff));

    return {
        availableTokens: matured.length + bonusTokens,
        maturingTokens: maturing.length,
        maturedReferralIds: matured.map(r => r.id),
        bonusTokens,
    };
}
