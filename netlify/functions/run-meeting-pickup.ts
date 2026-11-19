// netlify/functions/run-meeting-pickup.ts
// On-demand HTTP trigger for the 15-minute meeting pick-up (meeting-pickup.ts), for staging-crons.yml: Netlify answers
// a URL call to a scheduled function with a bare 403, so staging needs this plain twin (same split as
// run-poll-mailboxes.ts).
//
// AUTH: CRON_TRIGGER_SECRET as `Authorization: Bearer <secret>`; refuses to run when unset (fail closed).
//
// POST /.netlify/functions/run-meeting-pickup → 200 { ok: true, accounts, found, due, dispatched, errors }

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runMeetingPickup } from '../../src/utils/meeting-pickup-db';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-meeting-pickup] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await runMeetingPickup(getDb());
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[run-meeting-pickup]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
