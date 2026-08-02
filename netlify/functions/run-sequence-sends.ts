// netlify/functions/run-sequence-sends.ts
// On-demand HTTP trigger for the outreach-sequence worker. Netlify runs scheduled functions ONLY
// on the production deploy, so staging (a branch deploy of `staging`) never fires the
// process-sequence-sends cron. This endpoint runs the SAME drain logic over HTTP so staging
// behaves like prod. Mirrors run-discovery-jobs.ts and run-content-jobs.ts.
//
// It is also the manual lever for the send-and-reply round trip: approve a lead, then POST here to
// make the first follow-up due immediately instead of waiting three days.
//
// AUTH: shared secret (CRON_TRIGGER_SECRET) as `Authorization: Bearer <secret>`. Fails closed when
// the secret is unset — this endpoint sends email from tenants' mailboxes, so an open version of it
// would be a spam cannon, not merely a cost risk.
//
// POST /.netlify/functions/run-sequence-sends  → 200 { ok, claimed, sent, halted, skipped }

import { withLambda } from '@netlify/aws-lambda-compat';
import { drainSequenceSends } from './process-sequence-sends';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-sequence-sends] CRON_TRIGGER_SECRET is not set — endpoint disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token !== secret) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };

    try {
        const result = await drainSequenceSends();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[run-sequence-sends]', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }) };
    }
});
