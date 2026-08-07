// netlify/functions/run-campaign-reconciler.ts
// On-demand HTTP trigger for the campaign order/campaign reconciliation pass (see
// reconcile-campaigns.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging is a branch deploy, so `reconcile-campaigns` never fires there
// and every staging campaign order would sit at "With the assistant" for ever, which is precisely
// the bug this feature was built to fix. This endpoint lets an external scheduler
// (.github/workflows/staging-crons.yml) poke the SAME run logic over HTTP — the same pattern as
// run-campaign-agent.ts.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses
// to run (fail closed) so it can never be an open endpoint. Callers pass the secret as
// `Authorization: Bearer <secret>`.
//
// The response IS the result, not an ack — the pass is deterministic SQL with no model call and
// finishes inline, exactly like run-campaign-agent.
//
// POST /.netlify/functions/run-campaign-reconciler
//   → 200 { ok: true, examined, toReview, delivered, rejected, failed, unblocked, finished, refundedWork }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runCampaignReconciler } from './reconcile-campaigns';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-campaign-reconciler] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await runCampaignReconciler();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-campaign-reconciler]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
