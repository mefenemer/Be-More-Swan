// src/utils/trigger-drain.ts
// Start a job-queue drain immediately, for work a human is waiting on.
//
// The queues are normally drained by process-content-jobs / process-discovery-jobs on a ten-minute
// cron. That cadence is deliberate — the aligned drainers leave a ~9-minute idle window so Neon can
// autosuspend, and an always-on minute-cron is what exhausted the project-wide compute quota on
// 2026-07-11 (see the note above [functions.process-content-jobs] in netlify.toml).
//
// It is the wrong cadence for on-demand work. A user clicks "generate a post", the job sits in
// `queued` for up to ten minutes before anything looks at it, and every failed attempt costs
// another full cycle — three attempts against a flaky generation is half an hour of "in progress".
// So: poke the queue when someone is watching, and leave the cron slow and cheap for the scheduled
// work nobody is waiting on.

import { resolveBaseUrl } from './base-url';

/** How long to wait for the background invoke to be ACCEPTED (not to finish). */
const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Fire a background drain. Best-effort by construction: every failure path leaves the job exactly
 * where it was, to be picked up by the cron — i.e. the old behaviour — so this must never fail the
 * enqueue that already succeeded.
 *
 * Returns whether the invoke was ACCEPTED, which is not the same as the work having succeeded — it
 * only says the drain has started now rather than waiting for the cron. Callers with a human on the
 * other end use it to choose their wording: "your assistant is writing" against "queued, starting
 * shortly". Everything else can keep ignoring it.
 *
 * The fetch IS awaited, and that matters. An un-awaited fetch can be frozen with the lambda before
 * the request leaves the sandbox, stranding the job with nothing in the logs to explain why.
 * Awaiting a `-background` invoke is cheap: Netlify answers 202 as soon as it accepts the work, so
 * this returns in milliseconds rather than blocking for the length of the drain.
 */
async function poke(
    fn: string,
    headers: Record<string, string | undefined> | undefined,
    jobId: string,
    caller: string,
    /**
     * Extra body fields for the target function. Used by the discovery looper's budget hand-off to
     * carry its chain depth forward — the count has to survive the invocation boundary, and the
     * body is the only channel that does without inventing a table for it.
     */
    extra?: Record<string, unknown>,
): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl(headers as never);
    if (!secret || !baseUrl) {
        console.warn(`[${caller}] drain not triggered for ${jobId} (${!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'}) — job waits for the cron.`);
        return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        await fetch(`${baseUrl}/.netlify/functions/${fn}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ reason: 'on_demand', jobId, ...extra }),
            signal: controller.signal,
        });
        return true;
    } catch (err) {
        console.warn(`[${caller}] drain trigger failed for ${jobId} — job waits for the cron:`,
            err instanceof Error ? err.message : err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/** Start the content-generation queue immediately. See `poke` for the awaiting rule. */
export function triggerContentDrain(
    headers: Record<string, string | undefined> | undefined,
    jobId: string,
    caller: string,
): Promise<boolean> {
    return poke('run-content-jobs-background', headers, jobId, caller);
}

/**
 * Start the BLOG generation queue immediately.
 *
 * The blog queue drains on a ten-minute cron, which is right for Autopilot and wrong for the
 * Studio's "Ask your assistant to draft" button — that one has an author sitting in the editor
 * watching an empty page. Same poke, different worker: blog jobs are filtered out of the content
 * drain by `content_type`, so run-content-jobs-background would claim none of them.
 *
 * NOTE: no star-slash inside this block — see the note on triggerDiscoveryDrain below.
 */
export function triggerBlogDrain(
    headers: Record<string, string | undefined> | undefined,
    jobId: string,
    caller: string,
): Promise<boolean> {
    return poke('run-blog-jobs-background', headers, jobId, caller);
}

/**
 * Start the lead-discovery queue immediately.
 *
 * Discovery needs this more than content does, not less. A discovery run is SLICED: the worker
 * handles one search query per invocation (QUERIES_PER_SLICE) and re-queues itself, so at the
 * ten-minute cron cadence a fifteen-query run took over two hours to finish even once it started.
 * The background twin loops the drain, so one poke carries the whole run.
 *
 * NOTE: no star-slash inside this block — writing the cron expression literally would close the
 * comment early. Same trap as the CSS one in the project conventions.
 */
export function triggerDiscoveryDrain(
    headers: Record<string, string | undefined> | undefined,
    jobId: string,
    caller: string,
    extra?: Record<string, unknown>,
): Promise<boolean> {
    return poke('run-discovery-jobs-background', headers, jobId, caller, extra);
}
