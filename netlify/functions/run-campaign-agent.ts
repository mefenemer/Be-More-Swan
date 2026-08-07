// netlify/functions/run-campaign-agent.ts
// On-demand HTTP trigger for the Campaign Assistant's autonomous run (see
// autonomous-campaign-agent.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging is a branch deploy, so `autonomous-campaign-agent` never fires
// there and no decision would ever appear autonomously. This endpoint lets an external scheduler
// (.github/workflows/staging-crons.yml) poke the SAME run logic over HTTP — the same
// pattern as run-goal-telemetry.ts and run-strategy-agent.ts.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses
// to run (fail closed) so it can never be an open endpoint. Callers pass the secret as
// `Authorization: Bearer <secret>`.
//
// ⚠️ Unlike run-strategy-agent, the response here IS the result, not an ack. This run is
// deterministic SQL with no model call, so it finishes inline well inside the function budget —
// `proposed` in the body is the real count.
//
// POST /.netlify/functions/run-campaign-agent
//   → 200 { ok: true, campaigns, proposed, expired, escalations, halts, notified }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runCampaignProposer } from './autonomous-campaign-agent';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-campaign-agent] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await runCampaignProposer();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-campaign-agent]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
