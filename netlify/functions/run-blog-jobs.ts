// netlify/functions/run-blog-jobs.ts
// On-demand HTTP trigger for Blog Autopilot — the long-form twin of run-content-jobs.ts.
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging is a branch deploy, so neither `blog-horizon-fill` nor
// `process-blog-jobs` ever fires there and autopilot would look completely dead on staging.
// This endpoint lets an external scheduler (.github/workflows/staging-blog-cron.yml) poke BOTH
// halves over HTTP so staging behaves like production.
//
// Both halves run in one call, horizon-fill first, so a slot enqueued this tick is drafted in the
// same tick rather than waiting for the next one.
//
// AUTH: guarded by the same shared secret as run-content-jobs. If CRON_TRIGGER_SECRET is not
// configured the endpoint refuses to run (fail closed) so it can never be an open, cost-incurring
// endpoint. Callers pass the secret as `Authorization: Bearer <secret>`.
//
// POST /.netlify/functions/run-blog-jobs
//   → 200 { ok: true, enqueued: <n>, processed: <n> }

import { Handler } from '@netlify/functions';
import { fillBlogHorizons } from './blog-horizon-fill';
import { drainBlogJobs } from './process-blog-jobs';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-blog-jobs] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    if (await isGlobalAiDisabled()) {
        return { statusCode: 200, body: JSON.stringify({ ok: true, ran: false, reason: 'ai_disabled' }) };
    }

    try {
        const { jobsEnqueued } = await fillBlogHorizons();
        const processed = await drainBlogJobs();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, enqueued: jobsEnqueued, processed }),
        };
    } catch (err) {
        console.error('[run-blog-jobs] error:', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'Blog job run failed.' }) };
    }
});
