// netlify/functions/run-content-jobs.ts
// On-demand HTTP trigger for the content-generation queue drain.
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging (a branch deploy) therefore never fires `process-content-jobs`,
// so `generate-post` queues jobs that nothing ever drains. This endpoint lets an external
// scheduler (see .github/workflows/staging-content-cron.yml) poke the SAME drain logic over HTTP
// so staging behaves like production.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses
// to run (fail closed) so it can never be an open, cost-incurring endpoint. Callers pass the secret
// as `Authorization: Bearer <secret>`.
//
// POST /.netlify/functions/run-content-jobs
//   → 200 { ok: true, processed: <n> }

import { Handler } from '@netlify/functions';
import { drainContentJobs } from './process-content-jobs';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-content-jobs] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const processed = await drainContentJobs();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, processed }),
        };
    } catch (err) {
        console.error('[run-content-jobs]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
};
