// netlify/functions/authorize-integration.ts
// US-LEGAL-1.1: Record a user's signed consent to allow an assistant to act on a
// connected integration (e.g. send email via Gmail, post via Twitter).
// Must be completed before the assistant can execute outbound actions on that service.
//
// POST /.netlify/functions/authorize-integration
//   Body: {
//     integrationType: string,       // e.g. 'gmail' | 'google_calendar' | 'twitter'
//     assistantId?: number,
//     humanApprovalRequired?: boolean  // defaults true
//   }
//   Auth: aura_session

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { integrationAuthorizations, aiAssistants, users, userOrganisations } from '../../db/schema';
import { validateDisclosureText } from '../../src/utils/ai-email-footer';
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
    let organisationId: number;
    try {
        const decoded = jwt.verify(match[1], jwtSecret) as { userId: number; organisationId?: number };
        userId = decoded.userId;
        organisationId = decoded.organisationId!;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    if (!organisationId) {
        // Fall back to loading org from DB
        const db = getDb();
        const [u] = await db.select({ organisationId: userOrganisations.organisationId }).from(userOrganisations).where(eq(userOrganisations.userId, userId)).limit(1);
        if (!u?.organisationId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found.' }) };
        organisationId = u.organisationId;
    }

    let body: any = {};
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }

    const { integrationType, assistantId, humanApprovalRequired = true, disclosureText, grantedScopes } = body;
    if (!integrationType?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'integrationType is required.' }) };
    }

    // US-GOV-3.1.2: Validate custom disclosure text if provided
    if (disclosureText != null) {
        const validationError = validateDisclosureText(String(disclosureText));
        if (validationError) return { statusCode: 400, body: JSON.stringify({ error: validationError }) };
    }

    const db = getDb();

    // Validate assistantId belongs to this workspace if provided
    if (assistantId) {
        const [asst] = await db.select({ id: aiAssistants.id })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
            .limit(1);
        if (!asst) return { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found.' }) };
    }

    // Upsert: revoke any existing auth for this workspace+integration+assistant, then insert fresh
    const existing = await db.select({ id: integrationAuthorizations.id })
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

    const now = new Date();
    // Detect scope change for lastScopeChangedAt tracking
    const scopesChanged = Array.isArray(grantedScopes) && grantedScopes.length > 0;

    if (existing.length) {
        await db.update(integrationAuthorizations)
            .set({
                humanApprovalRequired,
                ...(disclosureText != null ? { disclosureText: String(disclosureText).trim() || null } : {}),
                ...(scopesChanged ? { grantedScopes, lastScopeChangedAt: now } : {}),
                authorizedAt: now,
                authorizedByUserId: userId,
            })
            .where(eq(integrationAuthorizations.id, existing[0].id));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, updated: true, humanApprovalRequired }),
        };
    }

    const [row] = await db.insert(integrationAuthorizations).values({
        workspaceId: organisationId,
        authorizedByUserId: userId,
        integrationType: integrationType.trim().toLowerCase(),
        assistantId: assistantId ?? null,
        humanApprovalRequired,
        ...(disclosureText != null ? { disclosureText: String(disclosureText).trim() || null } : {}),
        ...(scopesChanged ? { grantedScopes, lastScopeChangedAt: now } : {}),
    }).returning({ id: integrationAuthorizations.id });

    return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, authorizationId: row.id, humanApprovalRequired }),
    };
});
