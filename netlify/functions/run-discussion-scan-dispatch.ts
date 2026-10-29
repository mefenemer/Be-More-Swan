// netlify/functions/run-discussion-scan-dispatch.ts
// On-demand HTTP trigger for the Discussions daily scan (dispatch-discussion-scans.ts). Netlify runs
// scheduled functions ONLY on the production deploy, so staging needs this wrapper, poked by
// .github/workflows/staging-crons.yml. Mirrors run-site-audit-dispatch.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset — each scan spends a tenant's task.
//
// POST /.netlify/functions/run-discussion-scan-dispatch → 200 { ok, considered, queued, … } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueScans } from '../../src/utils/discussions';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-discussion-scan-dispatch] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await dispatchDueScans(getDb());
        console.log('[run-discussion-scan-dispatch]', JSON.stringify(result));
        return { statusCode: result.failedToStart ? 500 : 200, body: JSON.stringify({ ok: !result.failedToStart, ...result }) };
    } catch (err) {
        console.error('[run-discussion-scan-dispatch] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
