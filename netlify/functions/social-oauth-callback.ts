// netlify/functions/social-oauth-callback.ts
// US-SMM-4.1.1: OAuth 2.0 callback/token exchange for LinkedIn and X (Twitter).
// GET ?code=...&state=...   — the platform rides in `state` (see social-oauth-init.ts).
// AC1.1.2: CSRF verified against server-side vault entry with 10-minute TTL.

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { systemConnections, auditLogs, users, userOrganisations } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { storeSecret, getSecret, deleteSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { restoreConnectionDependents } from '../../src/utils/connection-recovery';
import { findTenantCollision, recordCollisionAttempt } from '../../src/utils/connection-collision';
import { X_OAUTH_SCOPES } from '../../src/config/x-scopes';
import { withLambda } from '@netlify/aws-lambda-compat';

function parseState(raw: string): Record<string, string> | null {
    try { return JSON.parse(Buffer.from(raw, 'base64url').toString()); }
    catch { return null; }
}

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: 'Server misconfigured.' };
    const { code, state: rawState, error } = event.queryStringParameters ?? {};

    // The platform now travels in `state`, so the redirect_uri stays free of query parameters —
    // LinkedIn and X both match the registered callback as an exact string. The query-param form
    // is still honoured so any authorization already in flight (or an older registered callback
    // URL) completes rather than dead-ending.
    const platform = parseState(rawState ?? '')?.platform ?? event.queryStringParameters?.platform;

    if (error) {
        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=access_denied&platform=${platform}` }, body: '' };
    }
    if (!code || !rawState || !platform) {
        return { statusCode: 400, body: 'Missing required parameters' };
    }

    const state = parseState(rawState);
    if (!state || !state.userId || !state.csrf) {
        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=csrf_fail&platform=${platform}` }, body: '' };
    }

    const userId = parseInt(state.userId);
    const db = getDb();

    // AC1.1.2: verify CSRF against server-side vault entry and enforce 10-minute TTL
    const csrfKey = `oauth_csrf:${userId}:${platform}`;
    const storedState = await getSecret(db, csrfKey).catch(() => null) as { csrf?: string; expiresAt?: number; organisationId?: string; codeVerifier?: string; assistantId?: string } | null;
    await deleteSecret(db, csrfKey).catch(() => {}); // consume regardless — one-time use

    if (!storedState || storedState.csrf !== state.csrf || !storedState.expiresAt || Date.now() > storedState.expiresAt) {
        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=csrf_fail&platform=${platform}` }, body: '' };
    }

    const organisationId = parseInt(storedState.organisationId ?? '0');
    const assistantId = storedState.assistantId ? parseInt(storedState.assistantId) : null;

    // Connection sandboxing: if connecting for a specific assistant, this platform
    // must be relevant to that assistant's role.
    if (assistantId) {
        const assistant = await resolveAssistantRole(db, organisationId, assistantId);
        if (!assistant || !isServiceAllowedForAssistant(platform, assistant)) {
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=connection_not_relevant&platform=${platform}` }, body: '' };
        }
    }

    // Must be byte-identical to the redirect_uri sent at authorize time, or the token exchange is
    // rejected. If this request arrived on the legacy query-param URL, echo that form back.
    const callbackUri = event.queryStringParameters?.platform
        ? `${baseUrl}/.netlify/functions/social-oauth-callback?platform=${platform}`
        : `${baseUrl}/.netlify/functions/social-oauth-callback`;

    // ── LinkedIn ──────────────────────────────────────────────────────────────
    if (platform === 'linkedin') {
        const clientId     = process.env.LINKEDIN_CLIENT_ID!;
        const clientSecret = process.env.LINKEDIN_CLIENT_SECRET!;

        const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUri, client_id: clientId, client_secret: clientSecret }),
        });
        const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string } = await tokenRes.json();
        if (!tokenData.access_token) {
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=token_exchange&platform=linkedin` }, body: '' };
        }

        // Identify the member. /v2/me needs r_liteprofile (a legacy scope the app is not approved
        // for); under OpenID Connect the member id is `sub` from /v2/userinfo. This mirrors
        // resolveLinkedInAuthor() in social-publish.ts, which builds urn:li:person:<sub>.
        const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const profile: { sub?: string; name?: string; email?: string } = await profileRes.json();
        const linkedinId = profile.sub;
        if (!linkedinId) {
            console.error('[social-oauth-callback] LinkedIn /v2/userinfo returned no sub');
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=token_exchange&platform=linkedin` }, body: '' };
        }

        // US1 AC1.3: reject if this LinkedIn tenant is already live in another workspace (before storing the token).
        // PARKED by default — see src/utils/connection-collision.ts (ENFORCE_TENANT_COLLISION).
        const linkedinCollision = await findTenantCollision(db, { serviceName: 'linkedin', externalUserId: linkedinId, organisationId });
        if (linkedinCollision) {
            await recordCollisionAttempt(db, { requestingOrgId: organisationId, existingOrgId: linkedinCollision.organisationId, serviceName: 'linkedin', externalUserId: linkedinId });
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=tenant_collision&platform=linkedin` }, body: '' };
        }

        const refKey = `aura/org-${organisationId}/linkedin-token`;
        // Store the refresh token (when granted) so refresh-social-tokens.ts can renew silently.
        await storeSecret(db, refKey, { token: tokenData.access_token, refreshToken: tokenData.refresh_token ?? null });

        const tokenExpiresAt = tokenData.expires_in
            ? new Date(Date.now() + tokenData.expires_in * 1000)
            : null;

        const [existing] = await db.select({ id: systemConnections.id })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'linkedin')))
            .limit(1);

        const scopes = 'openid profile email w_member_social'; // keep in step with social-oauth-init.ts
        if (existing) {
            await db.update(systemConnections).set({ vaultRefKey: refKey, externalUserId: linkedinId, tokenExpiresAt, status: 'active', isActive: true, scopes, ...(assistantId ? { assistantId } : {}), updatedAt: new Date() }).where(eq(systemConnections.id, existing.id));
        } else {
            await db.insert(systemConnections).values({ organisationId, userId, assistantId, serviceName: 'linkedin', connectionType: 'oauth', vaultRefKey: refKey, externalUserId: linkedinId, tokenExpiresAt, status: 'active', isActive: true, scopes });
        }

        await createNotification(db, existing ? 'linkedin_reconnected' : 'linkedin_connected', { userId, metadata: assistantId ? { assistantId } : null });
        // Connection is live again — un-pause the posts and assistants the failure halted, and clear
        // any open "reconnect" action items. Must run AFTER the status='active' write above: the
        // assistant-resume guard reads current connection statuses.
        if (existing) {
            await restoreConnectionDependents(db, {
                connectionId: existing.id,
                organisationId,
                assistantId,
                serviceName: 'linkedin',
                userId,
            });
        } else {
            await resolveActionNotifications(db, userId, CONNECTION_RESTORED_TYPES);
        }
        await db.insert(auditLogs).values({ actionType: existing ? 'linkedin_reconnected' : 'linkedin_connected', resourceType: 'system_connections', resourceId: linkedinId, newState: { organisationId } });

        // Trigger pre-flight audit
        fetch(`${baseUrl}/.netlify/functions/social-preflight-audit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organisationId, platform: 'linkedin' }),
        }).catch(() => {});

        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_success=linkedin${assistantId ? `&assistantId=${assistantId}` : ''}` }, body: '' };
    }

    // ── X (Twitter) ───────────────────────────────────────────────────────────
    if (platform === 'x') {
        const clientId     = process.env.X_CLIENT_ID!;
        const clientSecret = process.env.X_CLIENT_SECRET!;
        const codeVerifier = storedState.codeVerifier; // AC1.1.2: retrieved from server-side vault

        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
            body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUri, code_verifier: codeVerifier ?? '' }),
        });
        const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } = await tokenRes.json();
        if (!tokenData.access_token) {
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=token_exchange&platform=x` }, body: '' };
        }

        const meRes = await fetch('https://api.twitter.com/2/users/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const meData: { data?: { id: string; username: string } } = await meRes.json();
        const xUserId = meData.data?.id ?? 'unknown';
        const xUsername = meData.data?.username ?? '';

        // US1 AC1.3: reject if this X tenant is already live in another workspace (before storing the token).
        // PARKED by default — see src/utils/connection-collision.ts (ENFORCE_TENANT_COLLISION).
        // Keyed on the stable user id (matches externalUserId = xUsername || xUserId).
        const xCollision = await findTenantCollision(db, { serviceName: 'x', externalUserId: xUsername || xUserId, organisationId });
        if (xCollision) {
            await recordCollisionAttempt(db, { requestingOrgId: organisationId, existingOrgId: xCollision.organisationId, serviceName: 'x', externalUserId: xUsername || xUserId });
            return { statusCode: 302, headers: { Location: `/workspace.html?oauth_error=tenant_collision&platform=x` }, body: '' };
        }

        const refKey = `aura/org-${organisationId}/x-token`;
        await storeSecret(db, refKey, { token: tokenData.access_token, refreshToken: tokenData.refresh_token ?? null });

        const tokenExpiresAt = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;

        const [existing] = await db.select({ id: systemConnections.id })
            .from(systemConnections)
            .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'x')))
            .limit(1);

        // What we RECORD as granted. Both this and the authorize URL now read one constant, so the
        // recorded grant cannot drift from the requested one.
        const scopes = X_OAUTH_SCOPES;
        if (existing) {
            await db.update(systemConnections).set({ vaultRefKey: refKey, externalUserId: xUsername || xUserId, tokenExpiresAt, status: 'active', isActive: true, scopes, ...(assistantId ? { assistantId } : {}), updatedAt: new Date() }).where(eq(systemConnections.id, existing.id));
        } else {
            await db.insert(systemConnections).values({ organisationId, userId, assistantId, serviceName: 'x', connectionType: 'oauth', vaultRefKey: refKey, externalUserId: xUsername || xUserId, tokenExpiresAt, status: 'active', isActive: true, scopes });
        }

        await createNotification(db, existing ? 'x_reconnected' : 'x_connected', { userId, metadata: assistantId ? { assistantId } : null });
        // Same as the LinkedIn branch above — this path had no cleanup at all, not even the
        // notification resolve, so a reconnected X account left its "Reconnect X" card open too.
        if (existing) {
            await restoreConnectionDependents(db, {
                connectionId: existing.id,
                organisationId,
                assistantId,
                serviceName: 'x',
                userId,
            });
        }
        await db.insert(auditLogs).values({ actionType: existing ? 'x_reconnected' : 'x_connected', resourceType: 'system_connections', resourceId: xUserId, newState: { organisationId, username: xUsername } });

        return { statusCode: 302, headers: { Location: `/workspace.html?oauth_success=x${assistantId ? `&assistantId=${assistantId}` : ''}` }, body: '' };
    }

    return { statusCode: 400, body: 'Unknown platform' };
});
