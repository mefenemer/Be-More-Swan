// src/utils/site-fetch.ts — the ONE way a web page is read for the website tools: robots.txt first,
// then the SSRF-fenced fetch (safe-fetch.ts), and only an HTML answer is accepted. The Mystery Shopper
// (site-audit.ts fetchSitePageLive) and "Import my current site" (site-import-store.ts) both read
// through here, each under its own crawler name so a site owner can tell them apart in robots.txt.
// Never throws: a refusal comes back as a message the owner can read.

import { robotsAllows, type Crawler } from '../lib/robots';
import { safeFetchText, SafeFetchError } from './safe-fetch';

export type HtmlFetch = { ok: true; html: string; finalUrl: string } | { ok: false; message: string };

export async function fetchSiteHtml(url: string, crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }): Promise<HtmlFetch> {
    return fetchSite(url, crawler, opts, /html|xml/i);
}

/**
 * The same read for a builder's own JSON — a Wix page's data file, which says where its embedded
 * HTML boxes live (site-embeds.ts). Never the owner's page itself: that is fetchSiteHtml.
 */
export async function fetchSiteJson(url: string, crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }): Promise<HtmlFetch> {
    return fetchSite(url, crawler, opts, /json/i);
}

/** One of their stylesheets, for their colours and fonts (site-import-theme.ts). Same fence as their pages. */
export async function fetchSiteCss(url: string, crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }): Promise<HtmlFetch> {
    return fetchSite(url, crawler, opts, /css|text\/plain/i);
}

/**
 * Shops throttle a burst of reads: Shopify answered 7 of 11 menu pages "429 Too Many Requests" when the
 * import read three at a time (2026-11-09). A 429 or 503 is tried again after a short pause, twice.
 */
export const RETRY_WAITS_MS = [1500, 4000];
async function withRetry<T>(run: () => Promise<T>, waits: number[] = RETRY_WAITS_MS): Promise<T> {
    for (let i = 0; ; i++) {
        try { return await run(); } catch (err) {
            const busy = err instanceof SafeFetchError && /\((429|503)\)/.test(err.message);
            if (!busy || i >= waits.length) throw err;
            await new Promise((r) => setTimeout(r, waits[i]));
        }
    }
}
export const _withRetryForTests = withRetry;

async function fetchSite(url: string, crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }, accept: RegExp): Promise<HtmlFetch> {
    try {
        const u = new URL(url);
        if (!(await robotsAllows(u.host, u.pathname + u.search, crawler))) {
            return { ok: false, message: `${u.host} asks crawlers like ours not to read this page (robots.txt), so we didn't.` };
        }
        const res = await withRetry(() => safeFetchText(url, { userAgent: crawler.userAgent, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes }));
        if (res.contentType && !accept.test(res.contentType)) {
            return { ok: false, message: 'That link isn\'t a web page (it returned a file).' };
        }
        return { ok: true, html: res.body, finalUrl: res.finalUrl };
    } catch (err) {
        if (err instanceof SafeFetchError) return { ok: false, message: err.message };
        console.error('[site-fetch] fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
        return { ok: false, message: 'We couldn\'t reach that page just now.' };
    }
}
