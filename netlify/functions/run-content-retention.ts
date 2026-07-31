// netlify/functions/run-content-retention.ts
// On-demand HTTP trigger for the content_assets retention pass (see content-retention.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging is a branch deploy, so `content-retention` never fires there and
// nothing reclaims post media from R2. This endpoint lets an external scheduler poke the SAME logic
// over HTTP so staging behaves like production — same pattern as run-goal-telemetry.ts.
//
// It is also the supported way to run the pass by hand, which matters here: the scheduled entry has
// to stay reachable for the platform to invoke it, so it can only treat Netlify's `next_run` marker
// as a hint. THIS endpoint has no such compromise — no secret, no run.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses to
// run (fail closed) so it can never be an open, destructive endpoint. Callers pass the secret as
// `Authorization: Bearer <secret>`.
//
// POST /.netlify/functions/run-content-retention
//   → 200 { ok: true, ... }   503 when unconfigured   401 on a bad token

import { Handler } from '@netlify/functions';
import { runContentRetention } from './content-retention';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-content-retention] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await runContentRetention();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-content-retention]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
