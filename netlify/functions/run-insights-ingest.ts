// netlify/functions/run-insights-ingest.ts
// On-demand HTTP trigger for the Instagram insights ingest (see ingest-instagram-insights.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging (a branch deploy of `staging`) therefore never fires
// `ingest-instagram-insights`, so post_insights stays empty there and the assistant-detail
// "Performance Metrics" cards read "No published-post data yet" no matter how much the assistant
// has published. This endpoint lets an external scheduler (see
// .github/workflows/staging-insights-cron.yml) poke the SAME ingest logic over HTTP so staging
// behaves like production — same pattern as run-goal-telemetry.ts / run-content-jobs.ts.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses
// to run (fail closed) so it can never be an open, cost-incurring endpoint — this one issues paid
// Graph API calls and writes to the database. Callers pass the secret as
// `Authorization: Bearer <secret>`.
//
// POST /.netlify/functions/run-insights-ingest
//   → 200 { ok: true, processed: <n>, updated: <n>, failed: <n>, durationMs: <n> }

import { Handler } from '@netlify/functions';
import { ingestInstagramInsights } from './ingest-instagram-insights';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-insights-ingest] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    // The `Bearer ` prefix is stripped if present, so a bare `Authorization: <secret>` is also
    // accepted. Lenient by design and shared with the other run-* wrappers — the secret itself
    // is still required, only its framing is optional.
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await ingestInstagramInsights();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-insights-ingest]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
