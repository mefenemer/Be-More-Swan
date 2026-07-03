// netlify/functions/meta-oauth.ts
// US-SMM-3.2.1: Meta OAuth flow for Instagram Business/Creator accounts.
// GET ?action=start  — redirects to Meta OAuth dialog
// GET ?action=callback — exchanges code, validates, stores token in vault, upserts system_connections

import { Handler } from '@netlify/functions';
import { eq, and } from 'drizzle-orm';
import { createHmac, randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { systemConnections, notifications, users, auditLogs, userOrganisations } from '../../db/schema';
import { storeSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';
import { resolveActionNotifications, CONNECTION_RESTORED_TYPES } from '../../src/utils/notification-actions';
import { findTenantCollision, recordCollisionAttempt } from '../../src/utils/connection-collision';
import { requireTenant } from '../../src/utils/tenant';

const jwtSecret   = process.env.JWT_SECRET!;
const metaAppId   = process.env.META_APP_ID!;
const metaSecret  = process.env.META_APP_SECRET!;
const SCOPES      = 'instagram_basic,instagram_content_publish,pages_read_engagement,pages_manage_metadata,pages_messaging,pages_manage_posts';
const TOKEN_TTL_DAYS = 60;

function csrfToken(): string {
    return randomBytes(32).toString('hex');
}

function signState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseState(state: string): Record<string, string> | null {
    try {
        return JSON.parse(Buffer.from(state, 'base64url').toString());
    } catch { return null; }
}

function validateStateCsrf(state: Record<string, string>, stored: string): boolean {
    return createHmac('sha256', jwtSecret).update(state.csrf ?? '').digest('hex') === stored;
}

export const handler: Handler = async (event) => {
    const action = event.queryStringParameters?.action;

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    const REDIRECT_URI = process.env.META_REDIRECT_URI ?? `${baseUrl}/.netlify/functions/meta-oauth?action=callback`;

    // ── START: redirect to Meta OAuth ─────────────────────────────────────────
    if (action === 'start') {
        // Session carries `activeOrganisationId`, not `organisationId` — resolve via requireTenant
        // (re-verifies current membership) rather than reading the JWT claim directly.
        const ctx = await requireTenant(event, getDb());
        if ('error' in ctx) return ctx.error;
        const { organisationId } = ctx;

        const assistantId = event.queryStringParameters?.assistantId;
        const csrf = csrfToken();
        const csrfHmac = createHmac('sha256', jwtSecret).update(csrf).digest('hex');
        const state = signState({ organisationId: String(organisationId), assistantId: assistantId ?? '', csrf, csrfHmac });

        const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=${metaAppId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${SCOPES}&state=${state}&response_type=code`;

        return { statusCode: 302, headers: { Location: url }, body: '' };
    }

    // ── CALLBACK: exchange code, validate, store ───────────────────────────────
    if (action === 'callback') {
        const { code, state: rawState, error } = event.queryStringParameters ?? {};

        if (error) {
            return { statusCode: 302, headers: { Location: '/workspace.html?meta_error=access_denied' }, body: '' };
        }
        if (!code || !rawState) {
            return { statusCode: 400, body: 'Missing code or state' };
        }

        const state = parseState(rawState);
        if (!state) return { statusCode: 400, body: 'Invalid state parameter' };

        // Validate CSRF
        const expectedHmac = createHmac('sha256', jwtSecret).update(state.csrf ?? '').digest('hex');
        if (expectedHmac !== state.csrfHmac) {
            await getDb().insert(auditLogs).values({ actionType: 'meta_oauth_csrf_fail', resourceType: 'system_connections', resourceId: 'csrf', newState: { state } });
            return { statusCode: 400, body: JSON.stringify({ error: 'Security error: invalid state. Flow aborted.' }) };
        }

        const organisationId = parseInt(state.organisationId);
        const assistantId   = state.assistantId ? parseInt(state.assistantId) : null;

        // Connection sandboxing: if this connect was initiated for a specific
        // assistant, Instagram must be relevant to that assistant's role.
        if (assistantId) {
            const assistant = await resolveAssistantRole(getDb(), organisationId, assistantId);
            if (!assistant || !isServiceAllowedForAssistant('instagram', assistant)) {
                return { statusCode: 302, headers: { Location: '/workspace.html?meta_error=connection_not_relevant' }, body: '' };
            }
        }

        // Exchange short-lived code for long-lived token
        const tokenRes = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?client_id=${metaAppId}&client_secret=${metaSecret}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code=${code}`
        );
        const tokenData: { access_token?: string; error?: { message: string } } = await tokenRes.json();
        if (!tokenData.access_token) {
            return { statusCode: 400, body: JSON.stringify({ error: tokenData.error?.message ?? 'Token exchange failed' }) };
        }

        // Exchange for 60-day long-lived token
        const llRes = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${metaAppId}&client_secret=${metaSecret}&fb_exchange_token=${tokenData.access_token}`
        );
        const llData: { access_token?: string; expires_in?: number; error?: { message: string } } = await llRes.json();
        if (!llData.access_token) {
            return { statusCode: 400, body: JSON.stringify({ error: llData.error?.message ?? 'Long-lived token exchange failed' }) };
        }
        const longLivedToken = llData.access_token;

        // Fetch Instagram account info
        const meRes = await fetch(
            `https://graph.facebook.com/v19.0/me?fields=id,name,account_type,instagram_business_account,accounts&access_token=${longLivedToken}`
        );
        const me: {
            id?: string; name?: string; account_type?: string;
            instagram_business_account?: { id: string };
            accounts?: { data: Array<{ id: string; name: string }> };
            error?: { message: string };
        } = await meRes.json();

        const igAccount = me.instagram_business_account;
        if (!igAccount) {
            return {
                statusCode: 302,
                headers: { Location: '/workspace.html?meta_error=not_business' },
                body: '',
            };
        }

        // Validate account type (must be BUSINESS or CREATOR)
        const accountType = me.account_type ?? '';
        if (!['BUSINESS', 'CREATOR'].includes(accountType.toUpperCase())) {
            return {
                statusCode: 302,
                headers: { Location: '/workspace.html?meta_error=personal_account' },
                body: '',
            };
        }

        const igUserId = igAccount.id;
        const fbPageId = me.accounts?.data?.[0]?.id ?? null;

        const db = getDb();

        // US1 AC1.3: block if this Instagram tenant is already live in a different workspace.
        // Checked before any token is persisted, so nothing is stored on rejection.
        const collision = await findTenantCollision(db, { serviceName: 'instagram', externalUserId: igUserId, organisationId });
        if (collision) {
            await recordCollisionAttempt(db, { requestingOrgId: organisationId, existingOrgId: collision.organisationId, serviceName: 'instagram', externalUserId: igUserId });
            return { statusCode: 302, headers: { Location: '/workspace.html?meta_error=tenant_collision&platform=instagram' }, body: '' };
        }

        // Store token in vault
        const refKey = `aura/org-${organisationId}/instagram-token`;
        await storeSecret(db, refKey, { token: longLivedToken });

        const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

        // Upsert system_connections — update existing if same instagramAccountId, else create
        const [existing] = await db
            .select({ id: systemConnections.id })
            .from(systemConnections)
            .where(and(
                eq(systemConnections.organisationId, organisationId),
                eq(systemConnections.serviceName, 'instagram'),
                eq(systemConnections.externalUserId, igUserId),
            ))
            .limit(1);

        let isReconnect = false;
        if (existing) {
            isReconnect = true;
            await db.update(systemConnections).set({
                vaultRefKey: refKey,
                tokenExpiresAt,
                status: 'active',
                isActive: true,
                metadata: { accountType, fbPageId },
                ...(assistantId ? { assistantId } : {}),
                updatedAt: new Date(),
            }).where(eq(systemConnections.id, existing.id));
        } else {
            await db.insert(systemConnections).values({
                organisationId,
                assistantId,
                serviceName: 'instagram',
                connectionType: 'oauth',
                externalUserId: igUserId,
                vaultRefKey: refKey,
                tokenExpiresAt,
                status: 'active',
                isActive: true,
                scopes: SCOPES,
                metadata: { accountType, fbPageId },
            });
        }

        // Find userId from org (use first active user for notification)
        const [orgUser] = await db.select({ id: users.id }).from(users).innerJoin(userOrganisations, eq(users.id, userOrganisations.userId)).where(eq(userOrganisations.organisationId, organisationId)).limit(1);
        if (orgUser) {
            await db.insert(notifications).values({
                userId: orgUser.id,
                type: 'instagram_connected',
                title: isReconnect ? 'Instagram reconnected' : 'Instagram connected',
                message: isReconnect
                    ? `Instagram account connected successfully. Token refreshed.`
                    : `Instagram account connected successfully. You can now schedule and publish posts.${!fbPageId ? ' Note: No Facebook Page linked — some features may be limited.' : ''}`,
                metadata: { igUserId, accountType, fbPageId },
            });
            // Connection is live again — clear any open "reconnect Instagram" action items.
            await resolveActionNotifications(db, orgUser.id, CONNECTION_RESTORED_TYPES);
        }

        await db.insert(auditLogs).values({ actionType: isReconnect ? 'instagram_reconnected' : 'instagram_connected', resourceType: 'system_connections', resourceId: igUserId, newState: { organisationId, accountType, fbPageId } });

        // US-SMM-4.2.2: trigger profile sync fire-and-forget after successful OAuth
        fetch(`${baseUrl}/.netlify/functions/social-profile-sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organisationId }),
        }).catch(() => {});

        // US-SMM-4.3.1: trigger pre-flight audit fire-and-forget after successful OAuth
        fetch(`${baseUrl}/.netlify/functions/social-preflight-audit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organisationId, platform: 'instagram' }),
        }).catch(() => {});

        return {
            statusCode: 302,
            headers: { Location: `/workspace.html?oauth_success=instagram${assistantId ? `&assistantId=${assistantId}` : ''}` },
            body: '',
        };
    }

    return { statusCode: 400, body: 'Unknown action' };
};
