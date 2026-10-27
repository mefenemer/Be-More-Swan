// src/utils/site-js-render.ts — read a page the way a visitor's browser sees it, for sites that draw
// their words with JavaScript after the page loads (Wix, Squarespace sections, React/Vue apps, CMS
// sites that fetch /content/*.json — lovecat.studio, 2026-10-27). "Import my current site" calls this
// ONLY when the plain read (site-fetch.ts) found too few words; the result goes through the same
// readImportPage as any other page.
//
// ── The browser never touches the network itself ─────────────────────────────────────────────────
// Every request headless Chrome makes is intercepted. Scripts, data and the page are fetched by US,
// through the SSRF fence (safe-fetch.ts: DNS pinned, private addresses refused, every redirect
// re-checked), and handed to the browser. Pictures, fonts, media and stylesheets are refused — we
// need the words and the <img src>, not the bytes. So a page's script cannot reach 169.254.169.254 or
// localhost any more than a pasted link can. WebSockets and service workers are switched off.
//
// Chromium is @sparticuz/chromium in the deployed function (Linux, unpacked to /tmp on first use);
// set CHROME_PATH to a local Chrome to run it on a dev machine. Loaded lazily, so nothing else that
// imports the import pipeline pays for it. Never throws: a render that fails reads as "no better".

import type { Browser, HTTPRequest } from 'puppeteer-core';
import type { Crawler } from '../lib/robots';
import { safeFetchText, SafeFetchError } from './safe-fetch';
import type { HtmlFetch } from './site-fetch';

/** What one render may do, at most. A page that needs more than this is not one we can read. */
const RENDER_LIMITS = {
    subrequests: 80,
    totalBytes: 12 * 1024 * 1024,
    perRequestTimeoutMs: 10_000,
} as const;

const FETCHED_TYPES = new Set(['document', 'script', 'xhr', 'fetch']);

export interface PageRenderer {
    render(url: string): Promise<HtmlFetch>;
    close(): Promise<void>;
}

/** One browser for the whole import, opened on the first render and closed by the caller. */
export function createPageRenderer(crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }): PageRenderer {
    let browser: Promise<Browser | null> | null = null;

    async function launch(): Promise<Browser | null> {
        try {
            const puppeteer = await import('puppeteer-core');
            const local = process.env.CHROME_PATH;
            if (local) return await puppeteer.launch({ executablePath: local, headless: true, args: ['--no-first-run', '--disable-service-worker'] });
            const chromium = (await import('@sparticuz/chromium')).default;
            return await puppeteer.launch({
                executablePath: await chromium.executablePath(),
                args: [...chromium.args, '--disable-service-worker'],
                headless: true,
            });
        } catch (err) {
            console.error('[site-js-render] could not start the browser', err instanceof Error ? err.message : String(err));
            return null;
        }
    }

    return {
        async render(url) {
            browser ??= launch();
            const b = await browser;
            if (!b) return { ok: false, message: 'We couldn\'t run your site\'s page just now.' };
            return renderOne(b, url, crawler, opts);
        },
        async close() {
            if (!browser) return;
            const b = await browser;
            await b?.close().catch(() => {});
        },
    };
}

async function renderOne(browser: Browser, url: string, crawler: Crawler, opts: { timeoutMs: number; maxBytes: number }): Promise<HtmlFetch> {
    const page = await browser.newPage();
    let requests = 0;
    let bytes = 0;
    try {
        await page.setUserAgent(crawler.userAgent);
        // Request interception does not see WebSockets or WebRTC, so the page gets neither.
        await page.evaluateOnNewDocument(() => {
            for (const k of ['WebSocket', 'RTCPeerConnection', 'webkitRTCPeerConnection']) {
                try { Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch { /* not present */ }
            }
        });
        await page.setRequestInterception(true);
        page.on('request', (req: HTTPRequest) => { void answer(req); });

        async function answer(req: HTTPRequest): Promise<void> {
            if (req.isInterceptResolutionHandled()) return;
            const target = req.url();
            if (target.startsWith('data:')) { await req.continue().catch(() => {}); return; }
            if (!FETCHED_TYPES.has(req.resourceType()) || req.method() !== 'GET' || !/^https?:/i.test(target) ||
                ++requests > RENDER_LIMITS.subrequests || bytes > RENDER_LIMITS.totalBytes) {
                await req.abort('blockedbyclient').catch(() => {});
                return;
            }
            try {
                const res = await safeFetchText(target, {
                    userAgent: crawler.userAgent,
                    timeoutMs: RENDER_LIMITS.perRequestTimeoutMs,
                    maxBytes: req.resourceType() === 'document' ? opts.maxBytes : RENDER_LIMITS.totalBytes - bytes,
                });
                bytes += Buffer.byteLength(res.body);
                await req.respond({
                    status: 200,
                    contentType: res.contentType || 'text/plain',
                    // The page's own fetch() calls are same-origin; a CDN script may be cross-origin.
                    headers: { 'access-control-allow-origin': '*' },
                    body: res.body,
                }).catch(() => {});
            } catch (err) {
                if (!(err instanceof SafeFetchError)) console.error('[site-js-render] subrequest failed', { target, message: err instanceof Error ? err.message : String(err) });
                await req.respond({ status: 404, contentType: 'text/plain', body: '' }).catch(() => {});
            }
        }

        // networkidle0: the page's scripts have fetched what they fetch. Pages that never go idle
        // (analytics pings, live chat) still get read at the deadline below.
        await page.goto(url, { waitUntil: 'networkidle0', timeout: opts.timeoutMs }).catch(() => {});
        const html = await page.content();
        return { ok: true, html, finalUrl: page.url() || url };
    } catch (err) {
        console.error('[site-js-render] render failed', { url, message: err instanceof Error ? err.message : String(err) });
        return { ok: false, message: 'We couldn\'t run your site\'s page just now.' };
    } finally {
        await page.close().catch(() => {});
    }
}
