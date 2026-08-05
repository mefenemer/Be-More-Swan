// netlify/functions/meta-callbacks.ts
// Meta Platform compliance callbacks (Platform Terms 3(d)(i)) for BOTH Meta apps we operate:
// the Threads app and the Facebook/Instagram app. They are separate apps with separate secrets,
// so the route decides which secret verifies the request and which grants get revoked.
//
// Routed via netlify.toml rewrites so the public URLs are:
//   POST /api/meta/threads/uninstall   → user deauthorized the Threads app  → drop the grant
//   POST /api/meta/threads/delete      → Threads data deletion request      → drop the grant + receipt
//   POST /api/meta/facebook/uninstall  → user removed the FB/IG app         → revoke the connections
//   POST /api/meta/facebook/delete     → FB/IG data deletion request        → revoke + receipt
//   GET  /api/meta/deletion-status     → ?code=… human-readable status page Meta links the user to
//
// An /api/meta/{uninstall,delete} with no app segment is treated as Threads — that is the shape
// registered on the Threads dashboard before the Facebook routes existed, and it must keep working.
//
// Meta calls these server-to-server with NO session and NO bearer token — the only authentication
// is the signed_request HMAC, so verifySignedRequest is the whole security boundary. Never trust
// the payload before it. Each app signs with its OWN secret: verifying a Facebook callback against
// THREADS_CLIENT_SECRET fails the HMAC and 400s, which is exactly the bug this file used to have.
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
// ── Facebook/Instagram app dashboard setup (the META_APP_ID app) ──────────────────────────────
//   Settings → Basic → "User data deletion" → Data Deletion Request URL:
//                            https://bemoreswan.com/api/meta/facebook/delete
//   Facebook Login → Settings → Deauthorize Callback URL:
//                            https://bemoreswan.com/api/meta/facebook/uninstall
// The human-readable alternative Meta offers for that first field is data-deletion.html; we
// register the callback instead because it actually revokes, and link the page from the policy.
//
// Meta posts application/x-www-form-urlencoded with a single `signed_request` field:
//   <base64url(HMAC-SHA256(payload, APP_SECRET))>.<base64url(JSON payload)>
// The payload's `user_id` is the Threads user id, which is exactly what the OAuth callback
// persisted as workspace_integrations.tenant_id — that column is the join back to the org.
//
// Scope note: this deletes the PLATFORM CONNECTION, not the user's Be More Swan account.
// Meta's requirement is that we delete the data obtained via their platform; the customer's
// own workspace, posts and billing are unrelated to their Meta grant and stay put.

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceIntegrations, systemConnections, postInsights, webhookEvents } from '../../db/schema';
import { storeSecret, getSecret, deleteSecret } from '../../src/utils/vault';
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

/**
 * Drop every Facebook/Instagram connection belonging to the given Facebook app-scoped user id.
 *
 * The join is on metadata->>'fbUserId', NOT external_user_id: the latter holds a Page id
 * (facebook) or an Instagram business account id (instagram), and Meta's callback only ever
 * sends the app-scoped id of the PERSON. meta-oauth.ts captures it at connect time for exactly
 * this lookup — rows written before that landed have no fbUserId and cannot be matched here,
 * which is a silent no-op rather than a wrong deletion (see the unmatched-callback warning below).
 *
 * Both products are revoked together: one Meta grant backs both, so a person removing the app
 * has withdrawn consent for both regardless of which one the callback names.
 *
 * `mode` is the whole difference between Meta's two callbacks, and they are NOT the same request:
 *
 *   'revoke' (uninstall) — the person removed the app. Authorisation is withdrawn, so the token
 *       goes and the connection stops being usable, but the row survives in a revoked state. That
 *       keeps the reconnect path and the publishing history intelligible.
 *   'erase'  (delete)    — the person made a formal data-deletion request. The row itself goes,
 *       along with the data we obtained THROUGH Meta: the account identifiers it carries
 *       (external_user_id = Page / IG business account id), the cached follower counts and
 *       fbUserId in metadata, the per-post insight counters, and the raw inbound webhook payloads.
 *
 * Before 2026-08-05 both actions took the 'revoke' path, so a deletion request left every
 * identifier in place while /api/meta/deletion-status told the person nothing was retained.
 *
 * What 'erase' deliberately keeps:
 *   • scheduled_posts — the customer's OWN content and publishing record, not Meta's data. Its
 *     connection_id FK is ON DELETE SET NULL, so the posts survive the row going.
 *   • integration_api_calls — operational audit; already self-purges at 90 days (content-retention).
 *   • audit_logs / gdpr_erasure_log — append-only by DDL (db/audit-log-immutability.sql); a DELETE
 *     against them raises. Never add them here.
 */
async function revokeMetaConnections(fbUserId: string, mode: 'revoke' | 'erase'): Promise<number> {
    const db = getDb();
    const rows = await db
        .select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey })
        .from(systemConnections)
        .where(and(
            inArray(systemConnections.serviceName, ['facebook', 'instagram']),
            sql`${systemConnections.metadata}->>'fbUserId' = ${fbUserId}`,
        ));

    // Each product stores its own vault ref (aura/org-<id>/<service>-token), so deleting per row
    // never strips the other product's token.
    for (const row of rows) {
        if (row.vaultRefKey) await deleteSecret(db, row.vaultRefKey);
    }

    if (rows.length === 0) return 0;
    const ids = rows.map(r => r.id);

    if (mode === 'revoke') {
        await db
            .update(systemConnections)
            .set({ status: 'revoked', isActive: false, vaultRefKey: null, updatedAt: new Date() })
            .where(inArray(systemConnections.id, ids));
        return rows.length;
    }

    // Children first: both FKs are ON DELETE SET NULL, so dropping the connection row would
    // otherwise orphan Meta-derived data rather than remove it.
    await db.delete(postInsights).where(inArray(postInsights.connectionId, ids));
    await db.delete(webhookEvents).where(inArray(webhookEvents.connectionId, ids));
    await db.delete(systemConnections).where(inArray(systemConnections.id, ids));

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
    // The optional app segment picks the secret and the revoke target. Absent → 'threads', which
    // preserves the /api/meta/{uninstall,delete} shape already registered on the Threads dashboard.
    const routeMatch = path.match(/\/api\/meta\/(?:(threads|facebook)\/)?([a-z-]+)\/?$/i);
    const app: 'threads' | 'facebook' =
        (routeMatch?.[1]?.toLowerCase() as 'threads' | 'facebook' | undefined)
        ?? (event.queryStringParameters?.app === 'facebook' ? 'facebook' : 'threads');
    const action = routeMatch?.[2] ?? (event.queryStringParameters?.action ?? '');

    // ── STATUS: the page Meta links the user to after a deletion request ──────────
    if (action === 'deletion-status') {
        const code = event.queryStringParameters?.code ?? '';
        const receipt = code ? await getSecret(getDb(), receiptKey(code)) : null;
        if (!receipt) {
            return html(404, `<!doctype html><meta charset="utf-8"><title>Deletion status</title>
<h1>Unknown confirmation code</h1>
<p>We have no record of this deletion request. Codes expire ${RECEIPT_TTL_DAYS} days after the request.</p>`);
        }
        // The receipt records which app the request came from; rows written before that was stored
        // are Threads by definition, since it was the only app with a callback at the time.
        const label = receipt.app === 'facebook' ? 'Facebook and Instagram' : 'Threads';
        return html(200, `<!doctype html><meta charset="utf-8"><title>Deletion status</title>
<h1>Data deletion complete</h1>
<p>Confirmation code: <code>${code.replace(/[^a-f0-9]/gi, '')}</code></p>
<p>Your ${label} connection to Be More Swan was deleted on ${String(receipt.completedAt ?? '')}. This removed the
access tokens it held, the account identifiers we obtained from ${label}, the follower and per-post figures we had
cached, and the event payloads ${label} had sent us.</p>
<p>Two things are not covered by this, because they are not ${label} data: posts already published to your
${label} account stay on ${label} and only you can remove them there, and any content drafted inside a Be More Swan
workspace belongs to that workspace. We also keep an immutable record that this deletion took place, which is what
lets us evidence it.</p>`);
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (action !== 'uninstall' && action !== 'delete') return json(404, { error: 'Unknown callback.' });

    // Each Meta app signs with its own secret. Selecting the wrong one is indistinguishable from a
    // forged request — it just fails the HMAC — so the route must decide this, never a default.
    const secretVar = app === 'facebook' ? 'META_APP_SECRET' : 'THREADS_CLIENT_SECRET';
    const appSecret = process.env[secretVar];
    if (!appSecret) {
        console.error(`[meta-callbacks] ${secretVar} is not set — cannot verify signed_request`);
        return json(500, { error: 'Server misconfigured.' });
    }

    const signedRequest = readSignedRequest(event);
    if (!signedRequest) return json(400, { error: 'Missing signed_request.' });

    const payload = verifySignedRequest(signedRequest, appSecret);
    if (!payload?.user_id) {
        console.warn(`[meta-callbacks] rejected an unverifiable signed_request for the ${app} app`);
        return json(400, { error: 'Invalid signed_request.' });
    }

    // 'delete' is a data-deletion request and must actually erase; 'uninstall' only withdraws
    // authorisation. revokeThreadsGrants already deletes its row either way — a Threads grant
    // carries no data beyond the token and the tenant id, so there is nothing to keep.
    const revoked = app === 'facebook'
        ? await revokeMetaConnections(payload.user_id, action === 'delete' ? 'erase' : 'revoke')
        : await revokeThreadsGrants(payload.user_id);
    console.log(`[meta-callbacks] ${app}/${action}: ${action === 'delete' ? 'erased' : 'revoked'} ${revoked} grant(s)`);

    // A verified callback that matches nothing means we hold data we cannot attribute — most
    // likely a connection made before meta-oauth.ts began storing fbUserId. Meta still gets its
    // 200 (the request was honoured as far as we can honour it), but this needs to be visible.
    if (revoked === 0) {
        console.warn(`[meta-callbacks] ${app}/${action}: verified callback matched NO rows for user ${payload.user_id}`);
    }

    // Uninstall expects nothing but a 200; Meta does not read the body.
    if (action === 'uninstall') return json(200, { ok: true });

    // Deletion expects exactly this shape — Meta shows `url` to the user and stores
    // `confirmation_code` for audit. Both fields are mandatory; omitting either fails review.
    const confirmationCode = randomBytes(12).toString('hex');
    await storeSecret(getDb(), receiptKey(confirmationCode), {
        app,
        metaUserId: payload.user_id,
        revoked,
        completedAt: new Date().toISOString(),
    });

    return json(200, {
        url: `${baseUrl}/api/meta/deletion-status?code=${confirmationCode}`,
        confirmation_code: confirmationCode,
    });
});
