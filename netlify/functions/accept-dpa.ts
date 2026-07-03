// netlify/functions/accept-dpa.ts
// US-GDPR-1.1.1: Record DPA acceptance for an organisation.
// POST /.netlify/functions/accept-dpa
//   Body: { version: string }  (defaults to CURRENT_DPA_VERSION)
//   Cookie: aura_session (authenticated user)
//
// Inserts an append-only row into dpa_acceptances.
// Returns { accepted: true, version, organisationId }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, dpaAcceptances, userOrganisations } from '../../db/schema';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { retryBlockedAssistants } from '../../src/utils/retry-provisioning';

export const CURRENT_DPA_VERSION = '1.0';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [user] = await db
        .select({ email: users.email, organisationId: userOrganisations.organisationId })
        .from(users)
        .leftJoin(userOrganisations, eq(users.id, userOrganisations.userId))
        .where(eq(users.id, userId))
        .limit(1);

    if (!user?.organisationId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'No organisation associated with this account.' }) };
    }

    let body: { version?: string } = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* use defaults */ }

    const version = body.version || CURRENT_DPA_VERSION;
    const ipAddress = event.headers['x-nf-client-connection-ip']
        || event.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || null;
    const userAgent = event.headers['user-agent'] || null;

    await db.insert(dpaAcceptances).values({
        organisationId: user.organisationId,
        version,
        ipAddress,
        userAgent,
        email: user.email,
    });

    // Re-trigger any assistants this org blocked on a DPA gate (best-effort; re-evaluates all gates).
    const baseUrl = resolveBaseUrl(event.headers);
    if (baseUrl) {
        await retryBlockedAssistants(db, { baseUrl, organisationId: user.organisationId }).catch(() => {});
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: true, version, organisationId: user.organisationId }),
    };
};
