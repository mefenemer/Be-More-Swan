// netlify/functions/run-social-messages-tick.ts
// On-demand HTTP trigger for the 15-minute messages tick (social-messages-tick.ts): reminders when a
// reply window has 4 hours left, and the 90-day text purge.
//
// WHY THIS EXISTS: Netlify refuses a direct URL call to a scheduled function on a deployed site with a
// bare 403, and runs schedules on production only. .github/workflows/staging-crons.yml calls this.
//
// AUTH: CRON_TRIGGER_SECRET as `Authorization: Bearer <secret>`; refuses to run when unset (fail closed).
//
// POST /.netlify/functions/run-social-messages-tick → 200 { ok: true, reminded, purged }

import { withLambda } from '@netlify/aws-lambda-compat';
import { socialMessagesTick } from './social-messages-tick';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-social-messages-tick] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }
    const result = await socialMessagesTick();
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, ...result }) };
});
