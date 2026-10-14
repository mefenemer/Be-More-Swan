// src/utils/trigger-site-audit.ts
// Wake the Mystery Shopper's worker for one run (run-site-audit-background.ts).
//
// Modelled on trigger-brief-round.ts, including the rule that matters most:
// ⚠️ the fetch IS awaited. An un-awaited fetch can be frozen with the lambda before the request
// leaves, so the worker is never invoked ([[background-trigger-must-be-awaited]]). A `-background`
// invoke answers 202 the moment it is accepted, so awaiting costs nothing.
//
// A false return is handled by the CALLER, at once: it fails the run (free), so a lost wake-up
// never leaves "Checking your site…" on screen forever.

import { resolveBaseUrl } from './base-url';

const DISPATCH_TIMEOUT_MS = 5_000;

/** Resolves true when the platform accepted the job. Never throws. */
export async function triggerSiteAudit(runId: number, extra: { emailTo?: string } = {}): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[trigger-site-audit] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { runId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/run-site-audit-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            // emailTo: the public taster's address, handed to the worker once and never stored.
            body: JSON.stringify({ runId, ...(extra.emailTo ? { emailTo: extra.emailTo } : {}) }),
            signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) {
            console.error('[trigger-site-audit] worker refused the dispatch', { runId, status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[trigger-site-audit] dispatch failed', { runId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}
