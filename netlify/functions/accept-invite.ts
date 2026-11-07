// netlify/functions/accept-invite.ts
// US-GAP-5.1.1: Accept an organisation invite via magic link
//
// GET ?token=<plainToken>&orgId=<id>&role=<role>&sig=<signature>
//
// SECURITY: the token column is shared with the sign-up and magic-link emails, so a valid token does
// NOT prove an invite. Two checks do, both before anything is written: the signature made by
// invite-member.ts (src/utils/invite-link.ts), and this user's pending 'invited' row for this org.
//
// SC2:  Resolves the stub user, sets password/status, joins org with correct role
// SC5:  If token expired (> 7 days) — returns friendly expiry page
// Flow: Sets JWT session cookie and redirects to /workspace.html

import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, organisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { recordLogin } from '../../src/utils/login-events';
import { isInviteRole, verifyInviteSignature } from '../../src/utils/invite-link';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET!;
const BASE_URL  = process.env.BASE_URL || '';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

/** One reply for every refusal, so it never reveals whether a workspace or an invite exists. */
const INVALID_INVITE = {
    statusCode: 400,
    headers: { 'Content-Type': 'text/html' },
    body: '<p>Invalid invite link. Please ask your admin to send a new invite.</p>',
};

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const qs        = event.queryStringParameters || {};
    const plainToken = qs.token;
    const orgId      = parseInt(qs.orgId || '');
    const role       = qs.role || 'member';

    if (!plainToken || !orgId || !isInviteRole(role)) return INVALID_INVITE;
    if (!jwtSecret) return { statusCode: 500, body: 'Server misconfigured.' };
    if (!verifyInviteSignature(plainToken, orgId, role, qs.sig, jwtSecret)) return INVALID_INVITE;

    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
    const db = getDb();
    const now = new Date();

    // Look up user by invite token
    const [user] = await db
        .select({
            id:               users.id,
            email:            users.email,
            firstName:        users.firstName,
            tokenExpiresAt:   users.tokenExpiresAt,
            status:           users.status,
        })
        .from(users)
        .where(eq(users.verificationToken, hashedToken))
        .limit(1);

    if (!user) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'text/html' },
            body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invalid Invite — Be More Swan</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}</style></head>
<body><div class="card">
  <div style="font-size:2.5rem;margin-bottom:1rem">❌</div>
  <h1 style="font-size:1.2rem;margin-bottom:.5rem">Invalid invite link</h1>
  <p style="color:#6b7280;font-size:.9rem">This invite link is not recognised. Please ask your workspace admin to send a new invite.</p>
</div></body></html>`,
        };
    }

    // SC5: Check expiry
    const expiresAt = user.tokenExpiresAt instanceof Date
        ? user.tokenExpiresAt
        : user.tokenExpiresAt ? new Date(user.tokenExpiresAt as string) : null;

    if (expiresAt && now > expiresAt) {
        return {
            statusCode: 410,
            headers: { 'Content-Type': 'text/html' },
            body: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Invite Expired — Be More Swan</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:440px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}</style></head>
<body><div class="card">
  <div style="font-size:2.5rem;margin-bottom:1rem">⏰</div>
  <h1 style="font-size:1.2rem;margin-bottom:.5rem">This invite has expired</h1>
  <p style="color:#6b7280;font-size:.9rem">Please ask your team admin to send a new invite.</p>
</div></body></html>`,
        };
    }

    // An invite must be waiting for this person in this workspace. Claiming the row is the first
    // write, and only an 'invited' row can be claimed, so a member's or owner's role never changes here.
    const assignedRole = role;
    const claimed = await db.update(userOrganisations)
        .set({ role: assignedRole })
        .where(and(
            eq(userOrganisations.userId, user.id),
            eq(userOrganisations.organisationId, orgId),
            eq(userOrganisations.role, 'invited'),
        ))
        .returning({ id: userOrganisations.id });
    if (claimed.length === 0) return INVALID_INVITE;

    // Mark user as verified + clear token
    await db.update(users)
        .set({
            status:            'active',
            verificationToken: null,
            tokenExpiresAt:    null,
            updatedAt:         now,
        })
        .where(eq(users.id, user.id));

    // In-app notification: welcome to the org
    const [org] = await db
        .select({ name: organisations.name })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const orgName = org?.name || 'your new workspace';

    await createNotification(db, 'org_joined', {
        userId: user.id,
        context: { org: { name: orgName, role: assignedRole } },
        metadata: { orgId, role: assignedRole },
    });

    // Issue a session JWT + redirect to workspace
    const token = jwt.sign({ userId: user.id, activeOrganisationId: orgId }, jwtSecret, { expiresIn: '7d' });
    await recordLogin(db, { userId: user.id, organisationId: orgId, method: 'invite', headers: event.headers });
    const cookieOpts = [
        `aura_session=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=604800',
        ...(COOKIE_DOMAIN ? [`Domain=${COOKIE_DOMAIN}`] : []),
        ...(BASE_URL.startsWith('https') ? ['Secure'] : []),
    ].join('; ');

    return {
        statusCode: 302,
        headers: {
            'Set-Cookie': cookieOpts,
            'Location':   `${BASE_URL}/workspace.html?joined=${encodeURIComponent(orgName)}`,
        } as Record<string, string>,
        body: '',
    };
});
