// netlify/functions/referral-claim.ts
// "Have an invite code?" on the plan picker (workspace.html) — for someone who signed up without one
// (docs/affiliate-partner-programme-plan.md §4.2, step 7).
//
//   GET          → { applied: { firstName } | null, eligible }   — is an invite on this account, and could one be added?
//   POST { code } → { ok: true, firstName } | 400 { error }
//
// The code can be a referral code or an approved partner's partner code (src/utils/invite-codes.ts).
// Writing the user_referrals row is all this does: checkout then applies the friend offer from that
// row (referral-offer.ts findReferralOffer — the right coupon for monthly or annual), never from
// what the browser sends. New customers only; never your own code; once per account.

import jwt from 'jsonwebtoken';
import { and, eq, notInArray } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { plans, userReferrals, users } from '../../db/schema';
import { FREE_PLAN_TYPES } from '../../src/config/beta-plan';
import { claimLateReferral } from '../../src/utils/invite-codes';
import { checkImpersonationBlock, resolveImpersonation } from '../../src/utils/impersonation';
import { checkRateLimit } from '../../src/utils/rate-limit';
import { findReferralOffer } from '../../src/utils/referral-offer';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export const CLAIM_LIMIT = { maxAttempts: 10, windowSecs: 3600 };

export default withLambda(async (event) => {
    const secret = process.env.JWT_SECRET;
    const m = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!secret || !m) return json(401, { error: 'Not authenticated.' });
    let userId: number;
    try {
        userId = (jwt.verify(m[1], secret) as { userId: number }).userId;
    } catch { return json(401, { error: 'Invalid session.' }); }
    const db = getDb();

    if (event.httpMethod === 'GET') {
        // Impersonating: answer for the customer being viewed, not the admin's own account.
        const imp = await resolveImpersonation(db, event.headers.cookie, userId);
        if (imp) userId = imp.impersonatingUserId;
        const offer = await findReferralOffer(db, userId);
        let applied: { firstName: string | null } | null = null;
        if (offer) {
            const [r] = await db.select({ firstName: users.firstName }).from(userReferrals)
                .innerJoin(users, eq(users.id, userReferrals.referrerId)).where(eq(userReferrals.id, offer.referralId)).limit(1);
            applied = { firstName: r?.firstName ?? null };
        }
        const [any] = await db.select({ id: userReferrals.id }).from(userReferrals).where(eq(userReferrals.referredUserId, userId)).limit(1);
        const [paid] = await db.select({ id: plans.id }).from(plans)
            .where(and(eq(plans.userId, userId), notInArray(plans.planType, [...FREE_PLAN_TYPES]))).limit(1);
        return json(200, { applied, eligible: !any && !paid });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    // aura_session is always the admin's own while impersonating, so without this a code typed in
    // the impersonated view would be claimed onto the ADMIN's account.
    const blocked = checkImpersonationBlock(event, 'referral_claim');
    if (blocked) return { ...blocked, headers: { 'Content-Type': 'application/json' } };
    const { allowed } = await checkRateLimit(db, 'referral_claim', `user:${userId}`, CLAIM_LIMIT);
    if (!allowed) return json(429, { error: 'Too many tries — please wait a while and try again.' });
    let body: { code?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request.' }); }
    const r = await claimLateReferral(db, userId, body.code);
    return r.ok ? json(200, r) : json(400, { error: r.error });
});
