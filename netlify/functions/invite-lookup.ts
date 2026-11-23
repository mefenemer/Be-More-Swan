// netlify/functions/invite-lookup.ts
// The public /invite/<code> page (invite.html) and the "Invited by" field on register.html —
// docs/affiliate-partner-programme-plan.md §4.2.
//
//   GET ?code=<referral code>[&visit=1]
//   → { valid: false }  |  { valid: true, code, firstName, offer, profile? }
//
// Works for EVERY referral code — a customer's refer-a-friend link and a partner's — because both
// are users.referral_code and register.ts records both the same way. Reveals only the code owner's
// FIRST name (they chose to share the link). Doesn't say whether the owner is a partner — EXCEPT when an
// approved partner has an approved invite page (docs/partner-onboarding-plan.md §3.3): then `profile`
// carries their headline, words and photo, and invite.html labels it as a paid partnership (CAP Code /
// FTC — a partner's own words recommending us, on our page, must say they earn from it).
//
// visit=1 (sent once by invite.html on load) counts a click for an APPROVED partner, per day
// (partner_link_stats) — no IP, nothing on the visitor's device. Limited per IP so a refresh loop
// can't inflate a partner's numbers.

import { createHmac } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { partnerLinkStats, partners } from '../../db/schema';
import { resolveInviteCode } from '../../src/utils/invite-codes';
import { checkRateLimit, getClientIp } from '../../src/utils/rate-limit';
import { REFERRAL_OFFER_DISPLAY } from '../../src/utils/referral-offer';
import { photoUrl, type InviteProfile } from '../../src/utils/partner-invite-profile';

/** A keyed hash of the visitor's IP: stable enough to rate-limit repeat clicks, never the address itself. */
export function visitorKey(ip: string): string {
    return createHmac('sha256', process.env.JWT_SECRET || 'invite-click').update(ip).digest('hex').slice(0, 32);
}

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

export const CLICK_LIMIT = { maxAttempts: 30, windowSecs: 3600 };

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });
    const code = (event.queryStringParameters?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return json(200, { valid: false });

    const db = getDb();
    // A referral code, or an approved partner's partner code (src/utils/invite-codes.ts).
    const invite = await resolveInviteCode(db, code);
    if (!invite) return json(200, { valid: false });
    const owner = { id: invite.referrerUserId, firstName: invite.firstName };

    if (event.queryStringParameters?.visit === '1') {
        try {
            const [partner] = invite.partnerId ? [{ id: invite.partnerId }] : await db.select({ id: partners.id }).from(partners)
                .where(and(eq(partners.userId, owner.id), eq(partners.status, 'approved'))).limit(1);
            if (partner) {
                const ip = getClientIp(event.headers as Record<string, string | undefined>);
                // privacy.html: no IP address is kept with click counts — only a keyed hash, so the rate-limit row
                // can't be read back as an address (cross-border legal review 2026-11-23).
                const { allowed } = await checkRateLimit(db, 'invite_click', `${visitorKey(ip)}:${partner.id}`, CLICK_LIMIT);
                if (allowed) {
                    await db.insert(partnerLinkStats).values({ partnerId: partner.id, day: sql`(now() AT TIME ZONE 'Europe/London')::date`, clicks: 1 })
                        .onConflictDoUpdate({ target: [partnerLinkStats.partnerId, partnerLinkStats.day], set: { clicks: sql`${partnerLinkStats.clicks} + 1` } });
                }
            }
        } catch (err) {
            console.error('[invite-lookup] click count failed (non-blocking):', err);
        }
    }

    // Their own invite page: only the APPROVED version, only while they're an approved partner.
    let profile: { headline: string; quote: string; photoUrl: string | null } | null = null;
    try {
        const [pp] = await db.select({ id: partners.id, live: partners.inviteProfile }).from(partners)
            .where(and(invite.partnerId ? eq(partners.id, invite.partnerId) : eq(partners.userId, owner.id), eq(partners.status, 'approved'))).limit(1);
        const live = pp?.live as InviteProfile | null | undefined;
        if (pp && live) profile = { headline: live.headline, quote: live.quote, photoUrl: photoUrl(pp.id, live.photoKey) };
    } catch (err) {
        console.error('[invite-lookup] profile read failed (non-blocking):', err);
    }

    return json(200, { valid: true, code: invite.code, firstName: owner.firstName || null, offer: REFERRAL_OFFER_DISPLAY, ...(profile ? { profile } : {}) });
});
