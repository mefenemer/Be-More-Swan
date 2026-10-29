/**
 * Tell Bing (and the other IndexNow engines) which public URLs this deploy published.
 *
 * Bing feeds Copilot and much of ChatGPT's web search, and IndexNow is how a site tells it about
 * changes instead of waiting to be recrawled. Runs as the LAST step of the Netlify build command.
 *
 * ── Production only ───────────────────────────────────────────────────────────
 * Netlify sets CONTEXT and URL in the build environment. Anything that is not the production build
 * of bemoreswan.com (staging, branch and preview deploys, a local run) logs a line and exits — they
 * must never submit URLs on the live domain's behalf.
 *
 * ── Never fails the build ─────────────────────────────────────────────────────
 * A ping is a hint, not a requirement: Bing still crawls without it. Every path exits 0.
 *
 * ── The key ───────────────────────────────────────────────────────────────────
 * IndexNow proves ownership by fetching https://bemoreswan.com/<key>.txt, whose content is the key.
 * That file lives at the repo root; this script finds it there rather than repeating the key. It is
 * public by design. The build runs BEFORE the deploy is published, so the very first ping can arrive
 * before the key file is live and be refused (HTTP 403) — every later deploy succeeds.
 *
 * The URL list is sitemap.xml as built (Job 7 has added the assistant pages by now) — a small,
 * stable set, and a production deploy is a deliberate release, so resubmitting it is not noise.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'bemoreswan.com';
const log = (msg) => console.log(`[indexnow] ${msg}`);

async function main() {
    const siteHost = (() => { try { return new URL(process.env.URL || '').hostname; } catch { return ''; } })();
    if (process.env.CONTEXT !== 'production' || siteHost.replace(/^www\./, '') !== HOST) {
        return log(`skipped — not the production build of ${HOST} (CONTEXT=${process.env.CONTEXT || 'unset'}, URL=${process.env.URL || 'unset'})`);
    }

    const keyFile = readdirSync(ROOT).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
    if (!keyFile) return log('skipped — no IndexNow key file (<32 hex>.txt) at the repo root');
    const key = keyFile.slice(0, -4);

    const sitemap = join(ROOT, 'sitemap.xml');
    if (!existsSync(sitemap)) return log('skipped — sitemap.xml not found');
    const urlList = [...readFileSync(sitemap, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1].trim())
        .filter((u) => { try { return new URL(u).hostname === HOST; } catch { return false; } });
    if (!urlList.length) return log('skipped — no URLs in sitemap.xml');

    const res = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: HOST, key, keyLocation: `https://${HOST}/${keyFile}`, urlList }),
        signal: AbortSignal.timeout(10_000),
    });
    // 200 = accepted, 202 = accepted, key validation pending. Anything else is reported, not fatal.
    log(`${res.status} ${res.statusText} — submitted ${urlList.length} URLs`);
}

main().catch((err) => log(`failed (${err.message}) — not fatal, Bing still crawls`)).finally(() => process.exit(0));
