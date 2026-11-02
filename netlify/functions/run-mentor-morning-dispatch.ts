// netlify/functions/run-mentor-morning-dispatch.ts
// On-demand HTTP trigger for the Business Mentor's morning summary dispatch (dispatch-mentor-mornings.ts).
// Netlify runs scheduled functions ONLY on the production deploy, so staging needs this wrapper, poked by
// .github/workflows/staging-crons.yml. Mirrors run-mentor-review-dispatch.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset — it sends messages and email to customers.
//
// POST /.netlify/functions/run-mentor-morning-dispatch → 200 { ok, considered, due, sent, empty, failed, ready } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchMornings } from '../../src/utils/mentor-morning';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-mentor-morning-dispatch] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await dispatchMornings(getDb());
        console.log('[run-mentor-morning-dispatch]', JSON.stringify(result));
        return { statusCode: result.failed ? 500 : 200, body: JSON.stringify({ ok: !result.failed, ...result }) };
    } catch (err) {
        console.error('[run-mentor-morning-dispatch] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
