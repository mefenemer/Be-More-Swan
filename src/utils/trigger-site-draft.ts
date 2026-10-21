// src/utils/trigger-site-draft.ts
// Wake the Website Assistant's draft worker (draft-site-background.ts). Same rules as
// trigger-site-audit.ts: ⚠️ the fetch IS awaited (memory: background-trigger-must-be-awaited), and a
// false return is handled by the caller at once — it ends the draft so the editor never shows
// "Drafting your site…" for ever.

import { resolveBaseUrl } from './base-url';

const DISPATCH_TIMEOUT_MS = 5_000;

/**
 * Resolves true when the platform accepted the job. Never throws. `request` is the user's brief;
 * `job.import` runs "Import my current site" instead (what to read is in its site_imports row).
 */
export async function triggerSiteDraft(siteId: number, request: string | null, job: { import?: boolean } = {}): Promise<boolean> {
    const secret = process.env.CRON_TRIGGER_SECRET;
    const baseUrl = resolveBaseUrl();
    if (!secret || !baseUrl) {
        console.error('[trigger-site-draft] NOT dispatched — ' + (!secret ? 'CRON_TRIGGER_SECRET unset' : 'base URL unresolved'), { siteId });
        return false;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
    try {
        const res = await fetch(`${baseUrl}/.netlify/functions/draft-site-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ siteId, request, import: job.import === true }),
            signal: controller.signal,
        });
        if (res.status !== 202 && !res.ok) {
            console.error('[trigger-site-draft] worker refused the dispatch', { siteId, status: res.status });
            return false;
        }
        return true;
    } catch (err) {
        console.error('[trigger-site-draft] dispatch failed', { siteId, err: err instanceof Error ? err.message : err });
        return false;
    } finally {
        clearTimeout(timer);
    }
}
