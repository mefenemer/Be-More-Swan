// netlify/functions/social-oauth-init.ts
// US-SMM-4.1.1: OAuth 2.0 initiation for LinkedIn and X (Twitter).
// GET ?platform=linkedin|x  — validates session, builds redirect URL with CSRF state.
// AC1.1.2: CSRF token stored server-side in vault with 10-minute TTL.
// AC1.1.3: LinkedIn uses minimum required scopes only.

import { Handler } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { getDb } from '../../db/client';
import { storeSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';

const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes

function buildState(payload: object): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export const handler: Handler = async (event) => {
    const platform = event.queryStringParameters?.platform;

    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };
    if (!['linkedin', 'x'].includes(platform ?? '')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Unknown platform' }) };
    }

    // Resolve the caller + their ACTIVE organisation from userOrganisations (never from a
    // JWT field — the session token carries activeOrganisationId, not organisationId; reading
    // the latter yielded `undefined`, which broke the callback's relevance/org scoping).
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) {
        return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=invalid_session' }, body: '' };
    }
    const { userId, organisationId } = ctx;

    // Bind this connection to the assistant it's being connected for (optional).
    const assistantId = event.queryStringParameters?.assistantId || '';

    const csrf = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + CSRF_TTL_MS;

    const callbackUri = `${baseUrl}/.netlify/functions/social-oauth-callback?platform=${platform}`;

    let authUrl: string;

    if (platform === 'linkedin') {
        const clientId = process.env.LINKEDIN_CLIENT_ID;
        if (!clientId) return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=not_configured&platform=linkedin' }, body: '' };

        // AC1.1.2: store CSRF state server-side with TTL
        const csrfKey = `oauth_csrf:${userId}:linkedin`;
        await storeSecret(db, csrfKey, { csrf, expiresAt, organisationId: String(organisationId), assistantId });

        // AC1.1.3: minimum required scopes only
        const scopes = 'r_organization_social,w_organization_social,r_basicprofile';
        // State carries only non-sensitive routing info; CSRF is validated server-side
        const state = buildState({ platform, userId: String(userId), csrf });
        authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUri)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    } else {
        // X OAuth 2.0 with PKCE
        const clientId = process.env.X_CLIENT_ID;
        if (!clientId) return { statusCode: 302, headers: { Location: '/workspace.html?oauth_error=not_configured&platform=x' }, body: '' };
        const codeVerifier = randomBytes(32).toString('base64url');
        const { createHash } = await import('crypto');
        const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

        // AC1.1.2: store CSRF state + PKCE verifier server-side with TTL
        const csrfKey = `oauth_csrf:${userId}:x`;
        await storeSecret(db, csrfKey, { csrf, expiresAt, organisationId: String(organisationId), codeVerifier, assistantId });

        const state = buildState({ platform, userId: String(userId), csrf });
        const scopes = 'tweet.read tweet.write users.read offline.access';
        authUrl = `https://twitter.com/i/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callbackUri)}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
        return { statusCode: 302, headers: { Location: authUrl }, body: '' };
    }

    return { statusCode: 302, headers: { Location: authUrl }, body: '' };
};
