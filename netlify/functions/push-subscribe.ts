// netlify/functions/push-subscribe.ts
// The browser's end of the Web Push handshake.
//
//   GET    → { supported, publicKey }   the VAPID public key the browser needs to subscribe.
//                                       supported:false when the environment has no keys set,
//                                       which is how push stays dark until it is switched on.
//   POST   → { endpoint, keys: { p256dh, auth } }   register this device
//   DELETE → { endpoint }                           unregister this device
//
// ── Why upsert on endpoint ──────────────────────────────────────────────────────────────────────
// The browser hands back the SAME endpoint URL every time it is asked for a subscription on a
// device that already has one. Inserting blindly would add a row on every page load; keying on
// endpoint means re-registration is idempotent, which is what makes it safe for the client to
// re-subscribe on every load (and it must, because a browser can rotate a subscription silently).
//
// The user_id is taken from the session, never from the body — otherwise anyone could register a
// push endpoint against another user's account and receive their notifications.

import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { pushSubscriptions } from '../../db/schema';
import { isPushConfigured, vapidPublicKey } from '../../src/utils/web-push';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const jwtSecret = process.env.JWT_SECRET;

function getUserId(event: any): number | null {
    if (!jwtSecret) return null;
    const cookie = (event.headers?.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return null;
    try { return (jwt.verify(cookie, jwtSecret) as { userId: number }).userId; } catch { return null; }
}

/** Push endpoints are URLs on the browser vendor's push service. Anything else is not one. */
function validEndpoint(v: unknown): v is string {
    if (typeof v !== 'string' || v.length < 20 || v.length > 2000) return false;
    try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

export default withLambda(async (event) => {
    const method = event.httpMethod;

    // The public key is not user data — but gate it on a session anyway so the endpoint cannot be
    // used to fingerprint whether push is enabled on an environment.
    const userId = getUserId(event);
    if (!userId) return json(401, { error: 'Not authenticated.' });

    if (method === 'GET') {
        return json(200, { supported: isPushConfigured(), publicKey: vapidPublicKey() });
    }

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON.' }); }

    const db = getDb();

    if (method === 'DELETE') {
        const endpoint = body.endpoint;
        if (!validEndpoint(endpoint)) return json(400, { error: 'A valid endpoint is required.' });
        try {
            // Scoped to the caller's own rows: an endpoint is unguessable in practice, but
            // "unguessable" is not an authorisation model.
            await db.delete(pushSubscriptions).where(and(
                eq(pushSubscriptions.endpoint, endpoint),
                eq(pushSubscriptions.userId, userId),
            ));
            return json(200, { unsubscribed: true });
        } catch (err) {
            console.error('[push-subscribe] DELETE failed', err);
            return json(500, { error: 'Could not unsubscribe.' });
        }
    }

    if (method !== 'POST') return json(405, { error: 'Method Not Allowed' });

    if (!isPushConfigured()) {
        // Storing a subscription we cannot ever send to would leave the UI showing "push is on"
        // against a channel that silently delivers nothing.
        return json(503, { error: 'Push notifications are not configured on this environment.' });
    }

    const endpoint = body.endpoint;
    const keys = (body.keys && typeof body.keys === 'object' ? body.keys : {}) as Record<string, unknown>;
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh : '';
    const auth = typeof keys.auth === 'string' ? keys.auth : '';
    if (!validEndpoint(endpoint)) return json(400, { error: 'A valid endpoint is required.' });
    if (!p256dh || !auth) return json(400, { error: 'Subscription keys are required.' });

    const userAgent = String(event.headers?.['user-agent'] || '').slice(0, 500) || null;

    try {
        await db.insert(pushSubscriptions)
            .values({ userId, endpoint, p256dh, auth, userAgent })
            .onConflictDoUpdate({
                target: pushSubscriptions.endpoint,
                set: {
                    // The user_id is re-set deliberately: a shared device where a second person
                    // logs in produces the same endpoint, and the notifications must follow the
                    // account that most recently subscribed rather than the first one.
                    userId,
                    p256dh,
                    auth,
                    userAgent,
                    // Clear the tombstone — a re-subscribe revives a row we had retired.
                    expiredAt: null,
                    failureCount: 0,
                    updatedAt: new Date(),
                },
            });
        return json(200, { subscribed: true });
    } catch (err) {
        console.error('[push-subscribe] POST failed (is db/push-notifications.sql applied?)', err);
        return json(500, { error: 'Could not save the subscription.' });
    }
});
