// netlify/functions/check-token-revoked.ts
// US-ADM-1.3.2: Called by auth-guard edge function to check if a userId is blocklisted.
// GET /.netlify/functions/check-token-revoked?userId=123
//
// Returns { revoked: boolean }
// No authentication required — the userId comes from the decoded JWT in the edge function.
// The endpoint does not expose any PII; it only answers yes/no for a given numeric userId.

import { Handler } from '@netlify/functions';
import { eq, and, or, isNull, gt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { jwtBlocklist } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const userIdParam = event.queryStringParameters?.userId;
    const userId = userIdParam ? parseInt(userIdParam, 10) : NaN;

    if (isNaN(userId)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'userId required.' }) };
    }

    const db = getDb();
    const now = new Date();

    const [entry] = await db
        .select({ id: jwtBlocklist.id })
        .from(jwtBlocklist)
        .where(
            and(
                eq(jwtBlocklist.userId, userId),
                eq(jwtBlocklist.blockType, 'userId'),
                or(isNull(jwtBlocklist.expiresAt), gt(jwtBlocklist.expiresAt, now)),
            )
        )
        .limit(1);

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ revoked: !!entry }),
    };
});
