// src/utils/trigger-publish-now.ts
// Run the social publishers NOW for a "Post now" approval, instead of leaving the post to wait for
// the next 10-minute cron tick (publish-instagram / publish-facebook / publish-social-posts). Until
// this existed "Post now" set the time to now and status 'scheduled' and then sat in the calendar
// looking scheduled for up to ten minutes, which read as the button not having worked.
//
// ⚠️ The fetch IS awaited (memory: background-trigger-must-be-awaited). A false return is not an
// error for the caller: the post is already due, so the cron still publishes it on its next tick.

import { resolveBaseUrl } from './base-url';

const DISPATCH_TIMEOUT_MS = 5_000;

/** Resolves true when the worker accepted the run. Never throws. */
export async function triggerPublishNow(platforms: string[]): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.warn('[trigger-publish-now] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved') + '; the cron will publish it');
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/publish-now-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ platforms }),
            signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) {
            console.warn('[trigger-publish-now] worker refused the dispatch', { platforms, status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.warn('[trigger-publish-now] dispatch failed', { platforms, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}
