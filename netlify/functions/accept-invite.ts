// netlify/functions/accept-invite.ts
// US-GAP-5.1.1: Accept an organisation invite via magic link
//
// GET ?token=<plainToken>&orgId=<id>&role=<role>
//
// SC2:  Resolves the stub user, sets password/status, joins org with correct role
// SC5:  If token expired (> 7 days) — returns friendly expiry page
// Flow: Sets JWT session cookie and redirects to /workspace.html

import { Handler } from '@netlify/functions';
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userOrganisations, organisations, notifications } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET!;
const BASE_URL  = process.env.BASE_URL || '';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const qs        = event.queryStringParameters || {};
    const plainToken = qs.token;
    const orgId      = parseInt(qs.orgId || '');
    const role       = qs.role || 'member';

    if (!plainToken || !orgId) {
        return {
            statusCode: 400,
            headers: { 'Content-Type': 'text/html' },
            body: '<p>Invalid invite link. Please ask your admin to send a new invite.</p>',
        };
    }

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

    // Validate the role
    const validRoles = ['member', 'admin', 'viewer'] as const;
    type OrgRole = typeof validRoles[number];
    const assignedRole: OrgRole = validRoles.includes(role as OrgRole) ? (role as OrgRole) : 'member';

    // Mark user as verified + clear token
    await db.update(users)
        .set({
            status:            'active',
            verificationToken: null,
            tokenExpiresAt:    null,
            updatedAt:         now,
        })
        .where(eq(users.id, user.id));

    // SC2: Update the org membership from 'invited' → assigned role
    const [existingMembership] = await db
        .select({ id: userOrganisations.id })
        .from(userOrganisations)
        .where(and(
            eq(userOrganisations.userId, user.id),
            eq(userOrganisations.organisationId, orgId),
        ))
        .limit(1);

    if (existingMembership) {
        await db.update(userOrganisations)
            .set({ role: assignedRole })
            .where(eq(userOrganisations.id, existingMembership.id));
    } else {
        await db.insert(userOrganisations).values({
            userId: user.id, organisationId: orgId, role: assignedRole,
        }).onConflictDoNothing();
    }

    // In-app notification: welcome to the org
    const [org] = await db
        .select({ name: organisations.name })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const orgName = org?.name || 'your new workspace';

    await db.insert(notifications).values({
        userId:  user.id,
        type:    'org_joined',
        title:   `Welcome to ${orgName}!`,
        message: `You've successfully joined ${orgName} as a ${assignedRole}.`,
        metadata: { orgId, role: assignedRole },
    }).catch(() => {});

    // Issue a session JWT + redirect to workspace
    const token = jwt.sign({ userId: user.id, activeOrganisationId: orgId }, jwtSecret, { expiresIn: '7d' });
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
};
