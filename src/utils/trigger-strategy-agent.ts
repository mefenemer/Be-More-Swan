// src/utils/trigger-strategy-agent.ts
// Kick off the Strategy Agent's background worker.
//
// ── Why the run is a background function at all ──────────────────────────────
// ONE org costs ~50 seconds, almost all of it the model rewriting the playbook. Measured on staging
// 2026-08-03: cold start 17:40:50, proposal written 17:41:39. A synchronous Netlify function gets
// 10s by default and 26s at the absolute maximum, so the scheduled run was killed on every tick. It
// only ever produced a proposal because the staging workflow's `curl --retry` handed it a second
// attempt and the killed invocation's write had already committed — luck, not design, and the real
// Monday cron has no retry.
//
// Both entry points (the weekly cron and the staging HTTP trigger) dispatch through here, so there
// is one definition of how the worker is invoked and authorised.
//
// Modelled on trigger-blueprint-recompile.ts, including the awaited-fetch rule below.

import { resolveBaseUrl } from './base-url';

/** How long to wait for the background invoke to be ACCEPTED (not to finish). */
const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Fire the background run. Resolves true when the platform accepted the work.
 *
 * ⚠️ The fetch IS awaited on purpose. An un-awaited fetch can be frozen along with the lambda
 * before the request leaves the sandbox, so the worker would never be invoked at all — the failure
 * mode recorded in [[background-trigger-must-be-awaited]]. Awaiting a `-background` invoke is cheap:
 * the platform answers 202 as soon as it accepts the job, not when the job finishes.
 */
export async function triggerStrategyAgentRun(reason: string): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[trigger-strategy-agent] NOT dispatched — '
            + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved')
            + '; no proposals will be generated this run.');
        return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/autonomous-strategy-agent-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ reason }),
            signal: controller.signal,
        });
        // 202 is the success case for a background invoke. Anything else means the work was not
        // accepted, and saying so beats a silent no-op that looks exactly like "nothing to do".
        if (res.status !== 202 && !res.ok) {
            console.error('[trigger-strategy-agent] worker refused the dispatch', { status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[trigger-strategy-agent] dispatch failed — no proposals this run:',
            err instanceof Error ? err.message : err);
        return false;
    } finally {
        clearTimeout(timer);
    }
}
