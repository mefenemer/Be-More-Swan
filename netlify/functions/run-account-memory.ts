// netlify/functions/run-account-memory.ts
// On-demand HTTP trigger for the account-memory ingestion worker. Netlify runs scheduled functions
// ONLY on the production deploy, so staging (a branch deploy of `staging`) never fires the
// process-account-memory cron. This endpoint runs the SAME logic over HTTP.
// Mirrors run-discovery-jobs.ts / run-sequence-sends.ts.
//
// It is also the backfill lever: the worker is idempotent and bounded per tick, so POSTing this
// repeatedly walks the whole history forward without any cursor to manage.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset — this endpoint spends money at the embedding provider, so an open version is a cost hole.
//
// POST /.netlify/functions/run-account-memory  → 200 { ok, resolved, messages, outcomes }

import { withLambda } from '@netlify/aws-lambda-compat';
import { ingestAccountMemory } from './process-account-memory';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-account-memory] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await ingestAccountMemory();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-account-memory]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
