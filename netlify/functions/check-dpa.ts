// netlify/functions/check-dpa.ts
// US-GDPR-1.1.1: Check whether the authenticated user's organisation has accepted the DPA.
// GET /.netlify/functions/check-dpa
//   Returns { accepted: boolean, version: string | null, acceptedAt: string | null }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, dpaAcceptances, userOrganisations } from '../../db/schema';
import { CURRENT_DPA_VERSION } from './accept-dpa';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
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
        .select({ organisationId: userOrganisations.organisationId })
        .from(userOrganisations)
        .where(eq(userOrganisations.userId, userId))
        .limit(1);

    if (!user?.organisationId) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accepted: false, version: null, acceptedAt: null, currentVersion: CURRENT_DPA_VERSION }),
        };
    }

    const [latest] = await db
        .select({ version: dpaAcceptances.version, acceptedAt: dpaAcceptances.acceptedAt })
        .from(dpaAcceptances)
        .where(eq(dpaAcceptances.organisationId, user.organisationId))
        .orderBy(desc(dpaAcceptances.acceptedAt))
        .limit(1);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accepted: !!latest,
            version: latest?.version ?? null,
            acceptedAt: latest?.acceptedAt ?? null,
            currentVersion: CURRENT_DPA_VERSION,
            upToDate: latest?.version === CURRENT_DPA_VERSION,
        }),
    };
});
