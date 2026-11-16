// netlify/functions/run-lead-watch-dispatch.ts
// On-demand HTTP trigger for the Watch list's daily check (dispatch-lead-watch.ts). Netlify runs scheduled
// functions ONLY on production, so staging needs this wrapper, poked by .github/workflows/staging-crons.yml.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when unset.

import { withLambda } from '@netlify/aws-lambda-compat';
import { startBackground } from '../../src/utils/lead-watch';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    const result = await startBackground('run-lead-watch-background', event.headers as Record<string, string | undefined>);
    console.log('[run-lead-watch-dispatch]', JSON.stringify(result));
    return { statusCode: result.started ? 200 : 500, body: JSON.stringify({ ok: result.started, ...result }) };
});
