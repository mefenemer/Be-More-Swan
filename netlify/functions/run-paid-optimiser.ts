// netlify/functions/run-paid-optimiser.ts
// On-demand HTTP trigger for the paid-campaign sweep (see optimise-paid-campaigns.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging is a branch deploy, so `optimise-paid-campaigns` never fires
// there. Without this endpoint the kill switch could only ever be observed in production, which is
// the last place anyone should be finding out how it behaves.
//
// ⚠️ AND IT IS WORSE THAN "the sweep does not run". `OPTIMISER_STALE_HOURS` is 26: a live paid
// campaign whose optimiser has not run in that long HALTS ITSELF. So on staging, without this
// poke, every campaign anyone launched to test the flow would stop on its own the next day and
// look like a bug in the launch path. The watchdog would be doing exactly what it should, in the
// one environment where nobody would believe it.
//
// AUTH: guarded by a shared secret, and FAILS CLOSED — without CRON_TRIGGER_SECRET the endpoint
// refuses rather than running, so it can never become an open endpoint that anyone can drive.
// Same contract as run-campaign-agent.ts.
//
// ⚠️ Why the guard matters MORE here than on the other pokes. A successful sweep stamps
// `optimiser_last_run_at` on every campaign it examines — which is precisely what silences the
// staleness watchdog. An unauthenticated caller (or a stray uptime monitor pointed at this URL)
// hitting it on a loop would keep the heartbeat permanently quiet while the real scheduler was
// dead. The endpoint that can silence an alarm needs at least as much protection as the alarm.
//
// POST /.netlify/functions/run-paid-optimiser
//   → 200 { ok: true, examined, paused, halted }

import { withLambda } from '@netlify/aws-lambda-compat';
import { runPaidOptimiserSweep } from './optimise-paid-campaigns';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this stays disabled rather than open.
    if (!secret) {
        console.warn('[run-paid-optimiser] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        // The result is the real thing, not an ack: the sweep is a handful of queries and at most a
        // few network calls per campaign, so it finishes inline well inside the function budget.
        // ⚠️ The request headers are passed so the sweep can tell staging from production by HOST.
        // Without them it would fail closed to "production" and the dev-only adapter would refuse —
        // which is the correct default, and exactly why the poke must supply them.
        const result = await runPaidOptimiserSweep(event.headers as Record<string, string | undefined>);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-paid-optimiser]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
