// netlify/functions/meta-callbacks.ts
// Meta Platform compliance callbacks for the Threads app (Platform Terms 3(d)(i)).
//
// Routed via netlify.toml rewrites so the public URLs are:
//   POST /api/meta/threads/uninstall  → user deauthorized the app → drop the grant
//   POST /api/meta/threads/delete     → user requested data deletion → drop the grant + issue a receipt
//   GET  /api/meta/deletion-status    → ?code=… human-readable status page Meta links the user to
//
// These are the two URLs configured on the Threads use case Settings screen
// (Uninstall Callback URL / Delete Callback URL). Meta calls them server-to-server with
// NO session and NO bearer token — the only authentication is the signed_request HMAC,
// so verifySignedRequest is the whole security boundary. Never trust the payload before it.
//
// ── Threads app dashboard setup (developers.facebook.com → the THREADS_CLIENT_ID app) ──
// Use case "Access the Threads API" → Settings. ALL FOUR fields below must be filled or the
// form refuses to save with a generic "Form can't be saved" error (the two callback URLs are
// required, not optional). This is a SEPARATE app from the Facebook/Instagram one, with its own
// whitelist — which is why FB/IG can work while Threads is blocked.
//   Redirect Callback URLs : https://bemoreswan.com/api/oauth/threads/callback
//                            https://staging--bemoreswan.netlify.app/api/oauth/threads/callback
//                            (clean paths, no query string; the OAuth redirect is built in
//                             oauth-integrations.ts as `${baseUrl}/api/oauth/threads/callback`)
//   Uninstall Callback URL : https://bemoreswan.com/api/meta/threads/uninstall
//   Delete Callback URL    : https://bemoreswan.com/api/meta/threads/delete
// Client OAuth Login + Web OAuth Login must both be ON. Meta accepts only ONE value each for the
// uninstall/delete callbacks, so they point at prod (staging rides the same handlers if needed).
//
// Meta posts application/x-www-form-urlencoded with a single `signed_request` field:
//   <base64url(HMAC-SHA256(payload, APP_SECRET))>.<base64url(JSON payload)>
// The payload's `user_id` is the Threads user id, which is exactly what the OAuth callback
// persisted as workspace_integrations.tenant_id — that column is the join back to the org.
//
// Scope note: this deletes the THREADS CONNECTION, not the user's Be More Swan account.
// Meta's requirement is that we delete the data obtained via their platform; the customer's
// own workspace, posts and billing are unrelated to their Threads grant and stay put.

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceIntegrations } from '../../db/schema';
import { storeSecret, getSecret } from '../../src/utils/vault';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { deleteIntegration } from '../../src/utils/workspace-integrations';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Meta only ever links a user to a status page; keep the receipt long enough to be useful. */
const RECEIPT_TTL_DAYS = 90;

function receiptKey(code: string) {
    return `meta:deletion:${code}`;
}

/** base64url → Buffer. Meta pads with neither '=' nor the standard +/ alphabet. */
function b64url(input: string): Buffer {
    return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface SignedRequestPayload {
    user_id?: string;
    algorithm?: string;
    issued_at?: number;
}

/**
 * Verify and decode Meta's signed_request. Returns null on ANY failure — a bad signature,
 * a missing secret, or an unexpected algorithm are all indistinguishable from an attacker
 * poking the endpoint, so they get the same silent rejection.
 */
function verifySignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload | null {
    const [sigPart, payloadPart] = signedRequest.split('.', 2);
    if (!sigPart || !payloadPart) return null;

    let payload: SignedRequestPayload;
    try {
        payload = JSON.parse(b64url(payloadPart).toString('utf8'));
    } catch {
        return null;
    }

    // Meta has only ever used HMAC-SHA256 here, but the field is attacker-controlled —
    // refuse anything else rather than letting a future "none" algorithm through.
    if (payload.algorithm && payload.algorithm.toUpperCase() !== 'HMAC-SHA256') return null;

    const expected = createHmac('sha256', appSecret).update(payloadPart).digest();
    const actual = b64url(sigPart);
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    return payload;
}

/**
 * Read the signed_request out of the POST body, whether Meta sent it form-encoded
 * (the documented behaviour) or as JSON, and whether or not Netlify base64'd the body.
 */
function readSignedRequest(event: { body?: string | null; isBase64Encoded?: boolean }): string | null {
    const raw = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '');
    if (!raw) return null;

    if (raw.trimStart().startsWith('{')) {
        try {
            const parsed: { signed_request?: string } = JSON.parse(raw);
            return parsed.signed_request ?? null;
        } catch {
            return null;
        }
    }
    return new URLSearchParams(raw).get('signed_request');
}

/**
 * Drop every Threads grant belonging to the given Threads user id. tenant_id is not unique
 * across orgs — the same Threads account could in principle have been connected to two
 * workspaces — so this revokes all of them, which is what a deauthorization means.
 */
async function revokeThreadsGrants(threadsUserId: string): Promise<number> {
    const db = getDb();
    const rows = await db
        .select({ organisationId: workspaceIntegrations.organisationId })
        .from(workspaceIntegrations)
        .where(and(
            eq(workspaceIntegrations.provider, 'threads'),
            eq(workspaceIntegrations.tenantId, threadsUserId),
        ));

    // deleteIntegration removes the vault secret as well as the row — going through it
    // rather than a bare DELETE is what stops the encrypted tokens being orphaned.
    for (const row of rows) {
        await deleteIntegration(db, row.organisationId, 'threads');
    }
    return rows.length;
}

function html(statusCode: number, body: string) {
    return {
        statusCode,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body,
    };
}

function json(statusCode: number, body: unknown) {
    return {
        statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

export default withLambda(async (event) => {
    const baseUrl = resolveBaseUrl(event.headers);
    if (!baseUrl) return json(500, { error: 'Server misconfigured.' });

    let path = '';
    try {
        path = new URL(event.rawUrl).pathname;
    } catch { /* direct invocation — fall through to the action query param */ }
    const action = path.match(/\/api\/meta\/(?:threads\/)?([a-z-]+)\/?$/i)?.[1]
        ?? (event.queryStringParameters?.action ?? '');

    // ── STATUS: the page Meta links the user to after a deletion request ──────────
    if (action === 'deletion-status') {
        const code = event.queryStringParameters?.code ?? '';
        const receipt = code ? await getSecret(getDb(), receiptKey(code)) : null;
        if (!receipt) {
            return html(404, `<!doctype html><meta charset="utf-8"><title>Deletion status</title>
<h1>Unknown confirmation code</h1>
<p>We have no record of this deletion request. Codes expire ${RECEIPT_TTL_DAYS} days after the request.</p>`);
        }
        return html(200, `<!doctype html><meta charset="utf-8"><title>Deletion status</title>
<h1>Data deletion complete</h1>
<p>Confirmation code: <code>${code.replace(/[^a-f0-9]/gi, '')}</code></p>
<p>Your Threads connection to Be More Swan was removed on ${String(receipt.completedAt ?? '')}, along with the
access tokens it held. No further Threads data is retained.</p>`);
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (action !== 'uninstall' && action !== 'delete') return json(404, { error: 'Unknown callback.' });

    const appSecret = process.env.THREADS_CLIENT_SECRET;
    if (!appSecret) {
        console.error('[meta-callbacks] THREADS_CLIENT_SECRET is not set — cannot verify signed_request');
        return json(500, { error: 'Server misconfigured.' });
    }

    const signedRequest = readSignedRequest(event);
    if (!signedRequest) return json(400, { error: 'Missing signed_request.' });

    const payload = verifySignedRequest(signedRequest, appSecret);
    if (!payload?.user_id) {
        console.warn('[meta-callbacks] rejected an unverifiable signed_request');
        return json(400, { error: 'Invalid signed_request.' });
    }

    const revoked = await revokeThreadsGrants(payload.user_id);
    console.log(`[meta-callbacks] ${action}: revoked ${revoked} Threads grant(s)`);

    // Uninstall expects nothing but a 200; Meta does not read the body.
    if (action === 'uninstall') return json(200, { ok: true });

    // Deletion expects exactly this shape — Meta shows `url` to the user and stores
    // `confirmation_code` for audit. Both fields are mandatory; omitting either fails review.
    const confirmationCode = randomBytes(12).toString('hex');
    await storeSecret(getDb(), receiptKey(confirmationCode), {
        threadsUserId: payload.user_id,
        revoked,
        completedAt: new Date().toISOString(),
    });

    return json(200, {
        url: `${baseUrl}/api/meta/deletion-status?code=${confirmationCode}`,
        confirmation_code: confirmationCode,
    });
});
