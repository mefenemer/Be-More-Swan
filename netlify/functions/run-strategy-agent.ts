// netlify/functions/run-strategy-agent.ts
// On-demand HTTP trigger for the Strategy Agent. Netlify runs scheduled functions ONLY on the
// production deploy, so staging (a branch deploy of `staging`) never fires the
// autonomous-strategy-agent cron. This dispatches the SAME background worker so staging behaves
// like prod. Mirrors run-sequence-sends.ts and run-discovery-jobs.ts.
//
// It is also the manual lever for exercising the loop: bank five same-reason edits in the Review
// Queue, POST here, and the proposal appears in the Strategy tab instead of waiting for Monday.
//
// ⚠️ THIS DISPATCHES; IT DOES NOT WAIT. It used to run the work inline, which could not work: one
// org costs ~50 seconds and this function is capped at 10s (26s at the absolute maximum), so it was
// killed on every invocation. The caller gets an ack, not a result.
//
// So DO NOT read the run's outcome from this response — it will always be `{dispatched:true}`.
// The outcome lands in platform_config (`strategy_agent.last_run`) and is rendered in the Strategy
// tab's empty state, which is where §7 wants "is this thing even running?" answered anyway.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// the secret is unset. Nothing here emails anyone, but it does spend model budget, and it is gated
// per-org on `strategy_agent` inside the worker regardless.
//
// POST /.netlify/functions/run-strategy-agent → 202 { ok, dispatched }

import { withLambda } from '@netlify/aws-lambda-compat';
import { triggerStrategyAgentRun } from '../../src/utils/trigger-strategy-agent';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-strategy-agent] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    const dispatched = await triggerStrategyAgentRun('manual-trigger');
    return {
        statusCode: dispatched ? 202 : 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ok: dispatched,
            dispatched,
            note: 'The run happens in the background. Its outcome appears in the Strategy tab, not in this response.',
        }),
    };
});
