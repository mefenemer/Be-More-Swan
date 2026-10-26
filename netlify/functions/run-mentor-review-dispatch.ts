// netlify/functions/run-mentor-review-dispatch.ts
// On-demand HTTP trigger for the Business Mentor's daily review dispatch (dispatch-mentor-reviews.ts).
// Netlify runs scheduled functions ONLY on the production deploy, so staging needs this wrapper, poked by
// .github/workflows/staging-crons.yml. Mirrors run-site-audit-dispatch.ts.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// unset — each review can spend a workspace's task.
//
// POST /.netlify/functions/run-mentor-review-dispatch → 200 { ok, considered, due, queued, … } | 500

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueReviews } from '../../src/utils/mentor-review';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-mentor-review-dispatch] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await dispatchDueReviews(getDb());
        console.log('[run-mentor-review-dispatch]', JSON.stringify(result));
        // A review that could not be STARTED is a fault the workflow should show — 500 so it is retried.
        return { statusCode: result.failedToStart ? 500 : 200, body: JSON.stringify({ ok: !result.failedToStart, ...result }) };
    } catch (err) {
        console.error('[run-mentor-review-dispatch] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
});
