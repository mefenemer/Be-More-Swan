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

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { plans, userReferrals, organisations, userOrganisations } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

export const REFUND_WINDOW_DAYS = 14;
export const FREE_ASSISTANT_THRESHOLD = 5;
export const CREDIT_GBP = 10;

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
