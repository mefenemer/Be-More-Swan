// netlify/functions/linkedin-ads-oauth-callback.ts
// The return leg of the LinkedIn ADVERTISING authorisation. Pairs with linkedin-ads-oauth-init.ts.
//
// Exchanges the code for a token, discovers which ad accounts the member can reach, and stores the
// connection as `system_connections.service_name = 'linkedin_ads'` — a DIFFERENT ROW from the
// `'linkedin'` social connection, which this function must never read, write or delete.
//
// ── The rule this file exists to keep ───────────────────────────────────────────────────────────
// ⚠️ CONNECTING OR DISCONNECTING ADS MUST NEVER TOUCH THE SOCIAL CONNECTION. They share an app and
// a member, and nothing else. The blog-destination build learned the same lesson the hard way:
// disconnecting a destination fell through into `deleteSecret`/`deleteIntegration` and would have
// silently stopped the Social Media Manager posting. Every query below is scoped by
// `service_name = 'linkedin_ads'`, and a test asserts the string never drifts to 'linkedin'.
//
// ── Discovering ad accounts is best-effort ──────────────────────────────────────────────────────
// The token is the thing worth keeping. If the account listing fails — throttled, or Development
// Tier behaving unexpectedly — the connection is still stored with an empty account list and the
// user is told to pick an account later, rather than losing an authorisation they just granted.

import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { auditLogs, systemConnections } from '../../db/schema';
import { getSecret, storeSecret, deleteSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { LINKEDIN_ADS_SCOPES, adsCsrfKey } from './linkedin-ads-oauth-init';
import { LINKEDIN_API_VERSION } from '../../src/utils/ad-networks/linkedin';
import { withLambda } from '@netlify/aws-lambda-compat';

/** ⚠️ The ads connection's own service name. NEVER 'linkedin' — that is the posting connection. */
export const ADS_SERVICE_NAME = 'linkedin_ads';

const redirect = (to: string) => ({ statusCode: 302, headers: { Location: to }, body: '' });

interface AdAccount { urn: string; name: string; currency: string }

/**
 * Ad accounts this token can reach.
 *
 * ⚠️ Returns null on failure, NOT an empty array. "We could not ask" and "you have none" lead to
 * completely different messages — one says try again, the other says create an account in Campaign
 * Manager first — and collapsing them would send a user to fix a problem they do not have.
 */
async function fetchAdAccounts(token: string): Promise<AdAccount[] | null> {
    try {
        const res = await fetch('https://api.linkedin.com/rest/adAccounts?q=search', {
            headers: {
                Authorization: `Bearer ${token}`,
                'Linkedin-Version': LINKEDIN_API_VERSION,
                'X-Restli-Protocol-Version': '2.0.0',
            },
        });
        if (!res.ok) return null;
        const data = await res.json() as { elements?: Record<string, any>[] };
        if (!Array.isArray(data.elements)) return null;
        return data.elements.map((e) => ({
            urn: `urn:li:sponsoredAccount:${e.id}`,
            name: String(e.name ?? `Account ${e.id}`),
            // The account's own currency. Carried through because spend comes back in it, and
            // assuming GBP is how a euro ends up added to a pound.
            currency: String(e.currency ?? ''),
        }));
    } catch {
        return null;
    }
}

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>) || '';
    const q = event.queryStringParameters || {};

    // The user pressed Cancel on LinkedIn's consent screen. Not an error — say nothing alarming.
    if (q.error) return redirect('/integrations.html?ads_error=declined');
    if (!q.code || !q.state) return redirect('/integrations.html?ads_error=invalid_response');

    let parsed: { flow?: string; userId?: string; csrf?: string };
    try {
        parsed = JSON.parse(Buffer.from(String(q.state), 'base64url').toString('utf8'));
    } catch {
        return redirect('/integrations.html?ads_error=invalid_state');
    }
    // ⚠️ Only this flow's states are accepted here. A state minted by the social flow must not be
    // redeemable for an ads token.
    if (parsed.flow !== 'linkedin_ads' || !parsed.userId || !parsed.csrf) {
        return redirect('/integrations.html?ads_error=invalid_state');
    }
    const userId = Number(parsed.userId);
    if (!Number.isFinite(userId)) return redirect('/integrations.html?ads_error=invalid_state');

    const db = getDb();

    // CSRF: the value in the URL must match the one we stored, and it must not have expired.
    // ⚠️ Compared server-side, never echoed back — the state is base64, not signed, so it is a
    // routing hint and the vault record is the actual proof.
    const stored = await getSecret(db, adsCsrfKey(userId)) as
        { csrf?: string; expiresAt?: number; organisationId?: string } | null;
    if (!stored?.csrf || stored.csrf !== parsed.csrf) return redirect('/integrations.html?ads_error=invalid_state');
    if (!stored.expiresAt || Date.now() > Number(stored.expiresAt)) {
        await deleteSecret(db, adsCsrfKey(userId));
        return redirect('/integrations.html?ads_error=expired');
    }
    const organisationId = Number(stored.organisationId);
    if (!Number.isFinite(organisationId)) return redirect('/integrations.html?ads_error=invalid_state');

    // One-time use: burn it before the exchange, so a replayed callback cannot mint a second token.
    await deleteSecret(db, adsCsrfKey(userId));

    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) return redirect('/integrations.html?ads_error=not_configured');

    // The redirect_uri here must be byte-identical to the one sent at init, or LinkedIn rejects
    // the exchange. Same construction, no query string.
    const callbackUri = `${baseUrl}/.netlify/functions/linkedin-ads-oauth-callback`;

    let tokenData: { access_token?: string; expires_in?: number; refresh_token?: string };
    try {
        const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: String(q.code),
                redirect_uri: callbackUri,
                client_id: clientId,
                client_secret: clientSecret,
            }).toString(),
        });
        if (!res.ok) {
            // ⚠️ Log the STATUS, never the body — a token exchange response can carry credentials.
            console.error('[linkedin-ads-oauth] token exchange failed', { status: res.status });
            return redirect('/integrations.html?ads_error=exchange_failed');
        }
        tokenData = await res.json();
    } catch (err) {
        console.error('[linkedin-ads-oauth] token exchange threw', err);
        return redirect('/integrations.html?ads_error=exchange_failed');
    }
    if (!tokenData.access_token) return redirect('/integrations.html?ads_error=exchange_failed');

    const accounts = await fetchAdAccounts(tokenData.access_token);

    // Vault key namespaced to the ads connection so it can never collide with the social one.
    const refKey = `aura/org-${organisationId}/linkedin_ads-oauth`;
    await storeSecret(db, refKey, {
        token: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? null,
    });

    const tokenExpiresAt = tokenData.expires_in
        ? new Date(Date.now() + Number(tokenData.expires_in) * 1000)
        : null;

    // ⚠️ Scoped to service_name = 'linkedin_ads'. Widening this to 'linkedin' would overwrite the
    // workspace's posting connection with an ads token that cannot post.
    const [existing] = await db.select({ id: systemConnections.id })
        .from(systemConnections)
        .where(and(
            eq(systemConnections.organisationId, organisationId),
            eq(systemConnections.serviceName, ADS_SERVICE_NAME),
        ))
        .limit(1);

    const metadata = {
        // null means "we could not ask", [] means "the member has none". Different messages.
        adAccounts: accounts,
        // Set later, when the user picks one. Until then nothing can be staged.
        selectedAccountUrn: null as string | null,
        tier: 'development',
    };

    if (existing) {
        await db.update(systemConnections).set({
            vaultRefKey: refKey, tokenExpiresAt, status: 'active', isActive: true,
            scopes: LINKEDIN_ADS_SCOPES, metadata, updatedAt: new Date(),
        }).where(eq(systemConnections.id, existing.id));
    } else {
        await db.insert(systemConnections).values({
            organisationId, userId, serviceName: ADS_SERVICE_NAME, connectionType: 'oauth',
            vaultRefKey: refKey, tokenExpiresAt, status: 'active', isActive: true,
            scopes: LINKEDIN_ADS_SCOPES, metadata,
        });
    }

    await db.insert(auditLogs).values({
        actionType: existing ? 'linkedin_ads_reconnected' : 'linkedin_ads_connected',
        resourceType: 'system_connections',
        resourceId: String(organisationId),
        newState: { organisationId, accountsFound: accounts?.length ?? null },
    });

    // Tell the user what actually happened. "Connected" alone, when we could not list their
    // accounts, sets them up to wonder why nothing works next.
    if (accounts === null) return redirect('/integrations.html?ads_connected=1&ads_accounts=unknown');
    if (accounts.length === 0) return redirect('/integrations.html?ads_connected=1&ads_accounts=none');
    return redirect('/integrations.html?ads_connected=1&ads_accounts=' + accounts.length);
});
