// netlify/functions/redeem-referral-reward.ts
// Referral Program Expansion — spend referral tokens from the vault.
//
//   POST /redeem-referral-reward  { type: 'credit_10' | 'free_assistant' }
//     credit_10      → US3: deduct 1 token, apply a £10 Stripe customer-balance credit.
//     free_assistant → US2: deduct 5 tokens, +1 to organisations.bonus_assistants.
//
// All DB work runs inside one transaction with the spent rows locked FOR UPDATE, so two
// concurrent redemptions can't double-spend the same tokens (AC2.1/AC2.3/AC3.1).

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '../../db/client';
import { plans, organisations, userReferrals, userOrganisations, rewardRedemptions } from '../../db/schema';
import { REFUND_WINDOW_DAYS, FREE_ASSISTANT_THRESHOLD, CREDIT_GBP } from '../../src/utils/referral-tokens';

const jwtSecret = process.env.JWT_SECRET;
const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const callerId = getAuth(event);
    if (!callerId) return json(401, { error: 'Unauthorized.' });

    const { type } = JSON.parse(event.body || '{}');
    if (type !== 'credit_10' && type !== 'free_assistant') {
        return json(400, { error: 'Invalid redemption type.' });
    }
    const tokensNeeded = type === 'free_assistant' ? FREE_ASSISTANT_THRESHOLD : 1;

    const db = getDb();
    const matureCutoff = new Date(Date.now() - REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    try {
        const result = await db.transaction(async (tx) => {
            // Lock this referrer's qualified referrals so a concurrent redemption can't reuse them.
            const qualified = await tx.select({
                id: userReferrals.id,
                qualifiedAt: userReferrals.qualifiedAt,
                referredUserId: userReferrals.referredUserId,
            }).from(userReferrals)
                .where(and(eq(userReferrals.referrerId, callerId), eq(userReferrals.status, 'qualified')))
                .for('update');

            // Matured = past the 14-day window AND the referred friend's plan is still active.
            const referredIds = qualified.map(r => r.referredUserId);
            const activeSet = new Set<number>();
            if (referredIds.length) {
                const active = await tx.select({ userId: plans.userId }).from(plans)
                    .where(and(inArray(plans.userId, referredIds), eq(plans.status, 'active')));
                active.forEach(p => { if (p.userId != null) activeSet.add(p.userId); });
            }
            const matured = qualified
                .filter(r => activeSet.has(r.referredUserId) && r.qualifiedAt && r.qualifiedAt <= matureCutoff)
                .sort((a, b) => a.qualifiedAt!.getTime() - b.qualifiedAt!.getTime());

            const orgId = (await tx.select({ organisationId: userOrganisations.organisationId })
                .from(userOrganisations).where(eq(userOrganisations.userId, callerId)).limit(1))[0]?.organisationId ?? null;

            // Milestone bonus tokens are spent before referral tokens. Lock the org row.
            let bonusTokens = 0;
            if (orgId) {
                const [orgRow] = await tx.select({ bonus: organisations.bonusReferralTokens })
                    .from(organisations).where(eq(organisations.id, orgId)).for('update').limit(1);
                bonusTokens = orgRow?.bonus ?? 0;
            }

            const available = matured.length + bonusTokens;
            if (available < tokensNeeded) {
                return { ok: false as const, status: 400, error: `Not enough referral tokens. You have ${available}, need ${tokensNeeded}.` };
            }

            const bonusToSpend = Math.min(bonusTokens, tokensNeeded);
            const referralToSpend = tokensNeeded - bonusToSpend;
            const spendIds = matured.slice(0, referralToSpend).map(r => r.id);

            let stripeBalanceTxId: string | null = null;
            let newBonus: number | null = null;

            if (type === 'credit_10') {
                // Apply the Stripe credit FIRST — if it fails we throw and the whole tx rolls back,
                // so the user never loses tokens without getting the reward (AC3.2).
                const [plan] = await tx.select({ stripeCustomerId: plans.stripeCustomerId })
                    .from(plans).where(and(eq(plans.userId, callerId), eq(plans.status, 'active'))).limit(1);
                if (!plan?.stripeCustomerId) return { ok: false as const, status: 409, error: 'No active billing account to credit.' };
                if (!stripe) return { ok: false as const, status: 500, error: 'Billing is not configured.' };

                const tx2 = await stripe.customers.createBalanceTransaction(plan.stripeCustomerId, {
                    amount: -CREDIT_GBP * 100,
                    currency: 'gbp',
                    description: 'Referral reward — redeemed token',
                });
                stripeBalanceTxId = tx2.id;
            } else {
                // free_assistant: bump the org's bonus cap.
                if (!orgId) return { ok: false as const, status: 409, error: 'No organisation to credit.' };
                const [org] = await tx.update(organisations)
                    .set({ bonusAssistants: sql`${organisations.bonusAssistants} + 1` })
                    .where(eq(organisations.id, orgId))
                    .returning({ bonusAssistants: organisations.bonusAssistants });
                newBonus = org?.bonusAssistants ?? null;
            }

            // Consume bonus tokens first (guarded against a concurrent spend).
            if (bonusToSpend > 0 && orgId) {
                const dec = await tx.update(organisations)
                    .set({ bonusReferralTokens: sql`${organisations.bonusReferralTokens} - ${bonusToSpend}` })
                    .where(and(eq(organisations.id, orgId), gte(organisations.bonusReferralTokens, bonusToSpend)))
                    .returning({ bonus: organisations.bonusReferralTokens });
                if (dec.length === 0) throw new Error('Bonus-token race — rolling back.');
            }

            // Consume referral tokens (guarded so a racing tx that already flipped them yields fewer rows).
            if (referralToSpend > 0) {
                const spent = await tx.update(userReferrals)
                    .set({ status: 'spent' })
                    .where(and(inArray(userReferrals.id, spendIds), eq(userReferrals.status, 'qualified')))
                    .returning({ id: userReferrals.id });
                if (spent.length !== referralToSpend) throw new Error('Token race detected — rolling back.');
            }

            // Audit ledger row (AC2.3).
            await tx.insert(rewardRedemptions).values({
                userId: callerId,
                organisationId: orgId,
                type,
                tokensSpent: tokensNeeded,
                stripeBalanceTxId,
            });

            return { ok: true as const, type, tokensSpent: tokensNeeded, remainingTokens: available - tokensNeeded, newBonus };
        });

        if (!result.ok) return json(result.status, { error: result.error });
        return json(200, result);
    } catch (e) {
        console.error('[redeem-referral-reward] error:', e);
        return json(500, { error: 'Redemption failed. No tokens were spent.' });
    }
};
