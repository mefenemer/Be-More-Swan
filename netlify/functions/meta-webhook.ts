// netlify/functions/meta-webhook.ts
// Meta's webhook for Facebook Page + Instagram messages (docs/meta-messages-plan.md, Phase 1).
// Public, called by Meta server-to-server with no session.
//
//   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → echo the challenge (dashboard setup)
//   POST (Meta's JSON, signed X-Hub-Signature-256)                → store each message, answer 200
//
// ── Meta dashboard setup (the Facebook/Instagram app, META_APP_ID) ──
//   Webhooks → Page:      callback https://bemoreswan.com/.netlify/functions/meta-webhook,
//                         verify token = META_WEBHOOK_VERIFY_TOKEN, fields: messages,
//                         messaging_postbacks, message_echoes
//   Webhooks → Instagram: same callback + token, field: messages (and messaging_postbacks)
//   Staging uses its own URL (https://staging--bemoreswan.netlify.app/.netlify/functions/meta-webhook)
//   only if staging is pointed at a separate app — one app has one callback per object.
// Each Page is then subscribed on connect (meta-oauth.ts → subscribePageToMessages).
//
// ⚠️ The signature is the whole security boundary: nothing in the body is trusted before it.
// ⚠️ Answer fast and never call a model here — Meta retries slow or failed deliveries and switches
//    the subscription off after enough failures. Every write is idempotent on Meta's message id.
// ⚠️ Nothing here sends a message.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { parseMessagingWebhook, storeMessagingEvent, verifyMetaSignature } from '../../src/utils/meta-messaging';

const ok = { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: 'EVENT_RECEIVED' };

export default withLambda(async (event) => {
    // ── Verification handshake ─────────────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        const q = event.queryStringParameters ?? {};
        const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;
        if (expected && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === expected && q['hub.challenge']) {
            return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: String(q['hub.challenge']) };
        }
        return { statusCode: 403, body: 'Forbidden' };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Exact bytes Meta signed: decode base64 to a Buffer, never via a re-serialised object.
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64') : Buffer.from(event.body ?? '', 'utf8');
    const sig = event.headers['x-hub-signature-256'] ?? event.headers['X-Hub-Signature-256'];
    if (!verifyMetaSignature(raw, sig, process.env.META_APP_SECRET)) {
        console.warn('[meta-webhook] signature check failed');
        return { statusCode: 401, body: 'Bad signature' };
    }

    let body: unknown;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return { statusCode: 400, body: 'Bad JSON' }; }

    const messages = parseMessagingWebhook(body);
    if (messages.length === 0) return ok;

    const db = getDb();
    for (const m of messages) {
        try {
            const res = await storeMessagingEvent(db, m);
            if (!res.stored && (res.reason === 'unknown_account' || res.reason === 'ambiguous_account')) {
                // Ids only — never the message text.
                console.warn(`[meta-webhook] ${res.reason}: ${m.platform} ${m.accountId}`);
            }
        } catch (err: any) {
            // Table not created yet on this database (db/z-social-messages.sql not applied): a 500
            // would make Meta retry forever and then switch the subscription off. Drop and say so.
            if (err?.code === '42P01') {
                console.error('[meta-webhook] social_messages tables missing — apply db/z-social-messages.sql');
                return ok;
            }
            console.error('[meta-webhook] store failed', err?.message ?? err);
            // Anything else: let Meta retry. Already-stored messages dedupe on mid.
            return { statusCode: 500, body: 'Retry' };
        }
    }
    return ok;
});
