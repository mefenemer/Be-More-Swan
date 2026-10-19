// netlify/functions/run-partner-sweep.ts
// On-demand HTTP trigger for partner-commission-sweep. Netlify runs scheduled functions ONLY on the
// production deploy, so staging (a branch deploy of `staging`) is poked from staging-crons.yml.
// Mirrors run-lead-sweeps.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset.
//
// POST /.netlify/functions/run-partner-sweep  → 200 { ok, released }

import { withLambda } from '@netlify/aws-lambda-compat';
import { sweepPartnerCommissions } from './partner-commission-sweep';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-partner-sweep] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await sweepPartnerCommissions();
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[run-partner-sweep] failed', err);
        return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
