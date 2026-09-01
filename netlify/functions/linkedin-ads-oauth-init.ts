// netlify/functions/linkedin-ads-oauth-init.ts
// GET — begins LinkedIn ADVERTISING authorisation. Separate from social-oauth-init.ts, deliberately.
//
// ── Why this is not another `platform` in social-oauth-init.ts ───────────────────────────────────
// That function authorises posting (`w_member_social`). This one authorises SPENDING
// (`rw_ads`, `r_ads_reporting`). Three reasons they stay apart:
//
//   1. ⚠️ ADDING ADS SCOPES TO THE SOCIAL CONNECTOR WOULD BREAK POSTING FOR EVERYONE. LinkedIn
//      refuses the ENTIRE authorization when an app requests a scope it does not hold — not the
//      offending scope, the whole request. That is exactly how production broke on 2026-07-20,
//      and the fix then was removing scopes. Our Advertising access is Development Tier and its
//      behaviour for arbitrary members is not something to discover on the live social connector.
//   2. Consent is not the same consent. Somebody connecting LinkedIn so their assistant can post
//      should not be asked, in the same breath, to let us spend money.
//   3. Blast radius. A bug here must not be able to disturb a working posting connection.
//
// ── Gated twice, like everything else in the paid rails ─────────────────────────────────────────
// Behind the `paid_ads` plan feature (off by absence). Without it this returns a refusal rather
// than an authorisation URL — because the adapter it feeds is Development Tier and registered for
// development only, so a workspace that connected an ad account here would have granted us
// permission we cannot yet act on. A control that asks for consent it cannot use is worse than no
// control.

import { randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { storeSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import { withLambda } from '@netlify/aws-lambda-compat';

const CSRF_TTL_MS = 10 * 60 * 1000;

/**
 * ⚠️ SPEND SCOPES. `rw_ads` can create and activate campaigns that cost real money;
 * `r_ads_reporting` reads their performance. Never add either to any other connector's scope
 * string — see the header.
 */
export const LINKEDIN_ADS_SCOPES = 'rw_ads r_ads_reporting';

/** The vault key holding this user's in-flight CSRF value. Namespaced away from the social flow. */
export const adsCsrfKey = (userId: number) => `oauth_csrf:${userId}:linkedin_ads`;

function buildState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) {
        return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=invalid_session' }, body: '' };
    }
    const { userId, organisationId } = ctx;

    // Gate 1: the commercial entitlement.
    if (!await hasFeatureByOrg(db, organisationId, PAID_ADS_FEATURE)) {
        return {
            statusCode: 302,
            headers: { Location: '/integrations.html?ads_error=not_available' },
            body: '',
        };
    }

    const clientId = process.env.LINKEDIN_CLIENT_ID;
    if (!clientId) {
        return { statusCode: 302, headers: { Location: '/integrations.html?ads_error=not_configured' }, body: '' };
    }

    const csrf = randomBytes(32).toString('hex');
    await storeSecret(db, adsCsrfKey(userId), {
        csrf,
        expiresAt: Date.now() + CSRF_TTL_MS,
        organisationId: String(organisationId),
    });

    // ⚠️ NO QUERY STRING. LinkedIn matches the registered callback as an exact string and its
    // portal is hostile to registering a URL with parameters — the lesson from 2026-07-20. Routing
    // information travels in `state`, which is validated server-side against the vault.
    //
    // ⚠️ THIS IS A NEW CALLBACK URL and must be registered in the LinkedIn app on BOTH hosts
    // (production and the staging branch deploy) before the flow will complete.
    const callbackUri = `${baseUrl}/.netlify/functions/linkedin-ads-oauth-callback`;
    const state = buildState({ flow: 'linkedin_ads', userId: String(userId), csrf });

    const authUrl = 'https://www.linkedin.com/oauth/v2/authorization'
        + '?response_type=code'
        + `&client_id=${clientId}`
        + `&redirect_uri=${encodeURIComponent(callbackUri)}`
        // Space-delimited per RFC 6749 §3.3 — a comma-joined list is rejected outright.
        + `&scope=${encodeURIComponent(LINKEDIN_ADS_SCOPES)}`
        + `&state=${state}`;

    return { statusCode: 302, headers: { Location: authUrl }, body: '' };
});
