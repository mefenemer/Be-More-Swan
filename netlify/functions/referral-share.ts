/**
 * netlify/functions/referral-share.ts
 *
 * POST /referral-share  { friendEmail }
 *   → emails the caller's (existing) referral link to a friend.
 *
 * Keeps the single reusable referral code model (see referral.ts) — this just
 * delivers that one link by email. SMS/WhatsApp delivery is a higher-tier feature
 * and is handled in the UI (greyed), not here.
 */

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, referralInvites } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { sendEmail } from '../../src/utils/email';

const jwtSecret = process.env.JWT_SECRET;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

// Conservative email shape check — the real validation is the friend receiving it.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const callerId = getAuth(event);
    if (!callerId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const BASE_URL = resolveBaseUrl(event.headers);
    if (!BASE_URL) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    let body: { friendEmail?: string } = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const friendEmail = (body.friendEmail || '').trim();
    if (!EMAIL_RE.test(friendEmail)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
    }

    const db = getDb();
    const [user] = await db
        .select({ firstName: users.firstName, email: users.email, referralCode: users.referralCode })
        .from(users).where(eq(users.id, callerId)).limit(1);

    if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
    // Guard: must have generated a referral code first (UI only shows share once a code exists).
    if (!user.referralCode) {
        return { statusCode: 409, body: JSON.stringify({ error: 'Generate your referral link first.', code: 'NO_REFERRAL_CODE' }) };
    }
    // Don't let users email their own link to themselves.
    if (friendEmail.toLowerCase() === (user.email || '').toLowerCase()) {
        return { statusCode: 400, body: JSON.stringify({ error: "That's your own email — enter a friend's address." }) };
    }

    const shareLink = `${BASE_URL}/register.html?ref=${user.referralCode}`;
    const fromName = esc(user.firstName || 'A friend');

    try {
        await sendEmail({
            to: friendEmail,
            subject: `${fromName} invited you to try Be More Swan`,
            html: `<p>Hi there,</p>
                   <p><strong>${fromName}</strong> thinks you'd love Be More Swan — your own AI team members that handle the work you don't have time for.</p>
                   <p>Sign up using their referral link to get started:</p>
                   <p style="margin:24px 0;">
                     <a href="${shareLink}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                       Get started with Be More Swan →
                     </a>
                   </p>
                   <p style="font-size:0.875rem;color:#6b7280;">Or copy this link: ${shareLink}</p>
                   <p style="font-size:0.8rem;color:#9ca3af;">You received this because ${fromName} chose to share their referral link with you.</p>`,
        });
    } catch (err) {
        console.error('[referral-share] send failed:', (err as Error)?.message);
        return { statusCode: 502, body: JSON.stringify({ error: 'Could not send the email right now. Please try again.' }) };
    }

    // Record the sent invite so it appears as "Invited — awaiting sign-up" in the sender's
    // Referral Activity. Non-blocking: a write failure must not fail the (already-sent) email.
    try {
        await db.insert(referralInvites).values({
            referrerId: callerId,
            email: friendEmail.toLowerCase(),
            referralCode: user.referralCode,
            status: 'invited',
        }).onConflictDoUpdate({
            target: [referralInvites.referrerId, referralInvites.email],
            set: { sentAt: new Date(), status: 'invited' },
        });
    } catch (inviteErr) {
        console.warn('[referral-share] Failed to record invite (non-blocking):', (inviteErr as Error)?.message);
    }

    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true }) };
};
