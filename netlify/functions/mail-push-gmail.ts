// netlify/functions/mail-push-gmail.ts — Pub/Sub's push when a connected Gmail inbox changes
// (docs/email-assistant-plan.md §4.2, Phase 3b). Google publishes `{ emailAddress, historyId }` to our topic
// (users.watch, started by src/utils/mailbox-push.ts); the push subscription POSTs it here with an OIDC token.
//
// POST only. 401 without a valid token from OUR subscription's service account (verifyPubSubToken).
// Otherwise ALWAYS 200 with a body, even for an address we don't know: Pub/Sub retries anything that
// isn't 2xx, and a 204 under withLambda became a 502 (withlambda-204-body-502).
//
// ⚠️ Logs mailbox ids and counts only, never the address.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { gmailMailboxIdsFor, parsePubSubPush, pushConfigured, recordPush, verifyPubSubToken } from '../../src/utils/mailbox-push';

const ok = (extra: Record<string, unknown> = {}) => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...extra }) });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    // Not set up on this site: acknowledge so Pub/Sub stops retrying, do nothing.
    if (!pushConfigured('gmail')) return ok({ ignored: 'not_configured' });
    const auth = event.headers['authorization'] || event.headers['Authorization'];
    if (!(await verifyPubSubToken(auth))) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    let body: unknown = null;
    try { body = JSON.parse(event.body || 'null'); } catch { /* bad body: acknowledged below */ }
    const push = parsePubSubPush(body);
    if (!push) return ok({ ignored: 'bad_body' });

    try {
        const db = getDb();
        const ids = await gmailMailboxIdsFor(db, push.emailAddress);
        const r = await recordPush(db, ids);
        console.log('[mail-push-gmail]', { mailboxIds: ids, ...r });
        return ok();
    } catch (err) {
        // A DB hiccup: let Pub/Sub retry (it backs off). The 30-minute poll is the backstop either way.
        console.error('[mail-push-gmail]', err instanceof Error ? err.message : err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
