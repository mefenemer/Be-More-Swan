/**
 * netlify/functions/referral.ts
 *
 * US-GAP-8.2: Workspace Referral Programme
 *
 * GET  /referral  → return caller's referral code + activity list
 * POST /referral  → generate / regenerate referral code (idempotent)
 */

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc, and, count } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { users, userReferrals, plans, organisations, masterPlans, aiAssistants, userOrganisations, referralInvites } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { getReferralTokenState, FREE_ASSISTANT_THRESHOLD, CREDIT_GBP } from '../../src/utils/referral-tokens';

const jwtSecret = process.env.JWT_SECRET;
const REWARD_GBP = 10;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

/** Generate an 8-character alphanumeric code */
function generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

export const handler: Handler = async (event) => {
    const callerId = getAuth(event);
    if (!callerId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const BASE_URL = resolveBaseUrl(event.headers);
    if (!BASE_URL) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const db = getDb();

    // ── GET: fetch code + activity ─────────────────────────────────
    if (event.httpMethod === 'GET') {
        const [user] = await db.select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            referralCode: users.referralCode,
            createdAt: users.createdAt,
        }).from(users).where(eq(users.id, callerId)).limit(1);

        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

        // Check if caller has an active plan
        const [activePlan] = await db
            .select({ id: plans.id })
            .from(plans)
            .where(and(eq(plans.userId, callerId), eq(plans.status, 'active')))
            .limit(1);
        const hasActivePlan = !!activePlan;

        if (!hasActivePlan) {
            return {
                statusCode: 200,
                body: JSON.stringify({ hasActivePlan: false }),
            };
        }

        // Fetch referrals made by this user
        const referrals = await db
            .select({
                id: userReferrals.id,
                status: userReferrals.status,
                createdAt: userReferrals.createdAt,
                qualifiedAt: userReferrals.qualifiedAt,
                rewardedAt: userReferrals.rewardedAt,
                referredFirstName: users.firstName,
                referredLastName: users.lastName,
                referredEmail: users.email,
            })
            .from(userReferrals)
            .leftJoin(users, eq(userReferrals.referredUserId, users.id))
            .where(eq(userReferrals.referrerId, callerId))
            .orderBy(desc(userReferrals.createdAt));

        // Sent-but-not-yet-accepted invites — these show as "Invited — awaiting sign-up"
        // in the activity list, the stage before a friend registers (user_referrals).
        const invites = await db
            .select({ email: referralInvites.email, sentAt: referralInvites.sentAt })
            .from(referralInvites)
            .where(and(eq(referralInvites.referrerId, callerId), eq(referralInvites.status, 'invited')))
            .orderBy(desc(referralInvites.sentAt));

        const totalRewarded = referrals.filter(r => r.status === 'rewarded').length;
        const shareLink = user.referralCode
            ? `${BASE_URL}/register.html?ref=${user.referralCode}`
            : null;

        // US-GAP-8.3.1: Who referred this user?
        const [referralRecord] = await db
            .select({ referrerId: userReferrals.referrerId, status: userReferrals.status })
            .from(userReferrals)
            .where(eq(userReferrals.referredUserId, callerId))
            .limit(1);

        let referredBy: { displayName: string; joinedAt: string; referralBonusApplied: boolean } | null = null;
        if (referralRecord) {
            const [referrer] = await db
                .select({ firstName: users.firstName, lastName: users.lastName, pendingDeletion: users.pendingDeletion })
                .from(users)
                .where(eq(users.id, referralRecord.referrerId))
                .limit(1);
            // AC3/AC15: hide referrer if their account has been soft-deleted
            if (referrer && !referrer.pendingDeletion) {
                const name = [referrer.firstName, referrer.lastName].filter(Boolean).join(' ') || 'An Be More Swan member';
                referredBy = {
                    displayName: name,
                    joinedAt: (user.createdAt as Date).toISOString(), // AC10: current user's join date
                    referralBonusApplied: referralRecord.status === 'qualified' || referralRecord.status === 'rewarded',
                };
            }
        }

        // ── Reward vault: token balance + assistant capacity (for the milestone UI) ──
        const tokenState = await getReferralTokenState(db, callerId);

        const [orgRow] = await db
            .select({ organisationId: userOrganisations.organisationId })
            .from(userOrganisations)
            .where(eq(userOrganisations.userId, callerId))
            .limit(1);
        const orgId = orgRow?.organisationId ?? null;

        let bonusAssistants = 0;
        let tierLimit: number | null = null;
        let assistantCount = 0;
        if (orgId) {
            const [org] = await db.select({ bonusAssistants: organisations.bonusAssistants })
                .from(organisations).where(eq(organisations.id, orgId)).limit(1);
            bonusAssistants = org?.bonusAssistants ?? 0;

            const [tierRow] = await db
                .select({ assistantLimit: masterPlans.assistantLimit })
                .from(plans)
                .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
                .where(and(eq(plans.organisationId, orgId), eq(plans.status, 'active')))
                .limit(1);
            tierLimit = tierRow?.assistantLimit ?? null;

            const [{ value: cnt }] = await db
                .select({ value: count() })
                .from(aiAssistants)
                .where(eq(aiAssistants.organisationId, orgId));
            assistantCount = Number(cnt);
        }
        // bonus stacks on the tier limit; null tier = unlimited (bonus moot)
        const assistantLimit = tierLimit === null ? null : tierLimit + bonusAssistants;

        return {
            statusCode: 200,
            body: JSON.stringify({
                hasActivePlan: true,
                referralCode: user.referralCode,
                shareLink,
                rewardGbp: REWARD_GBP,
                totalRewarded,
                totalPending: referrals.filter(r => r.status === 'pending').length,
                totalQualified: referrals.filter(r => r.status === 'qualified').length,
                // Reward vault (Referral Program Expansion)
                availableTokens: tokenState.availableTokens,
                maturingTokens: tokenState.maturingTokens,
                freeAssistantThreshold: FREE_ASSISTANT_THRESHOLD,
                creditGbp: CREDIT_GBP,
                bonusAssistants,
                assistantLimit,
                assistantCount,
                referredBy,
                totalInvited: invites.length,
                invites: invites.map(i => ({ email: i.email, sentAt: i.sentAt })),
                referrals: referrals.map(r => ({
                    id: r.id,
                    status: r.status,
                    createdAt: r.createdAt,
                    qualifiedAt: r.qualifiedAt,
                    rewardedAt: r.rewardedAt,
                    name: [r.referredFirstName, r.referredLastName].filter(Boolean).join(' ') || 'Invited user',
                    email: r.referredEmail,
                })),
            }),
        };
    }

    // ── POST: generate / return existing code ──────────────────────
    if (event.httpMethod === 'POST') {
        const [user] = await db.select({ referralCode: users.referralCode })
            .from(users).where(eq(users.id, callerId)).limit(1);

        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

        let code = user.referralCode;
        if (!code) {
            // Generate a unique code (retry on collision, max 5 attempts)
            for (let attempt = 0; attempt < 5; attempt++) {
                const candidate = generateCode();
                const [existing] = await db.select({ id: users.id })
                    .from(users).where(eq(users.referralCode, candidate)).limit(1);
                if (!existing) {
                    await db.update(users).set(withUpdatedAt({ referralCode: candidate })).where(eq(users.id, callerId));
                    code = candidate;
                    break;
                }
            }
            if (!code) return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate a unique code. Please try again.' }) };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                referralCode: code,
                shareLink: `${BASE_URL}/register.html?ref=${code}`,
                rewardGbp: REWARD_GBP,
            }),
        };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
