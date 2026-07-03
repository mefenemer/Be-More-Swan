import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, or, isNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, scheduledPosts, notifications, users, userOrganisations, auditLogs } from '../../db/schema';
import { storeSecret, deleteSecret, buildRefKey } from '../../src/utils/vault';
import { isServiceAllowedForAssistant, allowedServiceNames, relevantConnectorsForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';
import { findTenantCollision, recordCollisionAttempt } from '../../src/utils/connection-collision';

const jwtSecret = process.env.JWT_SECRET;

export const handler: Handler = async (event) => {
    // 1. Session Authentication
    const cookieHeader = event.headers.cookie || '';
    const sessionToken = cookieHeader.match(/aura_session=([^;]+)/)?.[1];

    if (!sessionToken || !jwtSecret) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let currentUserId: number;
    try {
        currentUserId = (jwt.verify(sessionToken, jwtSecret) as { userId: number }).userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    try {
    // US-DB-1.3.1: resolve orgId — mandatory for all system_connections queries
    const [currentUser] = await db.select({ organisationId: userOrganisations.organisationId }).from(userOrganisations).where(eq(userOrganisations.userId, currentUserId)).limit(1);
    const currentOrgId = currentUser?.organisationId ?? null;
        // --- GET: FETCH INTEGRATIONS DASHBOARD ---
        if (event.httpMethod === 'GET') {
            // 1. Fetch system-wide platform definitions (userId is null)
            // Select only non-sensitive columns — tokens must never leave the server.
            const safeColumns = {
                id: systemConnections.id,
                serviceName: systemConnections.serviceName,
                connectionType: systemConnections.connectionType,
                externalUserId: systemConnections.externalUserId,
                scopes: systemConnections.scopes,
                status: systemConnections.status,
                isActive: systemConnections.isActive,
                metadata: systemConnections.metadata,
                createdAt: systemConnections.createdAt,
                updatedAt: systemConnections.updatedAt,
                tokenExpiresAt: systemConnections.tokenExpiresAt,
            };

            const systemCatalog = await db.select(safeColumns).from(systemConnections).where(isNull(systemConnections.userId));

            // 2. Fetch current user's connections scoped by org (US-DB-1.3.1)
            const userConnections = await db.select(safeColumns).from(systemConnections).where(
                currentOrgId
                    ? and(eq(systemConnections.organisationId, currentOrgId), eq(systemConnections.userId, currentUserId))
                    : eq(systemConnections.userId, currentUserId)
            );

            // 3. Merge: user connection overrides the system catalog row for the same service
            const merged = systemCatalog.map(catalog => {
                const userConn = userConnections.find(u => u.serviceName === catalog.serviceName);
                return userConn ? { ...userConn, connected: true } : { ...catalog, connected: false };
            });
            // Also include user connections for services not in the system catalog
            userConnections.forEach(uc => {
                if (!merged.find(m => m.serviceName === uc.serviceName)) {
                    merged.push({ ...uc, connected: true });
                }
            });

            // Server-side connection sandboxing: when scoped to an assistant, return
            // only the connectors relevant to its role (defence in depth — the UI also
            // filters, but the server is authoritative). Invalid assistant → 400.
            const assistantIdParam = event.queryStringParameters?.assistantId;
            if (assistantIdParam) {
                const assistant = await resolveAssistantRole(db, currentOrgId, parseInt(assistantIdParam, 10));
                if (!assistant) return { statusCode: 400, body: JSON.stringify({ error: 'Unknown assistant.' }) };
                const visible = merged.filter(m => isServiceAllowedForAssistant(m.serviceName, assistant));
                // Relevance is policy-driven, not row-driven: social connectors only become
                // DB rows after a user connects via OAuth, so deriving the allow-list from
                // `merged` alone would hide every connector for a fresh assistant. Union the
                // role's relevant connectors with any already-existing allowed services.
                const allowedServices = Array.from(new Set([
                    ...relevantConnectorsForAssistant(assistant),
                    ...allowedServiceNames(assistant, merged.map(m => m.serviceName)),
                ]));
                return { statusCode: 200, body: JSON.stringify({ connections: visible, allowedServices }) };
            }

            return { statusCode: 200, body: JSON.stringify({ connections: merged }) };
        }

        // --- POST: SECURE CONNECTION CREATION ---
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body || '{}');
            const { serviceName, connectionType, apiKey, handle, pageUrl, scopes, assistantId } = body;

            if (!serviceName || !apiKey) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Service name and access token are required.' }) };
            }

            // Server-side connection sandboxing: if this connection is being made in the
            // context of an assistant, the service must be relevant to that assistant's
            // role (e.g. a Social Media Manager cannot connect an HR/CRM service).
            if (assistantId !== undefined && assistantId !== null) {
                const assistant = await resolveAssistantRole(db, currentOrgId, parseInt(String(assistantId), 10));
                if (!assistant) return { statusCode: 400, body: JSON.stringify({ error: 'Unknown assistant.' }) };
                if (!isServiceAllowedForAssistant(serviceName, assistant)) {
                    console.warn(`[integrations] Sandbox violation blocked: ${serviceName} not allowed for assistant ${assistantId} (${assistant.roleKey ?? assistant.role})`);
                    return { statusCode: 403, body: JSON.stringify({ error: `${serviceName} is not a relevant connection for this assistant.`, code: 'CONNECTION_NOT_RELEVANT' }) };
                }
            }

            // ── Scope Creep guard: whitelist permitted scopes per service ────
            // If scopes are provided, validate them against the allowed set to
            // prevent over-privileged OAuth grants (e.g., requesting write access
            // when only read is needed for the connected workflow).
            const ALLOWED_SCOPES: Record<string, string[]> = {
                facebook:      ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_to_groups', 'pages_manage_metadata', 'pages_messaging'],
                instagram:     ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_manage_metadata', 'pages_messaging', 'pages_manage_posts'],
                linkedin:      ['r_liteprofile', 'r_emailaddress', 'w_member_social', 'r_organization_social', 'w_organization_social'],
                twitter:       ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
                google:        ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
                openai:        [],  // API key — no scope concept
                notion:        ['read_content', 'update_content', 'insert_content'],
                hubspot:       ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
                slack:         ['channels:read', 'chat:write', 'files:write'],
            };

            const serviceKey = serviceName.toLowerCase();
            if (scopes && Array.isArray(scopes)) {
                const allowed = ALLOWED_SCOPES[serviceKey];
                if (allowed !== undefined) { // known service
                    const forbidden = scopes.filter((s: string) => !allowed.includes(s));
                    if (forbidden.length > 0) {
                        console.warn(`[integrations] Scope creep blocked for ${serviceKey}:`, forbidden);
                        return {
                            statusCode: 400,
                            body: JSON.stringify({
                                error: `The following OAuth scopes are not permitted for ${serviceName}: ${forbidden.join(', ')}`,
                                code: 'SCOPE_NOT_PERMITTED',
                            }),
                        };
                    }
                }
            }

            // Upsert — if the user already has a connection for this service, replace it
            // US-DB-1.3.1: scope upsert check by organisationId + userId
            const existing = await db
                .select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey })
                .from(systemConnections)
                .where(and(
                    eq(systemConnections.userId, currentUserId),
                    eq(systemConnections.serviceName, serviceName),
                    ...(currentOrgId ? [eq(systemConnections.organisationId, currentOrgId)] : []),
                ))
                .limit(1);

            // US1 AC1.3: block if this account/handle is already live in another workspace.
            if (handle && currentOrgId) {
                const collision = await findTenantCollision(db, { serviceName, externalUserId: handle, organisationId: currentOrgId });
                if (collision) {
                    await recordCollisionAttempt(db, { requestingOrgId: currentOrgId, existingOrgId: collision.organisationId, serviceName, externalUserId: handle });
                    return { statusCode: 409, body: JSON.stringify({
                        error: `This ${serviceName} account is already connected to another Be More Swan workspace. To use it, you must join the existing workspace or disconnect it from the other account.`,
                        code: 'TENANT_COLLISION',
                    }) };
                }
            }

            const scopeString = Array.isArray(scopes) && scopes.length ? scopes.join(' ') : null;
            const refKey = buildRefKey(currentUserId, serviceName, 'apikey');
            await storeSecret(db, refKey, { token: apiKey });

            if (existing.length > 0) {
                // Delete old vault entry if the key changed
                if (existing[0].vaultRefKey && existing[0].vaultRefKey !== refKey) {
                    await deleteSecret(db, existing[0].vaultRefKey).catch(() => {});
                }
                await db.update(systemConnections)
                    .set({
                        vaultRefKey: refKey,
                        externalUserId: handle || null,
                        scopes: scopeString,
                        metadata: pageUrl ? { pageUrl } : null,
                        status: 'active',
                        isActive: true,
                        updatedAt: new Date(),
                    })
                    .where(eq(systemConnections.id, existing[0].id));
            } else {
                if (!currentOrgId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found for this account.' }) };
                await db.insert(systemConnections).values({
                    userId: currentUserId,
                    organisationId: currentOrgId,
                    serviceName,
                    connectionType,
                    vaultRefKey: refKey,
                    externalUserId: handle || null,
                    scopes: scopeString,
                    metadata: pageUrl ? { pageUrl } : null,
                    status: 'active',
                    isActive: true,
                });
            }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // --- DELETE: SECURE DATA PURGE ---
        if (event.httpMethod === 'DELETE') {
            const connectionId = event.queryStringParameters?.id;
            if (!connectionId) return { statusCode: 400, body: JSON.stringify({ error: 'Connection ID required.' }) };
            const connIdInt = parseInt(connectionId);

            // Fetch vaultRefKey + serviceName before deleting
            const [conn] = await db
                .select({
                    vaultRefKey: systemConnections.vaultRefKey,
                    serviceName: systemConnections.serviceName,
                    organisationId: systemConnections.organisationId,
                })
                .from(systemConnections)
                .where(and(
                    eq(systemConnections.id, connIdInt),
                    eq(systemConnections.userId, currentUserId),
                ))
                .limit(1);

            // US-SMM-3.2.2: Mark disconnected rather than hard-delete, pause scheduled posts
            await db.update(systemConnections).set({ status: 'disconnected', isActive: false, updatedAt: new Date() })
                .where(and(eq(systemConnections.id, connIdInt), eq(systemConnections.userId, currentUserId)));

            // US-SMM-4.1.2: Remote token revocation — fire-and-forget; vault purge follows regardless
            if (conn?.vaultRefKey) {
                const { getSecret } = await import('../../src/utils/vault');
                const secret = await getSecret(db, conn.vaultRefKey).catch(() => null);
                const token = (secret as { token?: string } | null)?.token;
                if (token) {
                    const svc = conn.serviceName?.toLowerCase() ?? '';
                    if (svc === 'instagram' || svc === 'facebook') {
                        // Meta: DELETE /{user-id}/permissions revokes all grants
                        const metaSecret = process.env.META_APP_SECRET;
                        const metaAppId  = process.env.META_APP_ID;
                        if (metaSecret && metaAppId) {
                            fetch(`https://graph.facebook.com/v19.0/me/permissions?access_token=${token}`, { method: 'DELETE' }).catch(() => {});
                        }
                    } else if (svc === 'linkedin') {
                        const clientId     = process.env.LINKEDIN_CLIENT_ID;
                        const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
                        if (clientId && clientSecret) {
                            fetch('https://www.linkedin.com/oauth/v2/revoke', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                                body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token }),
                            }).catch(() => {});
                        }
                    } else if (svc === 'x') {
                        const clientId     = process.env.X_CLIENT_ID;
                        const clientSecret = process.env.X_CLIENT_SECRET;
                        if (clientId && clientSecret) {
                            const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
                            fetch('https://api.twitter.com/2/oauth2/revoke', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
                                body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
                            }).catch(() => {});
                        }
                    }
                }
                await deleteSecret(db, conn.vaultRefKey).catch(() => {});
            }

            // Cancel scheduled posts linked to this connection (AC1.2.2)
            let cancelledCount = 0;
            const svcForPost = conn?.serviceName?.toLowerCase() ?? '';
            if (svcForPost === 'instagram' || svcForPost === 'facebook' || svcForPost === 'linkedin' || svcForPost === 'x') {
                const result = await db.update(scheduledPosts)
                    .set({ status: 'cancelled', cancelledAt: new Date(), rejectionReason: 'oauth_revoked', updatedAt: new Date() })
                    .where(and(
                        eq(scheduledPosts.connectionId, connIdInt),
                        eq(scheduledPosts.status, 'scheduled'),
                    ));
                cancelledCount = (result as any).count ?? 0;
            }

            // Notification for all social platforms
            const platformLabel: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', x: 'X (Twitter)' };
            const label = platformLabel[svcForPost] ?? conn?.serviceName ?? 'Platform';
            await db.insert(notifications).values({
                userId: currentUserId,
                type: 'social_oauth_revoked',
                title: `${label} disconnected`,
                message: cancelledCount > 0
                    ? `${label} disconnected. ${cancelledCount} scheduled post${cancelledCount !== 1 ? 's have' : ' has'} been cancelled. Reconnect to resume publishing.`
                    : `${label} disconnected successfully.`,
                metadata: { connectionId: connIdInt, platform: svcForPost, cancelledCount },
            });

            // Audit log (AC1.2.2)
            await db.insert(auditLogs).values({
                actionType: 'social_oauth_revoked',
                resourceType: 'system_connections',
                resourceId: String(connIdInt),
                newState: { userId: currentUserId, orgId: conn?.organisationId, platform: svcForPost, disconnectedAt: new Date().toISOString() },
            });

            return { statusCode: 200, body: JSON.stringify({ success: true, cancelledCount }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (error) {
        console.error('Integrations API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};