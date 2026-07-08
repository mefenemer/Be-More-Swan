// netlify/functions/revoke-connections.ts
// US-AUD-4.2.1 SC4/SC5: Revoke OAuth/API-key connections and delete vault secrets.
//
//  POST { scope: 'single', connectionId: N }  → SC5: revoke one connection
//  POST { scope: 'org' }                       → SC4: revoke ALL connections for caller's org
import { HandlerEvent } from '@netlify/functions';
import { eq, and, inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, systemConnections, userOrganisations } from '../../db/schema';
import { deleteSecret, deleteSecretsByPrefix } from '../../src/utils/vault';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }
    if (!jwtSecret) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error.' }) };
    }

    // Auth
    const rawCookies = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookies.split(';').map(c => {
            const [k, ...v] = c.trim().split('=');
            return [k, decodeURIComponent(v.join('='))];
        }).filter(([k]) => k !== '')
    );
    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
    }

    const db = getDb();
    const body = JSON.parse(event.body || '{}');
    const { scope, connectionId } = body;

    // ── SC5: Single connection revocation ─────────────────────────────────────
    if (scope === 'single') {
        if (!connectionId) {
            return { statusCode: 400, body: JSON.stringify({ error: 'connectionId required for single revocation.' }) };
        }
        try {
            const [conn] = await db
                .select()
                .from(systemConnections)
                .where(and(eq(systemConnections.id, connectionId), eq(systemConnections.userId, userId)))
                .limit(1);

            if (!conn) {
                return { statusCode: 404, body: JSON.stringify({ error: 'Connection not found or not owned by this user.' }) };
            }

            // Delete vault secret
            if (conn.vaultRefKey) {
                await deleteSecret(db as any, conn.vaultRefKey);
            }

            // Mark connection as revoked, clear deprecated plaintext fields
            await db
                .update(systemConnections)
                .set({
                    status: 'revoked',
                    isActive: false,
                    vaultRefKey: null,
                    updatedAt: new Date(),
                })
                .where(eq(systemConnections.id, connectionId));

            return { statusCode: 200, body: JSON.stringify({ success: true, revoked: 1 }) };
        } catch (err) {
            console.error('revoke-connections single error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to revoke connection.' }) };
        }
    }

    // ── SC4: Org-wide revocation (admins/owners only) ─────────────────────────
    if (scope === 'org') {
        try {
            // Verify caller is owner or admin of the org
            const [user] = await db
                .select({ organisationId: userOrganisations.organisationId })
                .from(userOrganisations)
                .where(eq(userOrganisations.userId, userId));
            if (!user?.organisationId) {
                return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found for this account.' }) };
            }
            const orgId = user.organisationId;

            const [membership] = await db
                .select({ role: userOrganisations.role })
                .from(userOrganisations)
                .where(and(eq(userOrganisations.userId, userId), eq(userOrganisations.organisationId, orgId)))
                .limit(1);

            if (!membership || !['owner', 'admin'].includes(membership.role)) {
                return { statusCode: 403, body: JSON.stringify({ error: 'Only org owners and admins can revoke all connections.' }) };
            }

            // Fetch all active connections for users in this org
            const orgMembers = await db
                .select({ userId: userOrganisations.userId })
                .from(userOrganisations)
                .where(eq(userOrganisations.organisationId, orgId));

            const memberIds = orgMembers.map(m => m.userId);
            if (memberIds.length === 0) {
                return { statusCode: 200, body: JSON.stringify({ success: true, revoked: 0 }) };
            }

            const orgConnections = await db
                .select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey })
                .from(systemConnections)
                .where(and(
                    inArray(systemConnections.userId, memberIds),
                    eq(systemConnections.isActive, true)
                ));

            // Delete all vault secrets for this org
            const orgPrefix = `aura/user-`; // We delete by matching each refKey individually
            let vaultDeleted = 0;
            for (const conn of orgConnections) {
                if (conn.vaultRefKey) {
                    await deleteSecret(db as any, conn.vaultRefKey);
                    vaultDeleted++;
                }
            }

            // Mark all connections as revoked
            if (orgConnections.length > 0) {
                await db
                    .update(systemConnections)
                    .set({
                        status: 'revoked',
                        isActive: false,
                        vaultRefKey: null,
                        updatedAt: new Date(),
                    })
                    .where(inArray(systemConnections.id, orgConnections.map(c => c.id)));
            }

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, revoked: orgConnections.length, vaultSecretsDeleted: vaultDeleted }),
            };
        } catch (err) {
            console.error('revoke-connections org error:', err);
            return { statusCode: 500, body: JSON.stringify({ error: 'Failed to revoke org connections.' }) };
        }
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'scope must be "single" or "org".' }) };
});
