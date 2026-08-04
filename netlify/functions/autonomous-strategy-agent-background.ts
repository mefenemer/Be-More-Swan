// netlify/functions/autonomous-strategy-agent-background.ts
// The Strategy Agent's actual worker — Phase 5a §7. Dispatched (awaited) by
// autonomous-strategy-agent.ts on the weekly cron, and by run-strategy-agent.ts on staging.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// One org costs ~50 seconds, almost all of it the model rewriting the playbook (measured on
// staging 2026-08-03: cold start 17:40:50, proposal written 17:41:39). A synchronous Netlify
// function gets 10s by default and 26s at the maximum, so the scheduled run was being killed on
// every tick — and the one proposal it ever produced only survived because the staging workflow's
// `curl --retry` gave it another attempt and the killed invocation's write had already committed.
// The `-background` suffix buys 15 minutes; runStrategyAgent stops itself well before that.
//
// ── Nothing here answers to a user ───────────────────────────────────────────
// The response body is never read — a background invoke returns 202 immediately and the caller is
// gone by the time this finishes. So the run's outcome is persisted to platform_config
// (`strategy_agent.last_run`) and surfaced in the Strategy tab, which is the only place a human
// will ever see it. Do not add a meaningful response here expecting someone to read it.
//
// AUTH: the same shared secret as every other cron worker. Fails closed when unset — an open
// version would let anyone spend the platform's model budget.
//
// POST /.netlify/functions/autonomous-strategy-agent-background { reason? }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runStrategyAgent } from './autonomous-strategy-agent';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[strategy-agent-background] CRON_TRIGGER_SECRET is not set — worker disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Worker not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const result = await runStrategyAgent();
        // Logged rather than returned: see the header note — nobody is listening for this body.
        console.log('[strategy-agent-background] run complete', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify(result) };
    } catch (err) {
        // db/strategy-proposals.sql is a MANUAL apply — on an un-migrated environment say so rather
        // than emitting a bare stack every week.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('does not exist') && (msg.includes('relation') || msg.includes('column'))) {
            console.error('[strategy-agent-background] schema not migrated — apply db/strategy-proposals.sql', err);
            return { statusCode: 200, body: JSON.stringify({ skipped: 'migration_pending' }) };
        }
        console.error('[strategy-agent-background] run failed', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Strategy agent run failed.' }) };
    }
});
