// netlify/functions/check-integration-authorization.ts
// US-LEGAL-1.1: Check whether a workspace has authorized an integration,
// and whether human approval is required before the assistant acts.
//
// GET /.netlify/functions/check-integration-authorization
//   ?integrationType=gmail[&assistantId=N]
//   Auth: aura_session
//
// Returns { authorized: boolean, humanApprovalRequired: boolean, authorizedAt?, authorizationId? }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { integrationAuthorizations, users, userOrganisations } from '../../db/schema';
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

    const qs = event.queryStringParameters || {};
    const integrationType = qs.integrationType?.trim().toLowerCase();
    const assistantId = qs.assistantId ? parseInt(qs.assistantId, 10) : null;

    if (!integrationType) {
        return { statusCode: 400, body: JSON.stringify({ error: 'integrationType query param is required.' }) };
    }

    const db = getDb();

    const [auth] = await db.select({
        id: integrationAuthorizations.id,
        humanApprovalRequired: integrationAuthorizations.humanApprovalRequired,
        authorizedAt: integrationAuthorizations.authorizedAt,
    })
        .from(integrationAuthorizations)
        .where(and(
            eq(integrationAuthorizations.workspaceId, organisationId),
            eq(integrationAuthorizations.integrationType, integrationType),
            assistantId
                ? eq(integrationAuthorizations.assistantId, assistantId)
                : isNull(integrationAuthorizations.assistantId),
            isNull(integrationAuthorizations.revokedAt),
        ))
        .limit(1);

    if (!auth) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorized: false, humanApprovalRequired: true }),
        };
    }

    // US-GOV-4.2.3: stamp lastUsedAt on each check (fire-and-forget)
    db.update(integrationAuthorizations)
        .set({ lastUsedAt: new Date() })
        .where(eq(integrationAuthorizations.id, auth.id))
        .catch(() => {});

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            authorized: true,
            humanApprovalRequired: auth.humanApprovalRequired,
            authorizedAt: auth.authorizedAt,
            authorizationId: auth.id,
        }),
    };
});
