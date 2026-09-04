// netlify/functions/run-blog-jobs-background.ts
// Fire-and-forget drain of the BLOG generation queue — the long-form twin of
// run-content-jobs-background.ts.
//
// WHY THIS EXISTS: a blog draft cannot be generated inside a request. process-blog-jobs runs on a
// ten-minute cron (deliberately — the aligned drainers let Neon autosuspend between ticks), and
// run-blog-jobs.ts, the HTTP trigger staging drives, is SYNCHRONOUS: it is bounded by the same
// 10-second function budget that made Blog Studio's "Ask your assistant to draft" button hang in
// production. One draft is a 6,000-token model call plus stock-image sourcing; it does not fit in
// 10 seconds, and it does not fit in Netlify's 26-second synchronous maximum either.
//
// The `-background` suffix is the whole point: Netlify answers 202 as soon as it accepts the work
// and gives this up to 15 minutes to run, so generate-blog can enqueue, poke this, and answer the
// browser immediately while the draft is written out of band. The browser then polls the job.
//
// AUTH: same shared secret as run-blog-jobs.ts, and it fails closed. Draining is idempotent and can
// only process work that already exists — but it spends model credits, so it is not left open.

import { drainBlogJobs } from './process-blog-jobs';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { withLambda } from '@netlify/aws-lambda-compat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-blog-jobs-background] CRON_TRIGGER_SECRET is not set — trigger disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        // Logged because this is INVISIBLE from outside: Netlify answers 202 on accept, before the
        // handler runs, so a rejected poke looks identical to a successful one to whoever sent it.
        // A caller reading a fast 202 would conclude the drain ran.
        console.warn('[run-blog-jobs-background] rejected a poke with a bad or missing token — '
            + 'the queued draft will wait for the ten-minute cron.');
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    // Respect the global kill switch, as every other cost-incurring drain entry point does. The
    // job stays queued rather than failing, so it runs when AI is switched back on.
    if (await isGlobalAiDisabled()) {
        console.warn('[run-blog-jobs-background] global AI kill switch is ON — the job stays queued.');
        return { statusCode: 200, body: JSON.stringify({ ok: true, ran: false, reason: 'ai_disabled' }) };
    }

    try {
        const processed = await drainBlogJobs();
        // ⚠️ 0 is the diagnostic case, not the boring one: it means the poke arrived but the queue
        // had nothing claimable — a job still 'processing' from a previous run, a next_retry_at in
        // the future, or a row that was never written.
        console.log(`[run-blog-jobs-background] drained ${processed} job(s)`
            + (processed === 0 ? ' — nothing claimable in the blog queue' : ''));
        return { statusCode: 200, body: JSON.stringify({ ok: true, processed }) };
    } catch (err) {
        // Nothing is listening for this response — the caller got its 202 long ago. Log loudly so a
        // failure here is visible, then let the ten-minute cron pick the work up as it always would.
        console.error('[run-blog-jobs-background] drain failed:', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
