// netlify/functions/waitlist-status.ts
// US-AUD-5.1.1 SC4/SC7: Get queue position and referral stats for a waitlist entry.
//
//  GET ?masterAssistantId=N&email=x@y.z
//   → { queuePosition, referralCount, referralCode, referralUrl, day1AccessGranted,
//       nextMilestone: { count, reward } }
//
//  GET ?masterAssistantId=N&adminStats=true  (admin only — SC7)
//   → { totalOnWaitlist, topReferrers: [{ email, referralCount }] }

import { HandlerEvent } from '@netlify/functions';
import { eq, and, count, desc } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { waitlist, waitlistReferrals, users, userOrganisations } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

const MILESTONES = [
    { count: 1, reward: 'Move 50 places up the queue' },
    { count: 3, reward: 'Guaranteed Day 1 launch access' },
    { count: 5, reward: 'First month free (coupon emailed automatically)' },
];

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const qs = event.queryStringParameters || {};
    const masterAssistantId = qs.masterAssistantId ? parseInt(qs.masterAssistantId) : null;
    const email = qs.email?.trim().toLowerCase() || null;
    const isAdminStats = qs.adminStats === 'true';

    if (!masterAssistantId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'masterAssistantId required.' }) };
    }

    const db = getDb();

    // ── SC7: Admin stats ──────────────────────────────────────────────────────
    if (isAdminStats) {
        if (!jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
        const cookieHeader = event.headers.cookie || '';
        const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
        if (!cookieMatch) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };
        try {
            const decoded = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number };
            // Must be an admin — check via users table role or admin flag
            const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, decoded.userId)).limit(1);
            if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };
            // Simple admin check: look for any admin role in any org
            const [adminRole] = await db
                .select({ role: userOrganisations.role })
                .from(userOrganisations)
                .where(and(eq(userOrganisations.userId, decoded.userId)))
                .limit(1);
            if (!adminRole || !['owner', 'admin'].includes(adminRole.role)) {
                return { statusCode: 403, body: JSON.stringify({ error: 'Admin access required.' }) };
            }
        } catch {
            return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
        }

        try {
            const [{ total: totalOnWaitlist }] = await db
                .select({ total: count() })
                .from(waitlist)
                .where(eq(waitlist.masterAssistantId, masterAssistantId));

            // Top referrers by converted referral count
            const referralCounts = await db
                .select({
                    referralCode: waitlistReferrals.referralCode,
                    referralCount: count(),
                    referrerId: waitlistReferrals.referrerId,
                })
                .from(waitlistReferrals)
                .where(eq(waitlistReferrals.masterAssistantId, masterAssistantId))
                .groupBy(waitlistReferrals.referralCode, waitlistReferrals.referrerId)
                .orderBy(desc(count()))
                .limit(20);

            const topReferrers = await Promise.all(
                referralCounts.map(async r => {
                    const [u] = await db
                        .select({ email: users.email, firstName: users.firstName })
                        .from(users)
                        .where(eq(users.id, r.referrerId))
                        .limit(1);
                    return { email: u?.email || '—', name: u?.firstName || '—', referralCount: Number(r.referralCount) };
                })
            );

            return {
                statusCode: 200,
                body: JSON.stringify({ totalOnWaitlist: Number(totalOnWaitlist), topReferrers }),
            };
        } catch (err) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch admin stats.' }) };
        }
    }

    // ── SC4: User queue position + referral tracker ────────────────────────────
    if (!email) {
        return { statusCode: 400, body: JSON.stringify({ error: 'email required.' }) };
    }

    try {
        const [entry] = await db
            .select()
            .from(waitlist)
            .where(and(eq(waitlist.email, email), eq(waitlist.masterAssistantId, masterAssistantId)))
            .limit(1);

        if (!entry) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Not on waitlist.' }) };
        }

        // Raw position = number of entries created before this one + 1
        const [{ rawPos }] = await db
            .select({ rawPos: count() })
            .from(waitlist)
            .where(and(
                eq(waitlist.masterAssistantId, masterAssistantId),
                lt(waitlist.id, entry.id)
            ));

        const bonus = entry.queuePositionBonus ?? 0;
        const queuePosition = Math.max(1, Number(rawPos) + 1 - bonus);

        // Count confirmed referrals
        let referralCount = 0;
        if (entry.referralCode) {
            const [{ total }] = await db
                .select({ total: count() })
                .from(waitlistReferrals)
                .where(eq(waitlistReferrals.referralCode, entry.referralCode));
            referralCount = Number(total);
        }

        // Determine next milestone
        const nextMilestone = MILESTONES.find(m => m.count > referralCount) || null;

        return {
            statusCode: 200,
            body: JSON.stringify({
                queuePosition,
                referralCount,
                referralCode: entry.referralCode || null,
                referralUrl: entry.referralCode ? `${BASE_URL}/waitlist?ref=${entry.referralCode}` : null,
                day1AccessGranted: entry.day1AccessGranted,
                nextMilestone,
                milestones: MILESTONES,
            }),
        };
    } catch (err) {
        console.error('waitlist-status error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch waitlist status.' }) };
    }
};
