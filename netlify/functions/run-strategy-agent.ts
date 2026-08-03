// netlify/functions/run-strategy-agent.ts
// On-demand HTTP trigger for the weekly Strategy Agent run. Netlify runs scheduled functions ONLY
// on the production deploy, so staging (a branch deploy of `staging`) never fires the
// autonomous-strategy-agent cron. This endpoint runs the SAME logic over HTTP so staging behaves
// like prod. Mirrors run-sequence-sends.ts and run-discovery-jobs.ts.
//
// It is also the manual lever for exercising the loop: bank five edits in the Review Queue, POST
// here, and the proposal appears in the Strategy tab immediately instead of next Monday.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// the secret is unset. Lower stakes than the sequence sender — nothing here emails anyone, and the
// worst an open version could do is spend model budget — but it does spend model budget, and it is
// gated per-org on `strategy_agent` regardless.
//
// POST /.netlify/functions/run-strategy-agent → 200 { ok, clusters, proposed, skipped, expired, notified }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runStrategyAgent } from './autonomous-strategy-agent';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-strategy-agent] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await runStrategyAgent();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-strategy-agent]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
