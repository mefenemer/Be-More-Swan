// netlify/functions/run-scenario-jobs.ts
// On-demand HTTP trigger for the Integration Scenario Library's outbound drain (process-scenario-jobs.ts):
// the hand-offs a record fires when it is approved — a meeting's follow-up email, Slack summary, Notion
// page and Jira/Asana tickets, and a lead's CRM push.
//
// WHY THIS EXISTS: Netlify runs scheduled functions ONLY on the production deploy, and answers a URL call
// to one with a bare 403, so on staging nothing ever drained scenario_jobs: an approved meeting queued
// its hand-offs and none of them ran (found preparing the Meeting Note Taker real-account run, finish
// plan step 8). .github/workflows/staging-crons.yml pokes this instead.
//
// AUTH: CRON_TRIGGER_SECRET as `Authorization: Bearer <secret>`; refuses to run when unset (fail closed).
//
// POST /.netlify/functions/run-scenario-jobs → 200 { ok: true, claimed, completed, retried, failed }

import { withLambda } from '@netlify/aws-lambda-compat';
import { drainScenarioJobs } from './process-scenario-jobs';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    // Fail closed: without a configured secret this endpoint stays disabled rather than open.
    if (!secret) {
        console.warn('[run-scenario-jobs] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await drainScenarioJobs();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-scenario-jobs]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
