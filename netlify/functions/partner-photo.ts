// netlify/functions/partner-photo.ts
// The photo on a partner's own invite page (docs/partner-onboarding-plan.md §3.3; src/utils/partner-invite-profile.ts).
//
//   GET ?p=<partnerId>&k=<file name>  → image/jpeg
//
// Photos live in our private R2 bucket. This serves one only when it is:
//   • the partner's APPROVED invite-page photo, and the partner is approved — to anyone (it's on /invite/<code>);
//   • their PENDING photo — only to that partner (signed in) or an admin who can manage partners
//     (so they can review it). Never while impersonating a customer: the admin uses Admin → Partners.
// Anything else is a 404, so the URL never reveals whether a photo exists.

import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { partners, users } from '../../db/schema';
import { requirePermission } from '../../src/utils/rbac';
import { PHOTO_PREFIX, getPhoto } from '../../src/utils/partner-invite-profile';

const notFound = { statusCode: 404, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, body: 'Not found' };

function sessionUserId(cookie: string | undefined): number | null {
    const secret = process.env.JWT_SECRET;
    const m = (cookie || '').match(/aura_session=([^;]+)/);
    if (!secret || !m) return null;
    try {
        const tok = jwt.verify(m[1], secret) as { userId: number; scope?: string };
        return tok.scope === 'impersonate' ? null : tok.userId;
    } catch { return null; }
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
    const q = event.queryStringParameters || {};
    const partnerId = Number(q.p);
    const file = String(q.k || '');
    if (!Number.isInteger(partnerId) || partnerId < 1 || !/^[a-f0-9]{24}\.jpg$/.test(file)) return notFound;
    const key = `${PHOTO_PREFIX}${partnerId}/${file}`;

    const db = getDb();
    const [p] = await db.select({ status: partners.status, userId: partners.userId, live: partners.inviteProfile, pending: partners.inviteProfilePending })
        .from(partners).where(eq(partners.id, partnerId)).limit(1);
    if (!p) return notFound;

    let isPublic = false;
    if (p.live?.photoKey === key && p.status === 'approved') isPublic = true;
    else if (p.pending?.photoKey === key || p.live?.photoKey === key) {
        // A photo waiting for review (or a live one while they're suspended): the partner or a partner admin only.
        const viewer = sessionUserId(event.headers.cookie);
        if (!viewer) return notFound;
        if (viewer !== p.userId) {
            const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, viewer)).limit(1);
            if (requirePermission(u?.role, 'manage_partners')) return notFound;
        }
    } else return notFound;

    try {
        const bytes = await getPhoto(key);
        if (!bytes) return notFound;
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'image/jpeg',
                // Keys are random and change with every new photo, so an approved one can be cached; a pending one can't be shared.
                'Cache-Control': isPublic ? 'public, max-age=86400' : 'private, no-store',
                'X-Content-Type-Options': 'nosniff',
            },
            body: bytes.toString('base64'),
            isBase64Encoded: true,
        };
    } catch (err) {
        console.error('[partner-photo] read failed', err);
        return notFound;
    }
});
