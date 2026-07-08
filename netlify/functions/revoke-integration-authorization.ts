// netlify/functions/revoke-integration-authorization.ts
// US-LEGAL-1.1: Revoke a previously granted integration authorization.
// The assistant will no longer be able to act on that connected service.
//
// POST /.netlify/functions/revoke-integration-authorization
//   Body: { authorizationId: number }
//   Auth: aura_session (must belong to same workspace)

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { integrationAuthorizations, users, userOrganisations } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let userId: number;
    let organisationId: number | undefined;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; organisationId?: number };
        userId = decoded.userId;
        organisationId = decoded.organisationId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    if (!organisationId) {
        const db = getDb();
        const [u] = await db.select({ organisationId: userOrganisations.organisationId }).from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);
        if (!u?.organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found.' }) };
        organisationId = u.organisationId;
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { authorizationId } = body;
    if (!authorizationId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'authorizationId is required.' }) };
    }

    const db = getDb();

    const [auth] = await db.select({ id: integrationAuthorizations.id, workspaceId: integrationAuthorizations.workspaceId })
        .from(integrationAuthorizations)
        .where(and(eq(integrationAuthorizations.id, authorizationId), isNull(integrationAuthorizations.revokedAt)))
        .limit(1);

    if (!auth) return { statusCode: 404, body: JSON.stringify({ error: 'Authorization not found or already revoked.' }) };
    if (auth.workspaceId !== organisationId) return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden.' }) };

    await db.update(integrationAuthorizations)
        .set({ revokedAt: new Date(), revokedByUserId: userId })
        .where(eq(integrationAuthorizations.id, authorizationId));

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
    };
});
