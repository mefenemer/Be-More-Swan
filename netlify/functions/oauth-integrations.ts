// netlify/functions/oauth-integrations.ts
// Phase 1 External Integrations: universal OAuth 2.0 router for HubSpot, Xero and Slack.
//
// Routed via netlify.toml rewrites so the public URLs are:
//   GET  /api/oauth/:provider/connect    → 302 to the provider's authorization URL
//   GET  /api/oauth/:provider/callback   → code→token exchange, saveIntegration, → integrations.html
//   GET  /api/oauth/status               → per-provider connection state for integrations.html
//   POST /api/oauth/:provider/disconnect → delete row + vault secret
//
// Direct invocation (/.netlify/functions/oauth-integrations?provider=…&action=…) also works.
//
// Security model mirrors social-oauth-init/callback: the CSRF token + organisationId are
// held SERVER-SIDE in the vault with a 10-minute TTL (state carries only routing info),
// requireTenant scopes everything to the caller's active organisation, and tokens are
// persisted via src/utils/workspace-integrations.ts (vault-encrypted, never plaintext).
//
// Client IDs/secrets come from env: HUBSPOT_CLIENT_ID/SECRET, XERO_CLIENT_ID/SECRET,
// SLACK_CLIENT_ID/SECRET.

import { Handler, HandlerEvent } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { storeSecret, getSecret, deleteSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import {
    INTEGRATION_PROVIDERS,
    isIntegrationProvider,
    type IntegrationProvider,
    saveIntegration,
    getIntegration,
    deleteIntegration,
    providerLabel,
} from '../../src/utils/workspace-integrations';

const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes

const SCOPES: Record<IntegrationProvider, string> = {
    // Minimum scopes for the Phase 1 actions (CRM record updates, invoice notes, Block Kit posts).
    hubspot: 'crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write oauth',
    xero: 'offline_access accounting.transactions accounting.contacts',
    slack: 'chat:write,chat:write.public,channels:read',
};

function buildState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseState(raw: string): Record<string, string> | null {
    try { return JSON.parse(Buffer.from(raw, 'base64url').toString()); }
    catch { return null; }
}

function redirect(location: string) {
    return { statusCode: 302, headers: { Location: location }, body: '' };
}

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/**
 * Resolve { provider, action } from the pretty path (/api/oauth/hubspot/callback via the
 * netlify.toml rewrite — the ORIGINAL path survives in event.rawUrl) or, when invoked
 * directly, from ?provider=…&action=… query params.
 */
function resolveRoute(event: HandlerEvent): { provider: string | null; action: string | null } {
    const qp = event.queryStringParameters ?? {};
    let provider = qp.provider ?? null;
    let action = qp.action ?? null;
    try {
        const path = new URL(event.rawUrl).pathname;
        const m = path.match(/\/api\/oauth\/(?:([a-z0-9_-]+)\/)?([a-z0-9_-]+)\/?$/i);
        if (m) {
            // /api/oauth/status has no provider segment; /api/oauth/hubspot/connect has both.
            if (m[1]) { provider = m[1]; action = m[2]; }
            else { action = m[2]; }
        }
    } catch { /* direct invocation — query params already read */ }
    return { provider, action };
}

export const handler: Handler = async (event) => {
    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return json(500, { error: 'Server misconfigured.' });

    const db = getDb();
    const { provider: rawProvider, action } = resolveRoute(event);

    // ── STATUS: connection state per provider (drives the integrations.html cards) ──
    if (action === 'status') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return ctx.error;

        const providers: Record<string, unknown> = {};
        for (const provider of INTEGRATION_PROVIDERS) {
            const row = await getIntegration(db, ctx.organisationId, provider);
            // "Connected" = row present, not revoked/errored, and either non-expiring or
            // refreshable (a refresh token exists — expiry alone is repaired silently on use).
            const connected = Boolean(row && row.status === 'active');
            providers[provider] = {
                connected,
                status: row?.status ?? null,
                accountName: row?.externalAccountName ?? null,
                expiresAt: row?.expiresAt ?? null,
                connectedAt: row?.createdAt ?? null,
            };
        }
        return json(200, { providers });
    }

    if (!isIntegrationProvider(rawProvider)) {
        return json(400, { error: 'Unknown integration provider.' });
    }
    const provider = rawProvider;

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    if (action === 'disconnect') {
        if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
        const ctx = await requireTenant(event, db, { roles: ['owner', 'admin'] });
        if ('error' in ctx) return ctx.error;
        await deleteIntegration(db, ctx.organisationId, provider);
        return json(200, { success: true });
    }

    // ── CONNECT: redirect to the provider's authorization URL ──────────────────
    if (action === 'connect') {
        const ctx = await requireTenant(event, db);
        if ('error' in ctx) return redirect('/integrations.html?oauth_error=invalid_session');
        const { userId, organisationId } = ctx;

        const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
        if (!clientId) return redirect(`/integrations.html?oauth_error=not_configured&provider=${provider}`);

        // CSRF held server-side (vault) with TTL; state carries only routing info.
        const csrf = randomBytes(32).toString('hex');
        await storeSecret(db, `oauth_csrf:${userId}:${provider}`, {
            csrf,
            expiresAt: Date.now() + CSRF_TTL_MS,
            organisationId: String(organisationId),
        });

        const redirectUri = `${baseUrl}/api/oauth/${provider}/callback`;
        const state = buildState({ provider, userId: String(userId), csrf });

        let authUrl: string;
        if (provider === 'hubspot') {
            authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.hubspot)}&state=${state}`;
        } else if (provider === 'xero') {
            authUrl = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.xero)}&state=${state}`;
        } else {
            authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${encodeURIComponent(SCOPES.slack)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        }
        return redirect(authUrl);
    }

    // ── CALLBACK: exchange the code, persist tokens, bounce back to settings ───
    if (action === 'callback') {
        const { code, state: rawState, error } = event.queryStringParameters ?? {};
        if (error) return redirect(`/integrations.html?oauth_error=access_denied&provider=${provider}`);
        if (!code || !rawState) return redirect(`/integrations.html?oauth_error=missing_params&provider=${provider}`);

        const state = parseState(rawState);
        if (!state?.userId || !state?.csrf || state.provider !== provider) {
            return redirect(`/integrations.html?oauth_error=csrf_fail&provider=${provider}`);
        }
        const userId = parseInt(state.userId);

        // Verify + consume the server-side CSRF entry (one-time use, 10-minute TTL).
        const csrfKey = `oauth_csrf:${userId}:${provider}`;
        const stored = await getSecret(db, csrfKey).catch(() => null) as { csrf?: string; expiresAt?: number; organisationId?: string } | null;
        await deleteSecret(db, csrfKey).catch(() => {});
        if (!stored || stored.csrf !== state.csrf || !stored.expiresAt || Date.now() > stored.expiresAt) {
            return redirect(`/integrations.html?oauth_error=csrf_fail&provider=${provider}`);
        }
        const organisationId = parseInt(stored.organisationId ?? '0');
        if (!organisationId) return redirect(`/integrations.html?oauth_error=csrf_fail&provider=${provider}`);

        const redirectUri = `${baseUrl}/api/oauth/${provider}/callback`;

        try {
            if (provider === 'hubspot') {
                const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.HUBSPOT_CLIENT_ID ?? '',
                        client_secret: process.env.HUBSPOT_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number } = await tokenRes.json();
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=hubspot`);

                // Token introspection gives the hub (portal) id + domain for the card label.
                const infoRes = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${tokenData.access_token}`);
                const info: { hub_id?: number; hub_domain?: string } = infoRes.ok ? await infoRes.json() : {};

                await saveIntegration(db, {
                    organisationId, userId, provider: 'hubspot',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: info.hub_id ? String(info.hub_id) : null,
                    externalAccountName: info.hub_domain ?? null,
                    scopes: SCOPES.hubspot,
                });
            } else if (provider === 'xero') {
                const credentials = Buffer.from(`${process.env.XERO_CLIENT_ID ?? ''}:${process.env.XERO_CLIENT_SECRET ?? ''}`).toString('base64');
                const tokenRes = await fetch('https://identity.xero.com/connect/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
                    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number } = await tokenRes.json();
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=xero`);

                // Xero tenant mapping: every API call needs the Xero-Tenant-Id header, so
                // resolve the authorised organisation connection now and store its id.
                const connRes = await fetch('https://api.xero.com/connections', {
                    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
                });
                const connections: Array<{ tenantId?: string; tenantName?: string; tenantType?: string }> = connRes.ok ? await connRes.json() : [];
                const org = connections.find((c) => c.tenantType === 'ORGANISATION') ?? connections[0];
                if (!org?.tenantId) return redirect(`/integrations.html?oauth_error=no_tenant&provider=xero`);

                await saveIntegration(db, {
                    organisationId, userId, provider: 'xero',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: org.tenantId,
                    externalAccountName: org.tenantName ?? null,
                    scopes: SCOPES.xero,
                });
            } else {
                const tokenRes = await fetch('https://slack.com/api/oauth.v2.access', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: process.env.SLACK_CLIENT_ID ?? '',
                        client_secret: process.env.SLACK_CLIENT_SECRET ?? '',
                        code,
                        redirect_uri: redirectUri,
                    }),
                });
                const tokenData: {
                    ok?: boolean; access_token?: string; refresh_token?: string; expires_in?: number;
                    scope?: string; team?: { id?: string; name?: string };
                } = await tokenRes.json();
                if (!tokenData.ok || !tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=slack`);

                await saveIntegration(db, {
                    organisationId, userId, provider: 'slack',
                    accessToken: tokenData.access_token,
                    // Bot tokens don't expire unless the app has token rotation enabled —
                    // expires_in/refresh_token are only present in that case.
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: tokenData.team?.id ?? null,
                    externalAccountName: tokenData.team?.name ?? null,
                    scopes: tokenData.scope ?? SCOPES.slack,
                });
            }
        } catch (err) {
            console.error(`[oauth-integrations] ${provider} callback failed:`, err);
            return redirect(`/integrations.html?oauth_error=token_exchange&provider=${provider}`);
        }

        return redirect(`/integrations.html?connected=${provider}`);
    }

    return json(400, { error: `Unknown action for ${providerLabel(provider)} integration.` });
};
