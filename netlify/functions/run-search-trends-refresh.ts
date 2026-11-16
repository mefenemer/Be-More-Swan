// netlify/functions/run-search-trends-refresh.ts
// On-demand HTTP trigger for the Google Trends engine's hourly tick (refresh-search-trends.ts).
// Netlify runs scheduled functions ONLY on the production deploy, so staging needs this wrapper,
// poked by .github/workflows/staging-crons.yml. Mirrors run-site-directory-dispatch.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed.
//
// POST /.netlify/functions/run-search-trends-refresh → 200 { ok, woke, reason } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { dispatchSearchTrends } from '../../src/utils/search-trends';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-search-trends-refresh] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await dispatchSearchTrends(getDb(), resolveBaseUrl(event.headers), secret);
        console.log('[run-search-trends-refresh]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[run-search-trends-refresh] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
