// netlify/functions/oauth-integrations.ts
// External Integrations: universal OAuth 2.0 router for HubSpot, Xero, Slack (Phase 1),
// Salesforce, Zendesk, Notion (Phase 2) and QuickBooks, Intercom, Gmail (Phase 3).
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
// SLACK_CLIENT_ID/SECRET, SALESFORCE_CLIENT_ID/SECRET, ZENDESK_CLIENT_ID/SECRET,
// NOTION_CLIENT_ID/SECRET, QUICKBOOKS_CLIENT_ID/SECRET, INTERCOM_CLIENT_ID/SECRET,
// GMAIL_CLIENT_ID/SECRET.
//
// Zendesk special case: its OAuth endpoints live on the customer's own subdomain
// (https://{subdomain}.zendesk.com), so /api/oauth/zendesk/connect requires a
// ?subdomain= query param. The subdomain rides in the server-side CSRF vault entry
// (never in the client-visible state) and is persisted as the row's tenantId.
//
// QuickBooks special case: Intuit appends the connected company's realmId as a query
// param on the callback redirect — every QBO API call is rooted at
// /v3/company/{realmId}, so the realmId is persisted as the row's tenantId.

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
    SALESFORCE_SYNTHETIC_TTL_SEC,
} from '../../src/utils/workspace-integrations';

const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes

const SCOPES: Record<IntegrationProvider, string> = {
    // Minimum scopes for the Phase 1 actions (CRM record updates, invoice notes, Block Kit posts).
    hubspot: 'crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write oauth',
    xero: 'offline_access accounting.transactions accounting.contacts',
    slack: 'chat:write,chat:write.public,channels:read',
    // Phase 2 actions: Salesforce record patches, Zendesk internal notes, Notion pages.
    salesforce: 'api refresh_token',
    zendesk: 'read write',
    notion: '', // Notion has no scope param — access is granted per-page on the consent screen
    // Phase 3 actions: QBO invoice notes, Intercom internal notes, Gmail draft creation.
    quickbooks: 'com.intuit.quickbooks.accounting',
    intercom: '', // Intercom has no scope param — permissions come from the app's configuration
    gmail: 'https://www.googleapis.com/auth/gmail.compose',
};

/**
 * Normalise the Zendesk subdomain input: accepts a bare subdomain ("acme"), a host
 * ("acme.zendesk.com") or a full URL, and returns the bare subdomain or null when the
 * result isn't a valid Zendesk subdomain shape.
 */
function parseZendeskSubdomain(raw: string | undefined): string | null {
    if (!raw) return null;
    let value = raw.trim().toLowerCase();
    value = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    value = value.replace(/\.zendesk\.com$/, '');
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value) ? value : null;
}

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

        // Zendesk's authorize endpoint lives on the customer's subdomain, so the connect
        // link must carry it. It travels to the callback inside the CSRF vault entry.
        let zendeskSubdomain: string | null = null;
        if (provider === 'zendesk') {
            zendeskSubdomain = parseZendeskSubdomain(event.queryStringParameters?.subdomain);
            if (!zendeskSubdomain) return redirect('/integrations.html?oauth_error=missing_subdomain&provider=zendesk');
        }

        // CSRF held server-side (vault) with TTL; state carries only routing info.
        const csrf = randomBytes(32).toString('hex');
        await storeSecret(db, `oauth_csrf:${userId}:${provider}`, {
            csrf,
            expiresAt: Date.now() + CSRF_TTL_MS,
            organisationId: String(organisationId),
            ...(zendeskSubdomain ? { zendeskSubdomain } : {}),
        });

        const redirectUri = `${baseUrl}/api/oauth/${provider}/callback`;
        const state = buildState({ provider, userId: String(userId), csrf });

        let authUrl: string;
        if (provider === 'hubspot') {
            authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.hubspot)}&state=${state}`;
        } else if (provider === 'xero') {
            authUrl = `https://login.xero.com/identity/connect/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.xero)}&state=${state}`;
        } else if (provider === 'salesforce') {
            authUrl = `https://login.salesforce.com/services/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.salesforce)}&state=${state}`;
        } else if (provider === 'zendesk') {
            authUrl = `https://${zendeskSubdomain}.zendesk.com/oauth/authorizations/new?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.zendesk)}&state=${state}`;
        } else if (provider === 'notion') {
            authUrl = `https://api.notion.com/v1/oauth/authorize?response_type=code&owner=user&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        } else if (provider === 'quickbooks') {
            authUrl = `https://appcenter.intuit.com/connect/oauth2?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.quickbooks)}&state=${state}`;
        } else if (provider === 'intercom') {
            authUrl = `https://app.intercom.com/oauth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        } else if (provider === 'gmail') {
            // access_type=offline + prompt=consent forces Google to issue a refresh token
            // (it only does so on the first consent otherwise).
            authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.gmail)}&access_type=offline&prompt=consent&state=${state}`;
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
        const stored = await getSecret(db, csrfKey).catch(() => null) as { csrf?: string; expiresAt?: number; organisationId?: string; zendeskSubdomain?: string } | null;
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
            } else if (provider === 'salesforce') {
                const tokenRes = await fetch('https://login.salesforce.com/services/oauth2/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.SALESFORCE_CLIENT_ID ?? '',
                        client_secret: process.env.SALESFORCE_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; instance_url?: string; id?: string } = await tokenRes.json();
                if (!tokenData.access_token || !tokenData.instance_url) return redirect(`/integrations.html?oauth_error=token_exchange&provider=salesforce`);

                // The identity URL in the token response gives the username for the card label.
                let accountName: string | null = null;
                if (tokenData.id) {
                    const idRes = await fetch(tokenData.id, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
                    const idData: { username?: string } = idRes.ok ? await idRes.json() : {};
                    accountName = idData.username ?? null;
                }
                if (!accountName) {
                    try { accountName = new URL(tokenData.instance_url).hostname; } catch { /* keep null */ }
                }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'salesforce',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    // Salesforce sends no expires_in — synthetic TTL keeps refreshes proactive.
                    expiresInSec: SALESFORCE_SYNTHETIC_TTL_SEC,
                    // Every Salesforce REST call is rooted at the org's instance URL.
                    tenantId: tokenData.instance_url,
                    externalAccountName: accountName,
                    scopes: SCOPES.salesforce,
                });
            } else if (provider === 'zendesk') {
                // The subdomain captured at connect time rode in the CSRF vault entry.
                const subdomain = parseZendeskSubdomain(stored.zendeskSubdomain);
                if (!subdomain) return redirect(`/integrations.html?oauth_error=missing_subdomain&provider=zendesk`);

                const tokenRes = await fetch(`https://${subdomain}.zendesk.com/oauth/tokens`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        grant_type: 'authorization_code',
                        code,
                        client_id: process.env.ZENDESK_CLIENT_ID ?? '',
                        client_secret: process.env.ZENDESK_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        scope: SCOPES.zendesk,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=zendesk`);

                await saveIntegration(db, {
                    organisationId, userId, provider: 'zendesk',
                    accessToken: tokenData.access_token,
                    // refresh_token/expires_in only appear when the Zendesk app is
                    // configured with expiring tokens — otherwise the token is permanent.
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    // The subdomain roots every Zendesk API call — this IS the tenant mapping.
                    tenantId: subdomain,
                    externalAccountName: `${subdomain}.zendesk.com`,
                    scopes: SCOPES.zendesk,
                });
            } else if (provider === 'notion') {
                const credentials = Buffer.from(`${process.env.NOTION_CLIENT_ID ?? ''}:${process.env.NOTION_CLIENT_SECRET ?? ''}`).toString('base64');
                const tokenRes = await fetch('https://api.notion.com/v1/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${credentials}` },
                    body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
                });
                const tokenData: { access_token?: string; workspace_id?: string; workspace_name?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=notion`);

                await saveIntegration(db, {
                    organisationId, userId, provider: 'notion',
                    accessToken: tokenData.access_token,
                    // Notion tokens never expire and there is no refresh grant.
                    refreshToken: null,
                    expiresInSec: null,
                    tenantId: tokenData.workspace_id ?? null,
                    externalAccountName: tokenData.workspace_name ?? null,
                    scopes: null,
                });
            } else if (provider === 'quickbooks') {
                // Intuit appends the connected company's realmId to the callback URL — it is
                // the company id every QBO API call is rooted at, so it becomes the tenantId.
                const realmId = (event.queryStringParameters?.realmId ?? '').trim();
                if (!realmId) return redirect(`/integrations.html?oauth_error=no_tenant&provider=quickbooks`);

                const credentials = Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID ?? ''}:${process.env.QUICKBOOKS_CLIENT_SECRET ?? ''}`).toString('base64');
                const tokenRes = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${credentials}` },
                    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=quickbooks`);

                // CompanyInfo gives the company name for the card label (best-effort).
                // QUICKBOOKS_API_BASE lets sandbox companies point at sandbox-quickbooks.api.intuit.com.
                const apiBase = (process.env.QUICKBOOKS_API_BASE ?? 'https://quickbooks.api.intuit.com').replace(/\/$/, '');
                let companyName: string | null = null;
                try {
                    const infoRes = await fetch(`${apiBase}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=70`, {
                        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
                    });
                    const info: { CompanyInfo?: { CompanyName?: string } } = infoRes.ok ? await infoRes.json() : {};
                    companyName = info.CompanyInfo?.CompanyName ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'quickbooks',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: realmId,
                    externalAccountName: companyName,
                    scopes: SCOPES.quickbooks,
                });
            } else if (provider === 'intercom') {
                const tokenRes = await fetch('https://api.intercom.io/auth/eagle/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                    body: JSON.stringify({
                        grant_type: 'authorization_code',
                        code,
                        client_id: process.env.INTERCOM_CLIENT_ID ?? '',
                        client_secret: process.env.INTERCOM_CLIENT_SECRET ?? '',
                    }),
                });
                const tokenData: { access_token?: string; token?: string } = await tokenRes.json().catch(() => ({}));
                const accessToken = tokenData.access_token ?? tokenData.token;
                if (!accessToken) return redirect(`/integrations.html?oauth_error=token_exchange&provider=intercom`);

                // /me identifies the authorising admin + workspace (app) for the card label.
                let workspaceId: string | null = null;
                let accountName: string | null = null;
                try {
                    const meRes = await fetch('https://api.intercom.io/me', {
                        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
                    });
                    const me: { app?: { id_code?: string; name?: string }; email?: string } = meRes.ok ? await meRes.json() : {};
                    workspaceId = me.app?.id_code ?? null;
                    accountName = me.app?.name ?? me.email ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'intercom',
                    accessToken,
                    // Intercom tokens never expire and there is no refresh grant.
                    refreshToken: null,
                    expiresInSec: null,
                    tenantId: workspaceId,
                    externalAccountName: accountName,
                    scopes: null,
                });
            } else if (provider === 'gmail') {
                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.GMAIL_CLIENT_ID ?? '',
                        client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=gmail`);

                // The Gmail profile gives the mailbox address for the card label.
                let emailAddress: string | null = null;
                try {
                    const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}` },
                    });
                    const profile: { emailAddress?: string } = profileRes.ok ? await profileRes.json() : {};
                    emailAddress = profile.emailAddress ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'gmail',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: emailAddress,
                    externalAccountName: emailAddress,
                    scopes: tokenData.scope ?? SCOPES.gmail,
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
