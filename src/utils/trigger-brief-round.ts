// src/utils/trigger-brief-round.ts
// Wake the Brand Designer's worker for one round (generate-brief-options-background.ts).
//
// Modelled on trigger-campaign-email-draft.ts, including the rule that matters most:
// ⚠️ the fetch IS awaited. An un-awaited fetch can be frozen with the lambda before the request
// leaves, so the worker is never invoked ([[background-trigger-must-be-awaited]]). A `-background`
// invoke answers 202 the moment it is accepted, so awaiting costs nothing.
//
// A false return is handled by the CALLER, at once: it ends the round and refunds the credit, so a
// lost wake-up never leaves "Making options…" on screen with the user's credit held.

import { resolveBaseUrl } from './base-url';

const DISPATCH_TIMEOUT_MS = 5_000;

/** Resolves true when the platform accepted the job. Never throws. */
export async function triggerBriefRound(briefId: number, userId: number | null): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[trigger-brief-round] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { briefId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/generate-brief-options-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ briefId, userId }),
            signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) {
            console.error('[trigger-brief-round] worker refused the dispatch', { briefId, status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[trigger-brief-round] dispatch failed', { briefId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}
