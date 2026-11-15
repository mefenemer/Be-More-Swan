// netlify/functions/run-trigger-poll-dispatch.ts
// On-demand HTTP trigger for the buying triggers' daily poll (dispatch-trigger-polls.ts). Netlify runs
// scheduled functions ONLY on the production deploy, so staging needs this wrapper, poked by
// .github/workflows/staging-crons.yml. Mirrors run-discussion-scan-dispatch.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when unset.
//
// POST /.netlify/functions/run-trigger-poll-dispatch → 200 { ok, started } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { startTriggerPoll } from '../../src/utils/trigger-engine';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-trigger-poll-dispatch] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    const result = await startTriggerPoll(event.headers as Record<string, string | undefined>);
    console.log('[run-trigger-poll-dispatch]', JSON.stringify(result));
    return { statusCode: result.started ? 200 : 500, body: JSON.stringify({ ok: result.started, ...result }) };
});
