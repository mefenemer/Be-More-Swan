// netlify/functions/meeting-import-background.ts — write up one picked-up meeting (src/utils/meeting-pickup.ts
// writeImport): fetch the platform's transcript, write the minutes, file them in the Inbox waiting for approval, and
// spend 1 task after it is filed. Woken by meeting-pickup.ts every 15 minutes.
//
// A background function (15-minute limit): fetching a long transcript plus the model call can pass the 26 s a
// synchronous function gets. writeImport never leaves the meeting claimed: every path releases it.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { deleteBotMediaForImport } from '../../src/utils/meeting-bot-db';
import { endedWithoutMinutes, writeImport } from '../../src/utils/meeting-pickup';
import { writerDeps } from '../../src/utils/meeting-pickup-db';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Fails CLOSED: an open endpoint would let anyone make us read meeting transcripts and spend AI calls.
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[meeting-import-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    let importId = 0;
    try { importId = Number(JSON.parse(event.body || '{}').importId); } catch { /* handled below */ }
    if (!Number.isInteger(importId) || importId <= 0) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'importId required.' }) };

    const db = getDb();
    const outcome = await writeImport(importId, writerDeps(db));
    // A bot meeting with no minutes (skipped or failed for good): Recall's copy goes now, as it does once minutes are
    // filed (chargeBotMeeting), not at the next 15-minute sweep. A picked-up meeting has no bot, so this does nothing.
    if (endedWithoutMinutes(outcome)) await deleteBotMediaForImport(db, importId);
    // The outcome only: never a title, a name or a word of the transcript in the logs.
    console.log('[meeting-import-background]', { importId, outcome });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
});
