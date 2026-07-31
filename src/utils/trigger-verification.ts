// src/utils/trigger-verification.ts
// Dispatch one compliance verification to the background worker.
//
// Modelled on trigger-drain.ts, with one deliberate difference: this one REPORTS failure instead of
// warning and moving on. A drain that fails to dispatch is picked up by the next cron tick, so
// best-effort is right there. Nothing re-drives a verification — if the trigger does not land, the
// user's warning sits on a spinner forever with the task credit already spent, so the caller has to
// know, and has to be able to tell them.

import { resolveBaseUrl } from './base-url';

/** How long to wait for the background invoke to be ACCEPTED (not to finish). */
const DISPATCH_TIMEOUT_MS = 5_000;

export type DispatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Fire the verification worker.
 *
 * The fetch IS awaited, and that matters. On Lambda the runtime freezes the moment the handler
 * returns, so an un-awaited fetch is frozen mid-flight and never reaches the worker — the job is
 * stranded with nothing in the logs to explain it. Awaiting a `-background` invoke is cheap:
 * Netlify answers 202 as soon as it accepts the work, so this returns in milliseconds rather than
 * blocking for the ~2 minutes the verification itself takes.
 */
export async function triggerWarningVerification(
    headers: Record<string, string | undefined> | undefined,
    postId: number,
    warning: string,
): Promise<DispatchResult> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl(headers as never);
    if (!secret || !baseUrl) {
        const missing = !secret ? 'CRON_TRIGGER_SECRET' : 'the site URL';
        console.error(`[trigger-verification] cannot dispatch post ${postId}: ${missing} is not set.`);
        return { ok: false, reason: 'The verification service is not configured on this environment.' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/verify-compliance-warning-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ postId, warning }),
            signal: controller.signal,
        });
        // 202 is the expected answer — Netlify accepting the background invoke. Anything else means
        // the worker was never queued, so treat it as a failure rather than assuming it ran.
        if (!res.ok && res.status !== 202) {
            console.error(`[trigger-verification] worker refused dispatch for post ${postId}: HTTP ${res.status}`);
            return { ok: false, reason: 'The check could not be started. Please try again.' };
        }
        return { ok: true };
    } catch (err) {
        console.error(`[trigger-verification] dispatch failed for post ${postId}:`,
            err instanceof Error ? err.message : err);
        return { ok: false, reason: 'The check could not be started. Please try again.' };
    } finally {
        clearTimeout(timer);
    }
}
