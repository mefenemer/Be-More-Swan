/**
 * Tell Bing (and the other IndexNow engines) which public URLs this deploy published.
 *
 * Bing feeds Copilot and much of ChatGPT's web search, and IndexNow is how a site tells it about
 * changes instead of waiting to be recrawled. Run by the local build plugin netlify/plugins/indexnow
 * in `onSuccess` — AFTER the deploy is live — and by hand for a one-off:
 *
 *     CONTEXT=production URL=https://bemoreswan.com node scripts/indexnow-ping.mjs [extra URLs…]
 *
 * ── Production only ───────────────────────────────────────────────────────────
 * Netlify sets CONTEXT and URL in the build environment. Anything that is not the production build
 * of bemoreswan.com (staging, branch and preview deploys, a local run) logs a line and exits — they
 * must never submit URLs on the live domain's behalf.
 *
 * ── Never fails the build ─────────────────────────────────────────────────────
 * A ping is a hint, not a requirement: Bing still crawls without it. Nothing here throws.
 *
 * ── The key, and why the ping waits for it ────────────────────────────────────
 * IndexNow proves ownership by fetching https://bemoreswan.com/<key>.txt, whose content is the key.
 * That file lives at the repo root; this module finds it there rather than repeating the key.
 *
 * ⚠️ A ping sent before that file is live POISONS the key. Until 2026-10-29 this ran at the end of
 * the build command, before the deploy was published, so the first ping arrived ahead of the first
 * key file. Bing's check failed and it went on refusing the key — every later ping got HTTP 403
 * "UserForbiddedToAccessSite", silently, because a refusal was logged as a status line nobody read.
 * So: ping only from onSuccess, and only after reading the live key file back and finding the key.
 * The key was rotated (a new file) at the same time, since the old one stayed refused.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'bemoreswan.com';
const log = (msg) => { console.log(`[indexnow] ${msg}`); return msg; };

/** Submit the sitemap's URLs (plus `extraUrls`). Resolves to a one-line outcome; never rejects. */
export async function pingIndexNow({ env = process.env, extraUrls = [], fetchImpl = fetch } = {}) {
    try {
        const siteHost = (() => { try { return new URL(env.URL || '').hostname; } catch { return ''; } })();
        if (env.CONTEXT !== 'production' || siteHost.replace(/^www\./, '') !== HOST) {
            return log(`skipped — not the production build of ${HOST} (CONTEXT=${env.CONTEXT || 'unset'}, URL=${env.URL || 'unset'})`);
        }

        const keyFile = readdirSync(ROOT).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
        if (!keyFile) return log('skipped — no IndexNow key file (<32 hex>.txt) at the repo root');
        const key = keyFile.slice(0, -4);
        const keyLocation = `https://${HOST}/${keyFile}`;

        // Read the key back from the LIVE site first. A ping Bing cannot verify is not just wasted —
        // it gets the key refused for good (see the header).
        let live = '';
        try {
            const r = await fetchImpl(keyLocation, { signal: AbortSignal.timeout(10_000), headers: { 'Cache-Control': 'no-cache' } });
            live = r.ok ? (await r.text()).trim() : `HTTP ${r.status}`;
        } catch (err) { live = err.message; }
        if (live !== key) return log(`skipped — ${keyLocation} does not serve the key yet (${live.slice(0, 60) || 'empty'}); pinging now would get the key refused`);

        const sitemap = join(ROOT, 'sitemap.xml');
        const fromSitemap = existsSync(sitemap)
            ? [...readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
            : [];
        const urlList = [...new Set([...fromSitemap, ...extraUrls])]
            .filter((u) => { try { return new URL(u).hostname === HOST; } catch { return false; } });
        if (!urlList.length) return log('skipped — no URLs to submit');

        const res = await fetchImpl('https://api.indexnow.org/indexnow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ host: HOST, key, keyLocation, urlList }),
            signal: AbortSignal.timeout(10_000),
        });
        // 200 = accepted, 202 = accepted with key validation pending. Anything else is REPORTED with
        // its body, loudly — a 403 here once went unnoticed for every deploy.
        if (res.status === 200 || res.status === 202) return log(`${res.status} — submitted ${urlList.length} URLs`);
        const body = (await res.text().catch(() => '')).slice(0, 300);
        return log(`⚠️ REFUSED ${res.status} ${res.statusText} — ${body} (not fatal; see docs/bing-and-ai-search-setup.md)`);
    } catch (err) {
        return log(`failed (${err.message}) — not fatal, Bing still crawls`);
    }
}

// Run directly: extra URLs from the command line (e.g. a page that is not in the sitemap).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    pingIndexNow({ extraUrls: process.argv.slice(2) }).finally(() => process.exit(0));
}
