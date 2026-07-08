// netlify/functions/get-integration-scopes.ts
// US-GOV-4.2.3: Return the minimum required scopes for a set of declared capabilities,
// with a per-scope justification shown to the deployer at OAuth consent time.
// Also returns a scope audit flag if the stored grantedScopes exceed the minimum.
//
// GET /.netlify/functions/get-integration-scopes
//   Query: integrationType=gmail&capabilities=send_email,read_drafts
//          authId=N  (optional — pass to include audit flag for existing auth)
//
// Returns {
//   requiredScopes: string[],
//   justifications: { scope, reason }[],
//   auditFlag?: { overPrivileged: boolean, excessScopes: string[], recommendation: string }
// }

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { oauthScopeRegistry, integrationAuthorizations } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    try { jwt.verify(match[1], jwtSecret); } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const qs = event.queryStringParameters || {};
    const integrationType = qs.integrationType?.trim().toLowerCase();
    const capabilities    = (qs.capabilities || '').split(',').map(c => c.trim()).filter(Boolean);
    const authId          = qs.authId ? parseInt(qs.authId, 10) : null;

    if (!integrationType || !capabilities.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'integrationType and capabilities are required.' }) };
    }

    const db = getDb();

    const rows = await db.select()
        .from(oauthScopeRegistry)
        .where(and(
            eq(oauthScopeRegistry.integrationType, integrationType),
            inArray(oauthScopeRegistry.capability, capabilities),
        ));

    // Deduplicate scopes across capabilities
    const scopeMap = new Map<string, string>(); // scope → justification
    for (const row of rows) {
        for (const scope of row.requiredScopes) {
            if (!scopeMap.has(scope)) scopeMap.set(scope, row.scopeJustification);
        }
    }

    const requiredScopes  = Array.from(scopeMap.keys());
    const justifications  = Array.from(scopeMap.entries()).map(([scope, reason]) => ({ scope, reason }));

    let auditFlag = undefined;
    if (authId) {
        const [auth] = await db.select({ grantedScopes: integrationAuthorizations.grantedScopes })
            .from(integrationAuthorizations)
            .where(eq(integrationAuthorizations.id, authId))
            .limit(1);

        if (auth?.grantedScopes?.length) {
            const excessScopes = auth.grantedScopes.filter(s => !requiredScopes.includes(s));
            auditFlag = {
                overPrivileged: excessScopes.length > 0,
                excessScopes,
                recommendation: excessScopes.length > 0
                    ? `This integration has broader access than required. Recommended scopes: ${requiredScopes.join(', ')}. Click to narrow.`
                    : 'Scopes are minimal — no action needed.',
            };
        }
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requiredScopes, justifications, ...(auditFlag ? { auditFlag } : {}) }),
    };
});
