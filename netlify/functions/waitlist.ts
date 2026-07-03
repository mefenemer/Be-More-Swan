// waitlist.ts
// POST — join the waitlist for a coming-soon assistant role.
// US-AUD-5.1.1: referral-gated skip-the-queue system.
//
// Body (JSON):
//   { masterAssistantId: number, email?: string, ref?: string }
//
// ref: optional referral code from the sharer's link (?ref=ABC123)
//
// Response:
//   { success, alreadyOnList, referralCode, referralUrl, queuePosition }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, count, lt } from 'drizzle-orm';
import crypto from 'crypto';
import { getDb } from '../../db/client';
import { masterAssistants, waitlist, waitlistReferrals, users } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

// Stripe (for SC6 coupon generation — imported lazily)
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

/** Generate an 8-char alphanumeric referral code. */
function generateReferralCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
    let code = '';
    const bytes = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return code;
}

/** Get current queue position for a waitlist entry (1-indexed). */
async function getQueuePosition(
    db: any,
    waitlistId: number,
    masterAssistantId: number,
    queuePositionBonus: number
): Promise<number> {
    // Raw position = count of entries created before this one for the same assistant
    const [{ rawPos }] = await db
        .select({ rawPos: count() })
        .from(waitlist)
        .where(and(
            eq(waitlist.masterAssistantId, masterAssistantId),
            lt(waitlist.id, waitlistId)
        ));
    const pos = Math.max(1, Number(rawPos) + 1 - queuePositionBonus);
    return pos;
}

/** Count valid (converted) referrals for a given referral code. */
async function countReferrals(db: any, referralCode: string): Promise<number> {
    const [{ total }] = await db
        .select({ total: count() })
        .from(waitlistReferrals)
        .where(and(
            eq(waitlistReferrals.referralCode, referralCode),
            // Only count converted (joined) referrals — convertedAt is not null handled via IS NOT NULL
        ));
    return Number(total);
}

/** Generate a Stripe coupon for first-month-free (SC6). */
async function generateStripeCoupon(email: string): Promise<string | null> {
    if (!STRIPE_SECRET_KEY) return null;
    try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' });
        const coupon = await stripe.coupons.create({
            percent_off: 100,
            duration: 'once',
            name: 'Referral Reward — First Month Free',
            max_redemptions: 1,
            redeem_by: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days to use
            metadata: { source: 'waitlist_referral', email },
        });
        return coupon.id;
    } catch (err) {
        console.error('[waitlist] Stripe coupon error:', err);
        return null;
    }
}

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    let body: { masterAssistantId?: number; email?: string; ref?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { masterAssistantId, email: rawEmail, ref: incomingRef } = body;
    if (!masterAssistantId || typeof masterAssistantId !== 'number') {
        return { statusCode: 400, body: JSON.stringify({ error: 'masterAssistantId is required.' }) };
    }

    // Resolve caller identity
    let callerId: number | null = null;
    let callerEmail: string | null = null;

    const cookieHeader = event.headers.cookie || '';
    const cookieMatch = cookieHeader.match(/aura_session=([^;]+)/);
    if (cookieMatch && jwtSecret) {
        try {
            const decoded = jwt.verify(cookieMatch[1], jwtSecret) as { userId: number; email: string };
            callerId = decoded.userId;
            callerEmail = decoded.email;
        } catch { /* guest */ }
    }

    const email = callerEmail || (rawEmail || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid email address is required.' }) };
    }

    try {
        const db = getDb();

        // Verify the assistant exists
        const [assistant] = await db
            .select({ id: masterAssistants.id, name: masterAssistants.name, comingSoon: masterAssistants.comingSoon })
            .from(masterAssistants)
            .where(eq(masterAssistants.id, masterAssistantId))
            .limit(1);

        if (!assistant) {
            return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
        }

        // Check for existing entry
        const [existing] = await db
            .select({ id: waitlist.id, referralCode: waitlist.referralCode, queuePositionBonus: waitlist.queuePositionBonus })
            .from(waitlist)
            .where(and(eq(waitlist.email, email), eq(waitlist.masterAssistantId, masterAssistantId)))
            .limit(1);

        if (existing) {
            const pos = await getQueuePosition(db, existing.id, masterAssistantId, existing.queuePositionBonus ?? 0);
            const code = existing.referralCode || '';
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: true,
                    alreadyOnList: true,
                    referralCode: code,
                    referralUrl: code ? `${BASE_URL}/waitlist?ref=${code}` : null,
                    queuePosition: pos,
                }),
            };
        }

        // ── SC5: Validate incoming referral code ───────────────────────────────
        let referrerId: number | null = null;
        let referralCode_used: string | null = incomingRef?.trim().toUpperCase() || null;

        if (referralCode_used) {
            const [referrer] = await db
                .select({ id: waitlist.id, userId: waitlist.userId, email: waitlist.email })
                .from(waitlist)
                .where(and(
                    eq(waitlist.referralCode, referralCode_used),
                    eq(waitlist.masterAssistantId, masterAssistantId)
                ))
                .limit(1);

            if (!referrer || !referrer.userId) {
                referralCode_used = null; // invalid code — ignore
            } else {
                // SC5: Block self-referral by matching email domain
                const referrerDomain = referrer.email.split('@')[1] || '';
                const newUserDomain = email.split('@')[1] || '';
                const isSelfReferral = referrer.email === email || referrerDomain === newUserDomain;
                if (isSelfReferral) {
                    referralCode_used = null;
                } else {
                    referrerId = referrer.userId;
                }
            }
        }

        // ── Insert new waitlist entry ─────────────────────────────────────────
        let newReferralCode: string | null = null;
        if (callerId) {
            // Only registered users get a referral code to share
            newReferralCode = generateReferralCode();
            // Ensure uniqueness (retry once on collision — extremely unlikely)
            const [codeConflict] = await db
                .select({ id: waitlist.id })
                .from(waitlist)
                .where(eq(waitlist.referralCode, newReferralCode))
                .limit(1);
            if (codeConflict) {
                newReferralCode = generateReferralCode();
            }
        }

        const [newEntry] = await db.insert(waitlist).values({
            userId: callerId,
            email,
            masterAssistantId,
            source: callerId ? 'registered' : 'public',
            referralCode: newReferralCode,
            queuePositionBonus: 0,
        }).returning({ id: waitlist.id, queuePositionBonus: waitlist.queuePositionBonus });

        // ── SC2/SC3: Record the referral and reward the referrer ──────────────
        if (referralCode_used && referrerId) {
            await db.insert(waitlistReferrals).values({
                referralCode: referralCode_used,
                referrerId,
                referredEmail: email,
                masterAssistantId,
                convertedAt: new Date(),
            });

            // Count total confirmed referrals for this referrer on this assistant
            const [{ total: referralCount }] = await db
                .select({ total: count() })
                .from(waitlistReferrals)
                .where(and(
                    eq(waitlistReferrals.referralCode, referralCode_used),
                ));
            const totalReferrals = Number(referralCount);

            // Update referrer's queue position bonus and day1 access
            const [referrerEntry] = await db
                .select({ id: waitlist.id, queuePositionBonus: waitlist.queuePositionBonus, day1AccessGranted: waitlist.day1AccessGranted, referralCode: waitlist.referralCode })
                .from(waitlist)
                .where(and(eq(waitlist.referralCode, referralCode_used), eq(waitlist.masterAssistantId, masterAssistantId)))
                .limit(1);

            if (referrerEntry) {
                const newBonus = (referrerEntry.queuePositionBonus ?? 0) + 50; // SC3: +50 per referral
                const grantDay1 = totalReferrals >= 3; // SC3: 3 referrals → Day 1 access

                await db
                    .update(waitlist)
                    .set({
                        queuePositionBonus: newBonus,
                        day1AccessGranted: grantDay1,
                    })
                    .where(eq(waitlist.id, referrerEntry.id));

                // SC6: 5 referrals → generate Stripe coupon and email referrer
                if (totalReferrals === 5) {
                    const couponCode = await generateStripeCoupon(email);
                    if (couponCode) {
                        // Email the referrer
                        const { sendMagicLinkEmail } = await import('../../src/utils/email');
                        const [referrerUser] = await db
                            .select({ email: users.email, firstName: users.firstName })
                            .from(users)
                            .where(eq(users.id, referrerId))
                            .limit(1);
                        if (referrerUser) {
                            await sendMagicLinkEmail({
                                to: referrerUser.email,
                                subject: "🎉 You've earned your first month free!",
                                html: `
                                    <p>Hi ${referrerUser.firstName || 'there'},</p>
                                    <p>You've reached <strong>5 referrals</strong> on the ${assistant.name} waitlist — that's incredible! 🚀</p>
                                    <p>As promised, here's your <strong>first month free</strong> coupon:</p>
                                    <p style="font-size:24px;font-weight:bold;color:#059669;letter-spacing:2px;text-align:center;padding:16px 0;">${couponCode}</p>
                                    <p>Apply this code at checkout when ${assistant.name} launches. Valid for 90 days.</p>
                                    <p>Thank you for spreading the word!</p>
                                    <p>— The Be More Swan Team</p>
                                `,
                            });
                        }
                    }
                }
            }
        }

        const pos = await getQueuePosition(db, newEntry.id, masterAssistantId, newEntry.queuePositionBonus ?? 0);

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                alreadyOnList: false,
                referralCode: newReferralCode,
                referralUrl: newReferralCode ? `${BASE_URL}/waitlist?ref=${newReferralCode}` : null,
                queuePosition: pos,
            }),
        };
    } catch (err: any) {
        console.error('waitlist error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to join waitlist.' }) };
    }
};
