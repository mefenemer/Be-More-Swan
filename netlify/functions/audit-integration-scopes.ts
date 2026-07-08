// netlify/functions/audit-integration-scopes.ts
// US-GOV-4.2.3: Scope audit — flags integrations whose grantedScopes exceed the minimum
// required for their declared capabilities. SuperAdmins see all workspaces; deployers
// see only their own workspace.
//
// GET /.netlify/functions/audit-integration-scopes
//   Query: workspaceId=N (SuperAdmin only — omit for own workspace)
//
// Returns { integrations: AuditRow[] }
// where AuditRow = { authId, integrationType, assistantId, grantedScopes, minimumScopes,
//                    excessScopes, overPrivileged, recommendation, lastUsedAt, lastScopeChangedAt }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, integrationAuthorizations, oauthScopeRegistry, userOrganisations } from '../../db/schema';
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
    const [user] = await db.select({ role: users.role, organisationId: userOrganisations.organisationId })
        .from(users).leftJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(users.id, userId)).limit(1);
    if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

    const isSuperAdmin = user.role === 'super_admin';
    const qs = event.queryStringParameters || {};

    let workspaceId: number | null = null;
    if (qs.workspaceId) {
        if (!isSuperAdmin) return { statusCode: 403, body: JSON.stringify({ error: 'Super admin required to query other workspaces.' }) };
        workspaceId = parseInt(qs.workspaceId, 10);
    } else {
        workspaceId = user.organisationId ?? null;
    }

    if (!workspaceId) return { statusCode: 400, body: JSON.stringify({ error: 'No workspace found.' }) };

    // Load all active authorizations for the workspace
    const auths = await db.select()
        .from(integrationAuthorizations)
        .where(and(
            eq(integrationAuthorizations.workspaceId, workspaceId),
            isNull(integrationAuthorizations.revokedAt),
        ));

    // Load all scope registry entries (cached in memory for this request)
    const registry = await db.select().from(oauthScopeRegistry);
    const registryByType = new Map<string, typeof registry[0][]>();
    for (const r of registry) {
        const list = registryByType.get(r.integrationType) || [];
        list.push(r);
        registryByType.set(r.integrationType, list);
    }

    const integrations = auths.map(auth => {
        const typeRegistry = registryByType.get(auth.integrationType) || [];
        // All minimum scopes for this integration type (union of all capabilities)
        const minimumScopes = [...new Set(typeRegistry.flatMap(r => r.requiredScopes))];
        const granted       = auth.grantedScopes || [];
        const excessScopes  = granted.filter(s => !minimumScopes.includes(s));
        const overPrivileged = excessScopes.length > 0;

        return {
            authId:             auth.id,
            integrationType:    auth.integrationType,
            assistantId:        auth.assistantId,
            grantedScopes:      granted,
            minimumScopes,
            excessScopes,
            overPrivileged,
            recommendation:     overPrivileged
                ? `This integration has broader access than required. Recommended scopes: ${minimumScopes.join(', ')}. Click to narrow.`
                : null,
            lastUsedAt:         auth.lastUsedAt,
            lastScopeChangedAt: auth.lastScopeChangedAt,
        };
    });

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ integrations }),
    };
});
