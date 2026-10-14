// netlify/functions/run-site-audit-dispatch.ts
// On-demand HTTP trigger for the Mystery Shopper's daily dispatch (dispatch-site-audits.ts). Netlify
// runs scheduled functions ONLY on the production deploy, so staging needs this wrapper, poked by
// .github/workflows/staging-crons.yml. Mirrors run-lead-sweeps.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset — each queued check can spend a tenant's task.
//
// POST /.netlify/functions/run-site-audit-dispatch → 200 { ok, considered, due, queued, … } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueSiteAudits } from '../../src/utils/site-audit-schedule';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-site-audit-dispatch] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await dispatchDueSiteAudits(getDb());
        console.log('[run-site-audit-dispatch]', JSON.stringify(result));
        // A check that could not be STARTED is a fault the workflow should show — return 500 so the
        // endpoint is not stamped as done and is retried on the next tick.
        return { statusCode: result.failedToStart ? 500 : 200, body: JSON.stringify({ ok: !result.failedToStart, ...result }) };
    } catch (err) {
        console.error('[run-site-audit-dispatch] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
