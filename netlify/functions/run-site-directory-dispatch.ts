// netlify/functions/run-site-directory-dispatch.ts
// On-demand HTTP trigger for the site page directory's daily dispatch (dispatch-site-directories.ts).
// Netlify runs scheduled functions ONLY on the production deploy, so staging needs this wrapper,
// poked by .github/workflows/staging-crons.yml. Mirrors run-site-audit-dispatch.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed.
//
// POST /.netlify/functions/run-site-directory-dispatch → 200 { ok, considered, started, … } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueDirectories } from '../../src/utils/site-directory-store';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-site-directory-dispatch] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await dispatchDueDirectories(getDb());
        console.log('[run-site-directory-dispatch]', JSON.stringify(result));
        return { statusCode: result.failedToStart ? 500 : 200, body: JSON.stringify({ ok: !result.failedToStart, ...result }) };
    } catch (err) {
        console.error('[run-site-directory-dispatch] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
