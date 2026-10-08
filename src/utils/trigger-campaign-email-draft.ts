// src/utils/trigger-campaign-email-draft.ts
// Wake the worker that drafts an email campaign a Campaign Assistant order commissioned (§9.7).
//
// Modelled on trigger-strategy-agent.ts, including the rule that matters most:
// ⚠️ the fetch IS awaited. An un-awaited fetch can be frozen with the lambda before the request
// leaves, so the worker is never invoked and the order sits at "With the assistant" for ever
// ([[background-trigger-must-be-awaited]]). Awaiting is cheap — a `-background` invoke answers 202
// the moment it is accepted. A lost wake-up is not fatal either: the hourly reconciler re-sends
// any email order that was never picked up (findStrandedEmailOrders).

import { resolveBaseUrl } from './base-url';

const DISPATCH_TIMEOUT_MS = 5_000;

/** Resolves true when the platform accepted the job. Never throws. */
export async function triggerCampaignEmailDraft(orderId: number, reason: string): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[trigger-campaign-email-draft] NOT dispatched — '
            + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved')
            + '; the reconciler will retry', { orderId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/draft-campaign-emails-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ orderId, reason }),
            signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) {
            console.error('[trigger-campaign-email-draft] worker refused the dispatch', { orderId, status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[trigger-campaign-email-draft] dispatch failed — the reconciler will retry',
            { orderId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}
