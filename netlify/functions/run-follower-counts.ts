// netlify/functions/run-follower-counts.ts
// On-demand HTTP trigger for the follower-count refresh sweep (see refresh-follower-counts.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging is a branch deploy of the `staging` branch, so its
// `refresh-follower-counts` cron never fires there and the Audience block would fall back to being
// only as fresh as the last page visit. This endpoint lets an external scheduler (see
// .github/workflows/staging-follower-counts-cron.yml) poke the SAME sweep over HTTP so staging
// behaves like production — same pattern as run-goal-telemetry.ts.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses to
// run (fail closed) so it can never be an open, cost-incurring endpoint — this one fans out to every
// workspace's third-party APIs, so an open trigger would be an especially expensive mistake.
// Callers pass the secret as `Authorization: Bearer <secret>`.
//
// POST /.netlify/functions/run-follower-counts
//   → 200 { ok: true, organisations: <n>, refreshed: <n>, cached: <n>, failed: <n> }
import { withLambda } from '@netlify/aws-lambda-compat';
import { refreshAllFollowerCounts } from './refresh-follower-counts';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-follower-counts] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await refreshAllFollowerCounts();
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[run-follower-counts]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
