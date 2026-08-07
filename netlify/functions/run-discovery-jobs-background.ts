// netlify/functions/run-discovery-jobs-background.ts
// Fire-and-forget drain of the lead-discovery queue, for a search a human just started.
//
// WHY THIS EXISTS: process-discovery-jobs runs on a ten-minute cron, deliberately — the aligned
// drainers let Neon autosuspend between ticks, and an always-on minute-cron is what exhausted the
// project-wide compute quota on 2026-07-11 (see netlify.toml). That is the right trade for the
// hourly dispatcher's scheduled runs, which nobody is watching.
//
// It was badly wrong for "Start search". Creating a search only INSERTs a discovery_jobs row at
// status 'queued'; nothing invoked the worker, so the user watched a "Queued" chip for up to ten
// minutes before anything looked at it — and on a branch deploy, forever, because Netlify fires
// scheduled functions only on the production deploy.
//
// ── Why this one LOOPS and run-content-jobs-background does not ────────────────
// A discovery run is sliced. Each drain does one search query (QUERIES_PER_SLICE = 1) and re-queues
// the job for the next tick, so a fifteen-query run needs fifteen ticks, plus more for the
// promoting and enriching stages. Draining once would move a search from "Queued" to "Searching
// now" and then strand it back on the cron for another ten minutes per query — over two hours for
// one run. So this drains repeatedly until the queue is empty or the budget runs out, and one poke
// carries the whole run.
//
// The `-background` suffix is load-bearing: Netlify answers 202 immediately and allows up to 15
// minutes, so the loop is not bounded by the 26-second budget of the request that triggered it.
//
// SAFETY vs the cron: drainDiscoveryJobs claims its rows in a single atomic UPDATE ... RETURNING
// (see process-discovery-jobs.ts), so a cron tick landing mid-loop takes different rows or none.
// Overlap costs nothing and duplicates nothing.
//
// AUTH: same shared secret as run-discovery-jobs.ts, and it fails closed. A drain spends real money
// (Serper calls + model tokens), so this is never open to the internet.

import { drainDiscoveryJobs } from './process-discovery-jobs';
import { withLambda } from '@netlify/aws-lambda-compat';

// Netlify allows a background function 15 minutes. Stop well short so the final slice in flight
// finishes and reports rather than being killed mid-write — a slice truncated by the platform is
// exactly the "stuck in processing" case the worker then has to time out and reset.
const BUDGET_MS = 12 * 60 * 1000;
// Belt and braces against a pathological queue that never empties (e.g. many orgs' searches all
// running at once): the cron picks up whatever is left, as it always did.
const MAX_PASSES = 200;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) {
        console.warn('[run-discovery-jobs-background] CRON_TRIGGER_SECRET is not set — trigger disabled.');
        return { statusCode: 503, body: JSON.stringify({ ok: false, error: 'Trigger not configured.' }) };
    }

    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) {
        return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Unauthorized.' }) };
    }

    const deadline = Date.now() + BUDGET_MS;
    let passes = 0;
    let slices = 0;

    try {
        while (Date.now() < deadline && passes < MAX_PASSES) {
            // Returns the number of job rows this pass claimed. Zero means the queue is empty OR
            // everything left is backing off (next_retry_at in the future) — either way there is
            // nothing this loop can usefully do, and the cron owns the retry.
            const processed = await drainDiscoveryJobs();
            passes++;
            if (!processed) break;
            slices += processed;
        }
        console.log(`[run-discovery-jobs-background] ${slices} slice(s) over ${passes} pass(es)`);
        return { statusCode: 200, body: JSON.stringify({ ok: true, slices, passes }) };
    } catch (err) {
        // Nothing is listening — the caller got its 202 long ago. Log loudly, then let the cron
        // pick the work up exactly as it would have before this endpoint existed.
        console.error(`[run-discovery-jobs-background] drain failed after ${slices} slice(s):`, err);
        return { statusCode: 500, body: JSON.stringify({ ok: false, slices, passes }) };
    }
});
