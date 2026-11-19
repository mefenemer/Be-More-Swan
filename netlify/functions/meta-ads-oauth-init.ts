// netlify/functions/meta-ads-oauth-init.ts
// GET — begins Meta ADVERTISING authorisation. Separate from meta-oauth.ts (posting), deliberately,
// for the same three reasons as linkedin-ads-oauth-init.ts:
//
//   1. ⚠️ A permission the Meta app has not added fails the WHOLE login ("Invalid Scopes"). Ads
//      permissions in the posting login would put Facebook/Instagram publishing for every
//      customer one dashboard mistake away from breaking.
//   2. Consent to post is not consent to spend.
//   3. Blast radius: a bug here must not disturb a working posting connection.
//
// Same app (META_APP_ID) — Meta grants per permission, not per app — but its own callback, its own
// scopes (metaAdsScopes(), env-overridable), its own CSRF key and its own connection row.
//
// Gated on the `paid_ads` plan feature, like everything in the paid rails.
import { randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { storeSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import { metaAdsScopes } from '../../src/utils/meta-ads-connection';
import { metaAdsGraphVersion } from '../../src/utils/ad-networks/meta';
import { withLambda } from '@netlify/aws-lambda-compat';

const CSRF_TTL_MS = 10 * 60 * 1000;

/** In-flight CSRF value. Namespaced away from the posting flow and from LinkedIn ads. */
export const metaAdsCsrfKey = (userId: number) => `oauth_csrf:${userId}:meta_ads`;

/** ⚠️ Must be listed EXACTLY (no query string) in the Meta app's Valid OAuth Redirect URIs, per host. */
export const metaAdsCallbackPath = '/.netlify/functions/meta-ads-oauth-callback';

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl(event.headers as Record<string, string | undefined>);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    const db = getDb();
    // mutates: starting a connect binds an account to this org — refused while impersonating.
    const ctx = await requireTenant(event, db, { mutates: true });
    if ('error' in ctx) {
        return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=invalid_session' }, body: '' };
    }
    const { userId, organisationId } = ctx;

    if (!await hasFeatureByOrg(db, organisationId, PAID_ADS_FEATURE)) {
        return { statusCode: 302, headers: { Location: '/integrations.html?meta_ads_error=not_available' }, body: '' };
    }

    const appId = process.env.META_APP_ID;
    if (!appId) return { statusCode: 302, headers: { Location: '/integrations.html?meta_ads_error=not_configured' }, body: '' };

    const csrf = randomBytes(32).toString('hex');
    await storeSecret(db, metaAdsCsrfKey(userId), {
        csrf,
        expiresAt: Date.now() + CSRF_TTL_MS,
        organisationId: String(organisationId),
    });

    const state = Buffer.from(JSON.stringify({ flow: 'meta_ads', userId: String(userId), csrf })).toString('base64url');
    const callbackUri = `${baseUrl}${metaAdsCallbackPath}`;
    const authUrl = `https://www.facebook.com/${metaAdsGraphVersion()}/dialog/oauth`
        + `?client_id=${encodeURIComponent(appId)}`
        + `&redirect_uri=${encodeURIComponent(callbackUri)}`
        + `&scope=${encodeURIComponent(metaAdsScopes())}`
        + `&state=${state}`
        + '&response_type=code'
        // Re-asks for anything declined last time, rather than silently keeping the old grant.
        + '&auth_type=rerequest';

    return { statusCode: 302, headers: { Location: authUrl }, body: '' };
});
