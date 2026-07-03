// netlify/functions/run-goal-telemetry.ts
// On-demand HTTP trigger for the SMART Goals telemetry poll (see poll-goal-telemetry.ts).
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy — never on
// branch/preview deploys. Staging (a branch deploy) therefore never fires `poll-goal-telemetry`,
// so goal status never advances past 'pending' and the Assistants card always shows
// "0 On Track / 0 Off Track" even when there has been activity. This endpoint lets an external
// scheduler (see .github/workflows/staging-goal-telemetry-cron.yml) poke the SAME poll logic
// over HTTP so staging behaves like production — same pattern as run-content-jobs.ts.
//
// AUTH: guarded by a shared secret. If CRON_TRIGGER_SECRET is not configured the endpoint refuses
// to run (fail closed) so it can never be an open, cost-incurring endpoint. Callers pass the secret
// as `Authorization: Bearer <secret>`.
//
// POST /.netlify/functions/run-goal-telemetry
//   → 200 { ok: true, goals: <n>, polled: <n>, skipped: <n>, disconnected: <n> }

import { Handler } from '@netlify/functions';
import { pollGoalTelemetry } from './poll-goal-telemetry';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-goal-telemetry] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await pollGoalTelemetry();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-goal-telemetry]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
};
