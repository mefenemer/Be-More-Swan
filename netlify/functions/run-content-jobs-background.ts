// netlify/functions/run-content-jobs-background.ts
// Fire-and-forget drain of the content-generation queue.
//
// WHY THIS EXISTS: process-content-jobs runs on a */10 cron, deliberately — the aligned 10-minute
// cadence lets Neon autosuspend between ticks, and an always-on minute-cron is what exhausted the
// project-wide compute quota on 2026-07-11 (see the note above [functions.process-content-jobs] in
// netlify.toml). That tradeoff is right for scheduled drafting, where nobody is waiting.
//
// It is wrong for on-demand generation, where a human clicked a button and is watching. Before
// this, "generate a post" sat in `queued` for up to 10 minutes before anything even looked at it,
// and every failed attempt cost another full cycle — three attempts against a flaky generation
// could take half an hour while the UI said "in progress". generate-post.ts now pokes this
// endpoint, so a user-initiated job starts immediately while the cron keeps its slow, cheap cadence
// for everything else.
//
// The `-background` suffix is load-bearing: Netlify returns 202 to the caller straight away and
// gives this up to 15 minutes to run, so the drain is not bounded by the 26-second budget of the
// request that triggered it, and generate-post's own response is not held open behind it.
//
// AUTH: same shared secret as run-content-jobs.ts, and it fails closed. Draining is idempotent and
// can only process work that already exists — but it spends model credits, so it is not something
// to leave open to the internet.

import { drainContentJobs } from './process-content-jobs';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-content-jobs-background] CRON_TRIGGER_SECRET is not set — trigger disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    try {
        const processed = await drainContentJobs();
        console.log(`[run-content-jobs-background] drained ${processed} job(s)`);
        return { statusCode: 200, body: JSON.stringify({ ok: true, processed }) };
    } catch (err) {
        // Nothing is listening for this response — the caller got its 202 long ago. Log loudly so a
        // failure here is visible, then let the */10 cron pick the work up as it always would.
        console.error('[run-content-jobs-background] drain failed:', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
