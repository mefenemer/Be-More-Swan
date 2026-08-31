import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, and, or, isNull, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, scheduledPosts, users, userOrganisations, auditLogs, workspaceIntegrations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { storeSecret, deleteSecret, buildRefKey } from '../../src/utils/vault';
import { deleteIntegration, getIntegration, isIntegrationProvider, serviceAutoRefreshes } from '../../src/utils/workspace-integrations';
import { isServiceAllowedForAssistant, allowedServiceNames, relevantConnectorsForAssistant, supportedToolsForAssistant, usesOutreachMailbox, MAILBOX_PROVIDERS, usesSearchConsole, SEARCH_CONSOLE_PROVIDER } from '../../src/utils/connection-map';
import { getXUsage } from '../../src/utils/ai-credits';
import { resolveAssistantRole } from '../../src/utils/assistant-role';
import { findTenantCollision, recordCollisionAttempt } from '../../src/utils/connection-collision';
import { X_OAUTH_SCOPE_LIST } from '../../src/config/x-scopes';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;

export default withLambda(async (event) => {
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

            // Org-scoped, because `user_id IS NULL` never actually meant "global platform
            // definition": organisation_id is NOT NULL (US-DB-1.3.1), so every such row belongs to
            // a real workspace. Unscoped, this returned every other tenant's unattributed
            // connections — service name, external account id and metadata (a Facebook Page id and
            // name, an Instagram username) — to any signed-in user. Tokens were never exposed;
            // safeColumns has always withheld vaultRefKey. The cards themselves come from the
            // client's own PROVIDERS list, so nothing renders differently for a legitimate caller.
            const systemCatalog = currentOrgId
                ? await db.select(safeColumns).from(systemConnections).where(and(
                    isNull(systemConnections.userId),
                    eq(systemConnections.organisationId, currentOrgId),
                ))
                : [];

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

            // Some connectors authenticate through the org-scoped workspace_integrations store
            // (src/utils/workspace-integrations.ts) rather than system_connections, so their real
            // status must be merged in separately. Without this, system_connections never has a
            // row for them, the card always renders "Not connected", and the user can re-trigger
            // the OAuth flow even when the org's account is already linked (silently swapping
            // which account is connected).
            //
            //   canva   — inbound design source (_sourceCard)
            //   threads — social platform whose token lives here rather than in system_connections
            //   youtube — ditto (video-only; manual upload, never autonomously drafted)
            //             see resolveSocialCredentials; the publish path bridges the two stores.
            //
            // A row that ALREADY exists in system_connections wins — for Threads that is the
            // per-assistant shadow row, which carries the toggle state the UI needs.
            if (currentOrgId) {
                const WORKSPACE_BACKED = ['canva', 'threads', 'youtube'] as const;
                const rows = await db.select({
                    id: workspaceIntegrations.id,
                    provider: workspaceIntegrations.provider,
                    status: workspaceIntegrations.status,
                    externalAccountName: workspaceIntegrations.externalAccountName,
                    scopes: workspaceIntegrations.scopes,
                    expiresAt: workspaceIntegrations.expiresAt,
                    createdAt: workspaceIntegrations.createdAt,
                    updatedAt: workspaceIntegrations.updatedAt,
                }).from(workspaceIntegrations).where(and(
                    eq(workspaceIntegrations.organisationId, currentOrgId),
                    inArray(workspaceIntegrations.provider, [...WORKSPACE_BACKED]),
                ));
                for (const row of rows) {
                    const existing = merged.find(m => m.serviceName === row.provider);
                    if (existing) {
                        // Shadow row present: keep its id/toggle state, but take the live
                        // connection status from the store that actually holds the token.
                        existing.connected = true;
                        existing.status = row.status;
                        existing.externalUserId = existing.externalUserId || row.externalAccountName;
                        existing.tokenExpiresAt = row.expiresAt;
                        continue;
                    }
                    // Shape matches safeColumns + connected exactly (same fields `merged`'s other
                    // entries carry) — externalAccountName rides in externalUserId, which
                    // _sourceCard's account chip already falls back to when the dedicated field
                    // is absent.
                    merged.push({
                        // Negative id marks this as a workspace_integrations row rather than a
                        // system_connections one — the two tables have independent id sequences,
                        // so a positive id here could collide with an unrelated row. The DELETE
                        // handler below reverses this to route disconnects to the right table.
                        id: -row.id,
                        serviceName: row.provider,
                        connectionType: 'oauth',
                        externalUserId: row.externalAccountName,
                        scopes: row.scopes,
                        status: row.status,
                        isActive: row.status === 'active',
                        metadata: null,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        tokenExpiresAt: row.expiresAt,
                        connected: true,
                    });
                }
            }

            // Flag connections that renew their access token silently, so the UI can suppress
            // the "Expiring in Nd" reconnect nag for them. Covers the workspace_integrations
            // providers that hold an offline refresh token (serviceAutoRefreshes) plus the
            // system_connections tokens rotated by a cron.
            //
            // Every serviceName a refresh cron actually SELECTS belongs here, or the card nags the
            // user to reconnect something the platform is already renewing on its own:
            //   x, linkedin           → refresh-social-tokens.ts (every 30 min)
            //   facebook, instagram   → refresh-meta-tokens.ts   (nightly, 14 days before expiry)
            // The Meta pair was missing, so a healthy Facebook/Instagram connection started showing
            // "Expiring in 7d…1d" for the last week of every 60-day window and then "Disconnected"
            // — while the nightly cron was quietly extending it the whole time.
            //
            // Safe against masking a genuinely dead connection: _connHealth (integrations.js) tests
            // isConnectionDead(status) BEFORE it looks at autoRefresh, and both crons write a dead
            // status ('token_refresh_failed') when a renewal actually fails.
            const CRON_REFRESHED = new Set(['x', 'linkedin', 'facebook', 'instagram']);
            for (const m of merged) {
                (m as typeof m & { autoRefresh: boolean }).autoRefresh =
                    serviceAutoRefreshes(m.serviceName) || CRON_REFRESHED.has(m.serviceName);
            }

            // X posting usage for the monthly-allowance gauge on the X connection card (Phase 1).
            // Defensive: never let the gauge lookup break the connections page — e.g. before the
            // db/x-post-credits.sql migration has run, its columns don't exist. Degrade to no gauge.
            let xCredits: { used: number; allowance: number; remaining: number } | null = null;
            try {
                if (currentOrgId) xCredits = await getXUsage(db, currentOrgId);
            } catch (e) {
                console.warn('[integrations] X usage lookup failed (migration pending?):', (e as Error).message);
            }

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
                // Supported external tools for this role — includes categories that
                // have no live connector yet (available: false → "coming soon") so the
                // Connections grid and onboarding summary can show what the assistant
                // supports, not just what already has a connector.
                const supportedTools = supportedToolsForAssistant(assistant);
                // Mailbox connectors (Gmail / Outlook) for the roles that send outreach from the
                // user's own inbox. They live in workspace_integrations, so they are invisible to
                // the `merged` system_connections list above and need their own lookup — without
                // this the Connections grid showed "Email — Coming soon" over a mailbox that was
                // already connected and sending. Same status rule as /api/oauth/status.
                const mailboxProviders = usesOutreachMailbox(assistant) && currentOrgId
                    ? await Promise.all(MAILBOX_PROVIDERS.map(async (provider) => {
                        const row = await getIntegration(db, currentOrgId, provider);
                        return {
                            provider,
                            connected: row?.status === 'active',
                            status: row?.status ?? null,
                            accountName: row?.externalAccountName ?? null,
                        };
                    }))
                    : [];
                // Google Search Console, for the roles whose policy includes it. Same story as the
                // mailboxes above: the grant lives in workspace_integrations, so it is invisible to
                // the system_connections list and needs its own lookup — without it the Connections
                // grid said "Search Console — Coming soon" over a live, connectable integration that
                // Blog Studio was already offering a Connect button for.
                const searchConsole = usesSearchConsole(assistant) && currentOrgId
                    ? await (async () => {
                        const row = await getIntegration(db, currentOrgId, SEARCH_CONSOLE_PROVIDER as never);
                        return {
                            provider: SEARCH_CONSOLE_PROVIDER,
                            connected: row?.status === 'active',
                            status: row?.status ?? null,
                            accountName: row?.externalAccountName ?? null,
                        };
                    })()
                    : null;
                return { statusCode: 200, body: JSON.stringify({ connections: visible, allowedServices, supportedTools, mailboxProviders, searchConsole, xCredits }) };
            }

            return { statusCode: 200, body: JSON.stringify({ connections: merged, xCredits }) };
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
            //
            // ⚠️ This list governs the MANUAL connection path only (POST here with a token +
            // declared scopes). The Meta OAuth flow writes its rows in meta-oauth.ts and never
            // passes through this guard, so the two lists can drift silently — they have before.
            // A scope belongs here only if we both REQUEST it (meta-oauth.ts SCOPES) and have a
            // capability that uses it. Listing anything else is the over-privilege this exists
            // to stop.
            const ALLOWED_SCOPES: Record<string, string[]> = {
                // pages_messaging is correct here: Messenger send is a Page-level permission and
                // it IS in the Meta grant (meta-oauth.ts SCOPES).
                facebook:      ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'publish_to_groups', 'pages_manage_metadata', 'pages_messaging'],
                // pages_messaging deliberately NOT listed for Instagram. It is a Facebook Page
                // permission and does not authorise Instagram DMs — that needs
                // instagram_manage_messages, which we neither request nor have a capability for.
                // Listing it implied a DM capability the grant never conferred. Do not re-add it
                // without both the scope in meta-oauth.ts AND a send path that uses it.
                instagram:     ['instagram_basic', 'instagram_content_publish', 'instagram_manage_insights', 'pages_manage_metadata', 'pages_manage_posts'],
                linkedin:      ['r_liteprofile', 'r_emailaddress', 'w_member_social', 'r_organization_social', 'w_organization_social'],
                twitter:       [...X_OAUTH_SCOPE_LIST],
                google:        ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets'],
                openai:        [],  // API key — no scope concept
                notion:        ['read_content', 'update_content', 'insert_content'],
                hubspot:       ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
                slack:         ['channels:read', 'chat:write', 'files:write'],
            };

            // Canonical form. service_name is persisted lowercase everywhere (the OAuth callbacks
            // write literals like 'instagram'), and every consumer — publish-instagram,
            // publish-social-posts, findTenantCollision — matches on a lowercase literal. A raw
            // "Instagram" from this generic path would be invisible to all of them.
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
                    eq(systemConnections.serviceName, serviceKey),
                    ...(currentOrgId ? [eq(systemConnections.organisationId, currentOrgId)] : []),
                ))
                .limit(1);

            // US1 AC1.3: block if this account/handle is already live in another workspace.
            if (handle && currentOrgId) {
                const collision = await findTenantCollision(db, { serviceName: serviceKey, externalUserId: handle, organisationId: currentOrgId });
                if (collision) {
                    await recordCollisionAttempt(db, { requestingOrgId: currentOrgId, existingOrgId: collision.organisationId, serviceName: serviceKey, externalUserId: handle });
                    return { statusCode: 409, body: JSON.stringify({
                        error: `This ${serviceName} account is already connected to another Be More Swan workspace. To use it, you must join the existing workspace or disconnect it from the other account.`,
                        code: 'TENANT_COLLISION',
                    }) };
                }
            }

            const scopeString = Array.isArray(scopes) && scopes.length ? scopes.join(' ') : null;
            const refKey = buildRefKey(currentUserId, serviceKey, 'apikey');
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
                    serviceName: serviceKey,
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

            // Negative id → a workspace_integrations row (e.g. Canva), synthesised by GET
            // above. It lives in a different table with its own id sequence, so it needs its
            // own disconnect path rather than falling through to the system_connections delete.
            if (connIdInt < 0) {
                if (!currentOrgId) return { statusCode: 400, body: JSON.stringify({ error: 'No organisation found for this account.' }) };
                const [row] = await db.select({ provider: workspaceIntegrations.provider })
                    .from(workspaceIntegrations)
                    .where(and(eq(workspaceIntegrations.id, -connIdInt), eq(workspaceIntegrations.organisationId, currentOrgId)))
                    .limit(1);
                if (!row || !isIntegrationProvider(row.provider)) return { statusCode: 404, body: JSON.stringify({ error: 'Connection not found.' }) };
                await deleteIntegration(db, currentOrgId, row.provider);
                return { statusCode: 200, body: JSON.stringify({ success: true }) };
            }

            // Fetch vaultRefKey + serviceName before deleting
            const [conn] = await db
                .select({
                    vaultRefKey: systemConnections.vaultRefKey,
                    serviceName: systemConnections.serviceName,
                    organisationId: systemConnections.organisationId,
                    assistantId: systemConnections.assistantId,
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
            await createNotification(db, cancelledCount > 0 ? 'social_disconnected_posts_cancelled' : 'social_disconnected', {
                userId: currentUserId,
                context: { platform: { label }, cancelled: { post_count: `${cancelledCount} scheduled post${cancelledCount !== 1 ? 's have' : ' has'}` } },
                metadata: { connectionId: connIdInt, platform: svcForPost, cancelledCount, assistantId: conn?.assistantId ?? null },
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
});