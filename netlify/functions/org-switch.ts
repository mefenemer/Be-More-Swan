// netlify/functions/org-switch.ts
// US-DB-1.3.1: Switch the session's active organisation.
//
// POST { organisationId } — verifies the caller is a current member of the
// target org, then re-issues the aura_session cookie with the new
// activeOrganisationId claim (other claims preserved). Membership is the source
// of truth; a request for an org the user isn't in is rejected.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { getSession } from '../../src/utils/session';
import { requireOrgMembership } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const BASE_URL = process.env.BASE_URL || '';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || '';

export default withLambda(async (event) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    const session = getSession(event);
    if (!session) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let organisationId: number;
    try {
        organisationId = Number(JSON.parse(event.body || '{}').organisationId);
    } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body.' }) };
    }
    if (!Number.isInteger(organisationId) || organisationId <= 0) {
        return { statusCode: 400, body: JSON.stringify({ error: 'organisationId is required.' }) };
    }

    const db = getDb();
    const membership = await requireOrgMembership(db, session.userId, organisationId);
    if (!membership) {
        return { statusCode: 403, body: JSON.stringify({ error: 'You are not a member of that organisation.' }) };
    }

    // Re-issue the session cookie with the new active org, preserving other claims.
    const payload: Record<string, unknown> = { userId: session.userId, activeOrganisationId: organisationId };
    if (session.email) payload.email = session.email;
    if (session.adminRole) payload.adminRole = session.adminRole;

    const token = jwt.sign(payload, jwtSecret, { expiresIn: '7d' });
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
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookieOpts } as Record<string, string>,
        body: JSON.stringify({ success: true, activeOrganisationId: organisationId, role: membership.role }),
    };
});
