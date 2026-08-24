// netlify/functions/oauth-integrations.ts
// External Integrations: universal OAuth 2.0 router for HubSpot, Xero, Slack (Phase 1),
// Salesforce, Zendesk, Notion (Phase 2), QuickBooks, Intercom, Gmail (Phase 3) and
// Threads, TikTok, YouTube (Phase 4 — Social Media Manager publishing).
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
// GMAIL_CLIENT_ID/SECRET, THREADS_CLIENT_ID/SECRET, TIKTOK_CLIENT_ID/SECRET
// (TikTok calls these client_key/client_secret), YOUTUBE_CLIENT_ID/SECRET.
//
// Threads special case: the code→token exchange yields a short-lived (1h) token that is
// immediately swapped for a long-lived (~60 day) one; the long-lived token refreshes
// with ITSELF (th_refresh_token grant), so it is stored in both vault slots.
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
import { createHash, randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { storeSecret, getSecret, deleteSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import {
    INTEGRATION_PROVIDERS,
    OUTLOOK_SCOPE,
    isIntegrationProvider,
    type IntegrationProvider,
    saveIntegration,
    getIntegration,
    deleteIntegration,
    providerLabel,
    SALESFORCE_SYNTHETIC_TTL_SEC,
} from '../../src/utils/workspace-integrations';
import { withLambda } from '@netlify/aws-lambda-compat';

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
    // Outlook/Microsoft 365 outbound email for the Lead Generator. Delegated (sends AS the
    // signed-in user), never application permissions — those would allow sending as any
    // mailbox in a customer tenant. Single source of truth so authorize/exchange/refresh agree.
    outlook: OUTLOOK_SCOPE,
    // Phase 4 actions: Threads post publishing, TikTok video uploads, YouTube video uploads.
    threads: 'threads_basic,threads_content_publish',
    tiktok: 'user.info.basic,video.upload',
    // youtube.readonly is only for the channel label on the card; uploads need youtube.upload.
    youtube: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    // WordPress.com: no scope param → the consent screen shows a site picker and the token is
    // scoped to the chosen blog (its blog_id comes back in the token response).
    wordpresscom: '',
    // Google Search Console: read-only search analytics for the content-decay loop (US 5.1).
    searchconsole: 'https://www.googleapis.com/auth/webmasters.readonly',
    // Meeting Note Taker Phase 3: Jira/Asana ticket creation from approved action items. The
    // authUrl + callback token-exchange for these are wired in step 3 — these scope strings are
    // declared now so the provider union stays complete. offline_access → a refresh token.
    jira: 'write:jira-work read:jira-work read:jira-user offline_access',
    // Asana's classic OAuth grants full task read/write on consent — the scope param is omitted
    // (its authorize URL below sends no scope), so this stays empty like Notion/Intercom.
    asana: '',
    // Canva Connect (Content Library import): READ-ONLY. design:meta:read lists/searches designs,
    // folder:read + asset:read walk the folder tree, design:content:read is what the export job
    // requires. Never request *:write — we only ever read out of Canva. The card's account label
    // comes from /users/me/profile, which needs NO scope, so profile:read is deliberately absent.
    canva: 'design:meta:read design:content:read folder:read asset:read',
};

/**
 * What the provider says it actually GRANTED — or null when it does not say.
 *
 * ⚠️ Never pass a `SCOPES.*` constant to this column. `workspace_integrations.scopes` reads as a
 * record of what the token can DO, and every consumer treats it that way; writing the REQUESTED
 * list there turns a guess into an apparent fact. It also adds no information, since the requested
 * list is a compile-time constant sitting a few lines above.
 *
 * This is not hypothetical. Prod Threads publishing failed for weeks with a 400 whose message named
 * no cause, while the row read `threads_basic,threads_content_publish` — because that string was a
 * constant we wrote ourselves, not a grant. Meta silently drops a scope that is not configured on
 * the app's use case rather than refusing the authorization, so `threads_content_publish` was never
 * granted, `/me` kept working (making the connection look healthy), and every write failed. A null
 * here would have said "we don't know", which is the truth and would have been the first thing to
 * check.
 *
 * Accepts the string form (`scope`, space- or comma-delimited) and the array form (`permissions`).
 */
function grantedScopes(reported: unknown): string | null {
    if (Array.isArray(reported)) {
        const list = reported.map(s => String(s ?? '').trim()).filter(Boolean);
        return list.length ? list.join(',') : null;
    }
    if (typeof reported === 'string' && reported.trim()) return reported.trim();
    return null;
}

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

/**
 * Where a connect flow returns to inside the assistant it was started from, keyed by the opaque
 * `returnTo` token the client sends on /connect.
 *
 * ⚠️ A TABLE, not a pass-through. `state` is base64 of client-supplied JSON with no signature, so
 * anything read back out of it can have been rewritten by whoever holds the URL. Resolving the
 * token here means the only tab names that can ever reach a redirect are the ones written below.
 *
 * Default (no token): the assistant's Connections tab, which is where every connect link on the
 * Connections grid comes from. 'outreach' belongs to the connect-your-inbox prompt raised by
 * approving a lead — that user is mid-send, not managing connectors, so they go back to the
 * Outreach tab's Approved column where the lead they just approved is waiting.
 */
const RETURN_DESTINATIONS: Record<string, { tab: string; rqStatus?: string }> = {
    outreach: { tab: 'review-queue', rqStatus: 'approved' },
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

export default withLambda(async (event) => {
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

        // Canva mandates PKCE (S256). The code_verifier is a SECRET — it rides in the
        // server-side vault entry alongside the CSRF token (same place the Zendesk subdomain
        // travels) and must never appear in `state`, which is client-visible.
        let codeVerifier: string | null = null;
        let codeChallenge: string | null = null;
        if (provider === 'canva') {
            codeVerifier = randomBytes(32).toString('base64url');
            codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
        }

        // CSRF held server-side (vault) with TTL; state carries only routing info.
        const csrf = randomBytes(32).toString('hex');
        await storeSecret(db, `oauth_csrf:${userId}:${provider}`, {
            csrf,
            expiresAt: Date.now() + CSRF_TTL_MS,
            organisationId: String(organisationId),
            ...(zendeskSubdomain ? { zendeskSubdomain } : {}),
            ...(codeVerifier ? { codeVerifier } : {}),
        });

        // When the connect flow is launched from an assistant's Connections tab, the page
        // appends ?assistantId=N (see _oauthUrl in integrations.js). Carry it through `state`
        // so the callback can return the user to that assistant's Connections tab instead of
        // stranding them on the workspace-wide integrations.html. Validate to a positive
        // integer — `state` is client-visible, so we never echo an arbitrary value back.
        const rawAssistantId = event.queryStringParameters?.assistantId;
        const assistantId = rawAssistantId && /^\d+$/.test(rawAssistantId) && Number(rawAssistantId) > 0
            ? rawAssistantId : null;

        // ?returnTo names WHERE INSIDE that assistant to land — see RETURN_DESTINATIONS. It is an
        // opaque token deliberately: `state` is client-visible and unsigned, so an unknown value is
        // dropped here and the resolved value is looked up from our own table on the way back,
        // rather than echoing a caller-supplied tab name into a redirect.
        const rawReturnTo = event.queryStringParameters?.returnTo;
        const returnTo = rawReturnTo && RETURN_DESTINATIONS[rawReturnTo] ? rawReturnTo : null;

        const redirectUri = `${baseUrl}/api/oauth/${provider}/callback`;
        const state = buildState({
            provider, userId: String(userId), csrf,
            ...(assistantId ? { assistantId } : {}),
            ...(returnTo ? { returnTo } : {}),
        });

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
            //
            // `select_account` alongside it is not cosmetic. This grant decides WHICH MAILBOX the
            // assistant's outreach is sent from, and with `consent` alone Google skips the account
            // chooser whenever exactly one Google session is live in the browser — so an agency
            // signed into its own Google account while setting a client up was shown "Be More Swan
            // wants access to <the agency's account>" with no visible way to pick the client's
            // mailbox, and read that as the product asking them to connect to us. Google documents
            // `prompt` as a space-delimited list, so both apply.
            const gmailPrompt = encodeURIComponent('consent select_account');
            authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.gmail)}&access_type=offline&prompt=${gmailPrompt}&state=${state}`;
        } else if (provider === 'outlook') {
            // /common serves work, school AND personal Microsoft accounts — matches the app's
            // "any Entra tenant + personal accounts" registration. offline_access lives in the
            // scope string (unlike Google, Microsoft has no access_type param).
            //
            // prompt=select_account, not consent, for the same reason as Gmail above: the user must
            // be able to see and choose the mailbox. Unlike Google this is a single value — Entra
            // rejects a space-delimited list with AADSTS70011 — and nothing is lost by dropping
            // `consent`: the refresh token comes from offline_access in the scope string, and Entra
            // raises the consent screen by itself whenever the requested scopes are not yet granted.
            authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.outlook)}&response_mode=query&prompt=select_account&state=${state}`;
        } else if (provider === 'threads') {
            // `redirectUri` (= ${baseUrl}/api/oauth/threads/callback) must be whitelisted under the
            // Threads use case → Settings → Redirect Callback URLs, or Meta blocks with error 1349168
            // ("URL blocked"). That screen also requires the Uninstall/Delete callback URLs — see the
            // full dashboard checklist in netlify/functions/meta-callbacks.ts.
            authUrl = `https://threads.net/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.threads)}&state=${state}`;
        } else if (provider === 'tiktok') {
            // TikTok for Business names the id param client_key (env still TIKTOK_CLIENT_ID).
            authUrl = `https://www.tiktok.com/v2/auth/authorize/?response_type=code&client_key=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.tiktok)}&state=${state}`;
        } else if (provider === 'youtube') {
            // Same Google consent flow as Gmail — offline + consent forces a refresh token.
            authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.youtube)}&access_type=offline&prompt=consent&state=${state}`;
        } else if (provider === 'wordpresscom') {
            // No scope param → the consent screen lets the user pick which blog to authorise.
            authUrl = `https://public-api.wordpress.com/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        } else if (provider === 'searchconsole') {
            // Google consent — offline + consent forces a refresh token for the daily ingest cron.
            authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.searchconsole)}&access_type=offline&prompt=consent&state=${state}`;
        } else if (provider === 'jira') {
            // Atlassian 3LO (api.atlassian.com). offline_access (in SCOPES) yields a refresh
            // token; prompt=consent guarantees it is re-issued on re-auth.
            authUrl = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${clientId}&scope=${encodeURIComponent(SCOPES.jira)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&response_type=code&prompt=consent`;
        } else if (provider === 'asana') {
            // Asana 3LO — no scope param (classic full-access grant). refresh token comes back
            // automatically; there is no offline flag to set.
            authUrl = `https://app.asana.com/-/oauth_authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        } else if (provider === 'canva') {
            // Canva Connect requires PKCE — code_challenge_method is always S256; the matching
            // verifier is replayed from the vault at callback.
            authUrl = `https://www.canva.com/api/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.canva)}&code_challenge=${codeChallenge}&code_challenge_method=S256&state=${state}`;
        } else if (provider === 'slack') {
            authUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${encodeURIComponent(SCOPES.slack)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
        } else {
            // Provider is in the union but its OAuth flow isn't wired yet.
            return redirect(`/integrations.html?oauth_error=not_configured&provider=${provider}`);
        }
        return redirect(authUrl);
    }

    // ── CALLBACK: exchange the code, persist tokens, bounce back to settings ───
    if (action === 'callback') {
        const { code, state: rawState, error, error_description } = event.queryStringParameters ?? {};
        if (error) {
            // Don't flatten every provider error to "you cancelled": only a genuine user-decline
            // is access_denied. invalid_scope / invalid_client / server_error etc. are config
            // problems the user needs to see (and we need in the logs) to fix them.
            console.error(`[oauth ${provider}] authorize callback returned error=${error}${error_description ? ` (${error_description})` : ''}`);
            const oauthError = error === 'access_denied' ? 'access_denied' : 'provider_error';
            // ⚠️ A DECLINE HAS TO COME BACK TO WHERE IT STARTED. This branch runs before `state` is
            // verified, so it used to send every failure to integrations.html — tolerable while
            // every connect link opened a throwaway tab the user could close, but the outreach
            // prompt now navigates THIS tab into the grant, so pressing "Cancel" on Google's screen
            // would have dumped a user who was approving a lead onto the workspace-wide connectors
            // page with their assistant nowhere in sight. The routing hints are re-validated (an
            // integer id, a table lookup) exactly as the success path does; nothing here trusts
            // `state` for anything but where to send the browser.
            const failState = rawState ? parseState(rawState) : null;
            const failAssistantId = failState?.assistantId && /^\d+$/.test(failState.assistantId)
                ? failState.assistantId : null;
            if (failAssistantId) {
                const dest = failState?.returnTo ? RETURN_DESTINATIONS[failState.returnTo] : null;
                const where = dest
                    ? `&tab=${dest.tab}${dest.rqStatus ? `&rqStatus=${dest.rqStatus}` : ''}`
                    : '';
                return redirect(`/workspace.html?oauth_error=${oauthError}&platform=${provider}&assistantId=${failAssistantId}${where}`);
            }
            return redirect(`/integrations.html?oauth_error=${oauthError}&provider=${provider}&reason=${encodeURIComponent(error_description || error)}`);
        }
        if (!code || !rawState) return redirect(`/integrations.html?oauth_error=missing_params&provider=${provider}`);

        const state = parseState(rawState);
        if (!state?.userId || !state?.csrf || state.provider !== provider) {
            return redirect(`/integrations.html?oauth_error=csrf_fail&provider=${provider}`);
        }
        const userId = parseInt(state.userId);

        // Verify + consume the server-side CSRF entry (one-time use, 10-minute TTL).
        const csrfKey = `oauth_csrf:${userId}:${provider}`;
        const stored = await getSecret(db, csrfKey).catch(() => null) as { csrf?: string; expiresAt?: number; organisationId?: string; zendeskSubdomain?: string; codeVerifier?: string } | null;
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
                    scopes: grantedScopes(null),   // hubspot does not report granted scopes
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
                    scopes: grantedScopes(null),   // xero does not report granted scopes
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
                    scopes: grantedScopes(null),   // salesforce does not report granted scopes
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
                    scopes: grantedScopes(null),   // zendesk does not report granted scopes
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
                    scopes: grantedScopes(null),   // quickbooks does not report granted scopes
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
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'outlook') {
                const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.OUTLOOK_CLIENT_ID ?? '',
                        client_secret: process.env.OUTLOOK_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        scope: SCOPES.outlook,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=outlook`);

                // Graph /me gives the mailbox address for the card label. userPrincipalName is
                // the reliable one — `mail` is null on many personal and unlicensed accounts.
                let emailAddress: string | null = null;
                try {
                    const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}` },
                    });
                    const me: { mail?: string; userPrincipalName?: string } = meRes.ok ? await meRes.json() : {};
                    emailAddress = me.mail ?? me.userPrincipalName ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'outlook',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: emailAddress,
                    externalAccountName: emailAddress,
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'threads') {
                // Step 1: code → short-lived (1h) token.
                const tokenRes = await fetch('https://graph.threads.net/oauth/access_token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.THREADS_CLIENT_ID ?? '',
                        client_secret: process.env.THREADS_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                // `permissions` is Threads' report of what was actually granted. It is the ONLY
                // signal we get: Meta drops a scope that is not configured on the app's Threads use
                // case rather than failing the authorization, so a token with threads_basic alone
                // comes back here looking identical to a fully-granted one. See grantedScopes.
                const tokenData: { access_token?: string; user_id?: string | number; permissions?: string[] | string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=threads`);

                // Step 2: swap for the long-lived (~60 day) token — the only kind worth
                // vaulting, since the short-lived one dies within the hour.
                const longRes = await fetch(`https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(process.env.THREADS_CLIENT_SECRET ?? '')}&access_token=${encodeURIComponent(tokenData.access_token)}`);
                const longData: { access_token?: string; expires_in?: number } = longRes.ok ? await longRes.json().catch(() => ({})) : {};
                const accessToken = longData.access_token ?? tokenData.access_token;
                const expiresInSec = longData.access_token ? (longData.expires_in ?? null) : 3600;

                // Profile gives the @username for the card label (best-effort).
                let username: string | null = null;
                let threadsUserId: string | null = tokenData.user_id != null ? String(tokenData.user_id) : null;
                try {
                    const meRes = await fetch('https://graph.threads.net/v1.0/me?fields=id,username', {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });
                    const me: { id?: string; username?: string } = meRes.ok ? await meRes.json() : {};
                    username = me.username ?? null;
                    threadsUserId = me.id ?? threadsUserId;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'threads',
                    accessToken,
                    // The long-lived token refreshes with itself (th_refresh_token) —
                    // store it in the refresh slot so getFreshAccessToken can rotate it.
                    refreshToken: accessToken,
                    expiresInSec,
                    // The Threads user id roots the publish endpoints (/{id}/threads).
                    tenantId: threadsUserId,
                    externalAccountName: username ? `@${username}` : null,
                    // What Threads GRANTED, never SCOPES.threads. Null when it says nothing — an
                    // honest "unknown" beats a constant that reads as proof the token can publish.
                    scopes: grantedScopes(tokenData.permissions),
                });
            } else if (provider === 'tiktok') {
                const tokenRes = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_key: process.env.TIKTOK_CLIENT_ID ?? '',
                        client_secret: process.env.TIKTOK_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; open_id?: string; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=tiktok`);

                // Display name for the card label (best-effort).
                let displayName: string | null = null;
                try {
                    const infoRes = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}` },
                    });
                    const info: { data?: { user?: { display_name?: string } } } = infoRes.ok ? await infoRes.json() : {};
                    displayName = info.data?.user?.display_name ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'tiktok',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    // open_id identifies the authorised TikTok account on every API call.
                    tenantId: tokenData.open_id ?? null,
                    externalAccountName: displayName,
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'youtube') {
                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.YOUTUBE_CLIENT_ID ?? '',
                        client_secret: process.env.YOUTUBE_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=youtube`);

                // The channel gives the title + id for the card label (best-effort).
                let channelId: string | null = null;
                let channelTitle: string | null = null;
                try {
                    const chanRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}` },
                    });
                    const chan: { items?: Array<{ id?: string; snippet?: { title?: string } }> } = chanRes.ok ? await chanRes.json() : {};
                    channelId = chan.items?.[0]?.id ?? null;
                    channelTitle = chan.items?.[0]?.snippet?.title ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'youtube',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: channelId,
                    externalAccountName: channelTitle,
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'wordpresscom') {
                const tokenRes = await fetch('https://public-api.wordpress.com/oauth2/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.WORDPRESSCOM_CLIENT_ID ?? '',
                        client_secret: process.env.WORDPRESSCOM_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; blog_id?: string | number; blog_url?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token || tokenData.blog_id == null) return redirect(`/integrations.html?oauth_error=token_exchange&provider=wordpresscom`);

                await saveIntegration(db, {
                    organisationId, userId, provider: 'wordpresscom',
                    accessToken: tokenData.access_token,
                    // WordPress.com tokens never expire and there is no refresh grant.
                    refreshToken: null,
                    expiresInSec: null,
                    // The authorised blog id roots every WP.com REST call (/sites/{blog_id}/...).
                    tenantId: String(tokenData.blog_id),
                    externalAccountName: tokenData.blog_url ?? null,
                    scopes: null,
                });
            } else if (provider === 'searchconsole') {
                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.SEARCHCONSOLE_CLIENT_ID ?? '',
                        client_secret: process.env.SEARCHCONSOLE_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=searchconsole`);

                // A verified property makes a friendly card label (best-effort); the ingest cron
                // re-lists properties itself, so this is display-only.
                let siteLabel: string | null = null;
                try {
                    const sitesRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}` },
                    });
                    const sites: { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] } = sitesRes.ok ? await sitesRes.json() : {};
                    const verified = (sites.siteEntry ?? []).filter((s) => s.permissionLevel && s.permissionLevel !== 'siteUnverifiedUser');
                    siteLabel = verified[0]?.siteUrl ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'searchconsole',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: null,
                    externalAccountName: siteLabel,
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'jira') {
                const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        grant_type: 'authorization_code',
                        client_id: process.env.JIRA_CLIENT_ID ?? '',
                        client_secret: process.env.JIRA_CLIENT_SECRET ?? '',
                        code,
                        redirect_uri: redirectUri,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=jira`);

                // Resolve the Jira Cloud site (cloudId) this token can reach — every REST call
                // roots at https://api.atlassian.com/ex/jira/{cloudId}/…. Stored as tenantId (like
                // Xero's tenant); the site URL doubles as the card label + ticket browse root.
                let cloudId: string | null = null;
                let siteUrl: string | null = null;
                try {
                    const resourcesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
                    });
                    const resources: Array<{ id?: string; name?: string; url?: string }> = resourcesRes.ok ? await resourcesRes.json() : [];
                    cloudId = resources[0]?.id ?? null;
                    siteUrl = resources[0]?.url ?? resources[0]?.name ?? null;
                } catch { /* resolved by the guard below */ }
                if (!cloudId) return redirect(`/integrations.html?oauth_error=no_tenant&provider=jira`);

                await saveIntegration(db, {
                    organisationId, userId, provider: 'jira',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: cloudId,
                    externalAccountName: siteUrl,
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'asana') {
                const tokenRes = await fetch('https://app.asana.com/-/oauth_token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: process.env.ASANA_CLIENT_ID ?? '',
                        client_secret: process.env.ASANA_CLIENT_SECRET ?? '',
                        redirect_uri: redirectUri,
                        code,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; data?: { name?: string; email?: string } } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=asana`);

                // Resolve the user's default workspace (gid + name) for the card label. Tasks are
                // filed by project gid (the recipe config), so the workspace is display-only here.
                let workspaceGid: string | null = null;
                let workspaceName: string | null = null;
                try {
                    const wsRes = await fetch('https://app.asana.com/api/1.0/workspaces?limit=1', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
                    });
                    const ws: { data?: Array<{ gid?: string; name?: string }> } = wsRes.ok ? await wsRes.json() : {};
                    workspaceGid = ws.data?.[0]?.gid ?? null;
                    workspaceName = ws.data?.[0]?.name ?? null;
                } catch { /* label only — connection still succeeds */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'asana',
                    accessToken: tokenData.access_token,
                    // Asana access tokens live ~1h; the refresh token does not rotate on use.
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? 3600,
                    tenantId: workspaceGid,
                    externalAccountName: workspaceName ?? tokenData.data?.name ?? tokenData.data?.email ?? null,
                    scopes: null,
                });
            } else if (provider === 'slack') {
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
                    scopes: grantedScopes(tokenData.scope),
                });
            } else if (provider === 'canva') {
                // PKCE: replay the verifier stashed in the vault at connect. Without it Canva
                // rejects the exchange, so a missing verifier is a hard fail, not a fallback.
                if (!stored.codeVerifier) return redirect(`/integrations.html?oauth_error=csrf_fail&provider=canva`);

                const credentials = Buffer.from(`${process.env.CANVA_CLIENT_ID ?? ''}:${process.env.CANVA_CLIENT_SECRET ?? ''}`).toString('base64');
                const tokenRes = await fetch('https://api.canva.com/rest/v1/oauth/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${credentials}` },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code,
                        code_verifier: stored.codeVerifier,
                        redirect_uri: redirectUri,
                    }),
                });
                const tokenData: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string } = await tokenRes.json().catch(() => ({}));
                if (!tokenData.access_token) return redirect(`/integrations.html?oauth_error=token_exchange&provider=canva`);

                // Friendly card label (US1 AC3). Display-only and best-effort — a failure here
                // must not sink an otherwise good connection.
                let accountName: string | null = null;
                try {
                    const meRes = await fetch('https://api.canva.com/rest/v1/users/me/profile', {
                        headers: { Authorization: `Bearer ${tokenData.access_token}` },
                    });
                    const me: { profile?: { display_name?: string } } = await meRes.json().catch(() => ({}));
                    accountName = me.profile?.display_name ?? null;
                } catch { /* label stays null */ }

                await saveIntegration(db, {
                    organisationId, userId, provider: 'canva',
                    accessToken: tokenData.access_token,
                    refreshToken: tokenData.refresh_token ?? null,
                    expiresInSec: tokenData.expires_in ?? null,
                    tenantId: null,
                    externalAccountName: accountName,
                    scopes: grantedScopes(tokenData.scope),
                });
            } else {
                // Provider is in the union but its callback isn't wired yet (e.g. asana → step 4).
                return redirect(`/integrations.html?oauth_error=not_configured&provider=${provider}`);
            }
        } catch (err) {
            console.error(`[oauth-integrations] ${provider} callback failed:`, err);
            return redirect(`/integrations.html?oauth_error=token_exchange&provider=${provider}`);
        }

        // If the connect began inside an assistant's Connections tab, return the user there —
        // workspace.html?oauth_success mirrors the social-OAuth flow (handleOAuthSuccess opens
        // the assistant on its 'platforms'/Connections tab). Re-validate the id defensively
        // since `state` is client-supplied. Otherwise fall back to the workspace-wide surfaces:
        // the blog connectors (WordPress.com, Search Console) are managed from Blog Studio, so
        // send those back there; every other provider lands on integrations.html.
        const returnAssistantId = state.assistantId && /^\d+$/.test(state.assistantId) ? state.assistantId : null;
        if (returnAssistantId) {
            // …and, when the flow named one, on the exact tab/column it was started from rather than
            // the Connections default. Resolved through RETURN_DESTINATIONS so nothing from `state`
            // is echoed verbatim.
            const dest = state.returnTo ? RETURN_DESTINATIONS[state.returnTo] : null;
            const where = dest
                ? `&tab=${dest.tab}${dest.rqStatus ? `&rqStatus=${dest.rqStatus}` : ''}`
                : '';
            return redirect(`/workspace.html?oauth_success=${provider}&assistantId=${returnAssistantId}${where}`);
        }
        const blogProvider = provider === 'wordpresscom' || provider === 'searchconsole';
        return redirect(blogProvider ? `/blog-studio.html?connected=${provider}` : `/integrations.html?connected=${provider}`);
    }

    return json(400, { error: `Unknown action for ${providerLabel(provider)} integration.` });
});
