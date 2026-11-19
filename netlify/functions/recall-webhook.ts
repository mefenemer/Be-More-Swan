// netlify/functions/recall-webhook.ts — Recall.ai's events for the Note Taker's bots (docs/note-taker-bot-plan.md §4).
//
// Recall signs every request (meeting-bot.ts verifyRecallSignature): one workspace secret per region,
// RECALL_EU_WEBHOOK_SECRET and RECALL_US_WEBHOOK_SECRET (Recall dashboard → Developers → API Keys & Secrets). A request
// signed by neither is refused, and with no secret set the endpoint refuses everything (fails closed).
//
// Only bot.* status events matter: each moves our bot on (applyBotEvent); 'done' after being in the call hands the
// transcript to the meeting writer. Answers 2xx fast (Recall's limit is 15 s, retried for 24 hours on anything else);
// an event for a bot we don't know is acknowledged and ignored. The 15-minute poll (meeting-pickup.ts) catches any event
// that never arrives. Logs ids and codes only, never names or meeting text.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { verifyRecallSignature, type RecallRegion } from '../../src/utils/meeting-bot';
import { applyBotEvent, loadBotByRecallId } from '../../src/utils/meeting-bot-db';
import { triggerMeetingImport } from '../../src/utils/meeting-pickup-db';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

    const secrets: Partial<Record<RecallRegion, string>> = {
        eu: process.env.RECALL_EU_WEBHOOK_SECRET || undefined,
        us: process.env.RECALL_US_WEBHOOK_SECRET || undefined,
    };
    if (!secrets.eu && !secrets.us) {
        console.warn('[recall-webhook] no RECALL_*_WEBHOOK_SECRET set — refusing.');
        return json(503, { error: 'Not configured.' });
    }

    // The signature is over the exact bytes Recall sent.
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v ?? undefined;
    const region = verifyRecallSignature(secrets, headers, raw);
    if (!region) return json(401, { error: 'Bad signature.' });

    let payload: { event?: unknown; data?: { data?: { code?: unknown; sub_code?: unknown; updated_at?: unknown }; bot?: { id?: unknown } } };
    try { payload = JSON.parse(raw); } catch { return json(400, { error: 'Invalid JSON.' }); }

    const name = typeof payload.event === 'string' ? payload.event : '';
    if (!name.startsWith('bot.')) return json(200, { ok: true, ignored: true });
    const recallBotId = typeof payload.data?.bot?.id === 'string' ? payload.data.bot.id : null;
    const code = typeof payload.data?.data?.code === 'string' ? payload.data.data.code : name.slice(4);
    const subCode = typeof payload.data?.data?.sub_code === 'string' ? payload.data.data.sub_code : null;
    const updatedAt = typeof payload.data?.data?.updated_at === 'string' ? new Date(payload.data.data.updated_at) : new Date();
    const at = Number.isNaN(updatedAt.getTime()) ? new Date() : updatedAt;
    if (!recallBotId) return json(200, { ok: true, ignored: true });

    const db = getDb();
    try {
        const row = await loadBotByRecallId(db, region, recallBotId);
        if (!row) return json(200, { ok: true, ignored: true });
        const status = await applyBotEvent(db, row, code, subCode, at, triggerMeetingImport);
        console.log('[recall-webhook]', { botId: row.id, code, status });
        return json(200, { ok: true });
    } catch (err) {
        // A 5xx makes Recall retry, which is what we want when the database blinked.
        console.error('[recall-webhook] failed', { recallBotId, code, err: err instanceof Error ? err.message : err });
        return json(500, { error: 'Could not record the event.' });
    }
});
