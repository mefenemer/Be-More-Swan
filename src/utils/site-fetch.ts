// src/utils/site-fetch.ts — the ONE way a web page is read for the website tools: robots.txt first,
// then the SSRF-fenced fetch (safe-fetch.ts), and only an HTML answer is accepted. The Mystery Shopper
// (site-audit.ts fetchSitePageLive) and "Import my current site" (site-import-store.ts) both read
// through here, each under its own crawler name so a site owner can tell them apart in robots.txt.
// Never throws: a refusal comes back as a message the owner can read.

import { robotsAllows, type Crawler } from '../lib/robots';
import { safeFetchText, SafeFetchError } from './safe-fetch';

export type HtmlFetch = { ok: true; html: string; finalUrl: string } | { ok: false; message: string };

export async function fetchSiteHtml(url: string, crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }): Promise<HtmlFetch> {
    try {
        const u = new URL(url);
        if (!(await robotsAllows(u.host, u.pathname + u.search, crawler))) {
            return { ok: false, message: `${u.host} asks crawlers like ours not to read this page (robots.txt), so we didn't.` };
        }
        const res = await safeFetchText(url, { userAgent: crawler.userAgent, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
        if (res.contentType && !/html|xml/i.test(res.contentType)) {
            return { ok: false, message: 'That link isn\'t a web page (it returned a file).' };
        }
        return { ok: true, html: res.body, finalUrl: res.finalUrl };
    } catch (err) {
        if (err instanceof SafeFetchError) return { ok: false, message: err.message };
        console.error('[site-fetch] fetch failed', { url, message: err instanceof Error ? err.message : String(err) });
        return { ok: false, message: 'We couldn\'t reach that page just now.' };
    }
}
