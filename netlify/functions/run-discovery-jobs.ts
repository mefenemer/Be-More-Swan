// netlify/functions/run-discovery-jobs.ts
// On-demand HTTP trigger for the discovery pipeline. Netlify runs scheduled functions ONLY
// on the production deploy, so staging (a branch deploy) never fires the discovery crons.
// This endpoint runs the SAME dispatch + drain logic over HTTP so staging behaves like prod.
// Mirrors run-content-jobs.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed
// when the secret is unset so it can never be an open, cost-incurring endpoint.
//
// POST /.netlify/functions/run-discovery-jobs  → 200 { ok, enqueued, processed }

import { Handler } from '@netlify/functions';
import { dispatchDueRuns } from './dispatch-discovery-runs';
import { drainDiscoveryJobs } from './process-discovery-jobs';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-discovery-jobs] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const enqueued = await dispatchDueRuns();
        const processed = await drainDiscoveryJobs();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, enqueued, processed }),
        };
    } catch (err) {
        console.error('[run-discovery-jobs]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
};
