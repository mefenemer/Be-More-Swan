// netlify/functions/check-tos.ts
// US-GOV-1.2.1: Check whether the current user has accepted the current ToS version.
//
// GET → { accepted: boolean, version: string, currentVersion: string, upToDate: boolean }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { tosAcceptances } from '../../db/schema';
import { CURRENT_TOS_VERSION } from './accept-tos';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        userId = (jwt.verify(token, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    // Find most recent acceptance
    const [latest] = await db.select({ version: tosAcceptances.version, acceptedAt: tosAcceptances.acceptedAt })
        .from(tosAcceptances)
        .where(eq(tosAcceptances.userId, userId))
        .orderBy(tosAcceptances.acceptedAt)
        .limit(1);

    // Check if current version is accepted
    const [current] = latest ? await db.select({ id: tosAcceptances.id })
        .from(tosAcceptances)
        .where(and(eq(tosAcceptances.userId, userId), eq(tosAcceptances.version, CURRENT_TOS_VERSION)))
        .limit(1) : [null];

    const accepted = !!current;

    return {
        statusCode: 200,
        body: JSON.stringify({
            accepted,
            version: latest?.version ?? null,
            currentVersion: CURRENT_TOS_VERSION,
            upToDate: accepted,
        }),
    };
});
