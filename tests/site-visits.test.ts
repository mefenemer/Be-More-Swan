// tests/site-visits.test.ts — visitor counts for websites published by the Website Assistant.
// Counted at the sites edge (every view passes it, before any cache), without cookies, IPs or browser
// strings ever reaching the app. db/z-site-visits.sql, src/utils/site-visits.ts.
//
// Run:  npx tsx tests/site-visits.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BOT_RE, countablePath, isBot, normalisePath, refHostOf, visitsLine, type VisitStats } from '../src/utils/site-visits';

const read = (f: string) => readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const edgeSrc = read('sites-host/edge-functions/serve.ts');
let passed = 0;
const checks: [string, () => void | Promise<void>][] = [];
const check = (n: string, fn: () => void | Promise<void>) => checks.push([n, fn]);

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

check('what counts: pages people read, not forms, files, checks or bots', () => {
    for (const p of ['/', '/about', '/listings/jazz-night', '/blog/how-we-roast', '/?category=Music']) assert.ok(countablePath(p), p);
    for (const p of ['/_form', '/_post', '/_book', '/_review', '/sitemap.xml', '/robots.txt', '/listings/x.ics', '/favicon.ico', '/site-fonts/a.woff2', '/.well-known/bms-domain-check']) assert.ok(!countablePath(p), p);
    assert.ok(!isBot(CHROME));
    for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'facebookexternalhit/1.1', 'curl/8.4.0', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', 'python-requests/2.31', '', 'short']) assert.ok(isBot(ua), ua);
    assert.strictEqual(normalisePath('/About/'), '/about');
    assert.strictEqual(normalisePath('/?category=Music'), '/');
    assert.strictEqual(refHostOf('https://www.google.com/search?q=secret', 'syros.bemoreswan.site'), 'google.com', 'host only — never the search words');
    assert.strictEqual(refHostOf('https://syros.bemoreswan.site/about', 'syros.bemoreswan.site'), null, 'their own site is not a referrer');
    assert.strictEqual(refHostOf('not a url', 'x'), null);
});

check('the edge has the SAME bot list and page rules as the app (it cannot import them)', () => {
    assert.ok(edgeSrc.includes(`const BOT_RE = ${BOT_RE.toString()};`), 'BOT_RE drifted between sites-host and site-visits.ts');
    const body = (src: string) => src.slice(src.indexOf('function countablePath(path: string): boolean {'), src.indexOf('\n}', src.indexOf('function countablePath(path: string): boolean {'))).trim();
    assert.strictEqual(body(edgeSrc), body(read('src/utils/site-visits.ts')).replace('export ', ''), 'countablePath drifted');
});

check('the edge counts a person\'s page view after answering, sends a hash — never the IP or browser — and skips the rest', async () => {
    const sent: Array<{ url: string; body: Record<string, string> }> = [];
    (globalThis as any).Netlify = { env: { get: (k: string) => ({ APP_ORIGIN: 'https://app.example', SITE_SERVE_SECRET: 'k3y' } as Record<string, string>)[k] } };
    const realFetch = globalThis.fetch;
    let pageType = 'text/html; charset=utf-8';
    let pageStatus = 200;
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
        if (String(url).includes('/site-visit')) { sent.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response('{"ok":true}'); }
        return new Response('<h1>hi</h1>', { status: pageStatus, headers: { 'content-type': pageType } });
    };
    try {
        const edge = (await import('../sites-host/edge-functions/serve')).default;
        const waits: Promise<unknown>[] = [];
        const ctx = { ip: '203.0.113.9', waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
        const get = (p: string, ua = CHROME, headers: Record<string, string> = {}) => edge(new Request(`https://syros.bemoreswan.site${p}`, { headers: { 'user-agent': ua, ...headers } }), ctx);
        const res = await get('/about', CHROME, { referer: 'https://www.instagram.com/p/abc?igsh=1' });
        assert.strictEqual(res.status, 200);
        await Promise.all(waits);
        assert.strictEqual(sent.length, 1);
        const b = sent[0].body;
        assert.strictEqual(sent[0].url, 'https://app.example/.netlify/functions/site-visit');
        assert.deepStrictEqual(Object.keys(b).sort(), ['host', 'path', 'ref', 'visitor']);
        assert.strictEqual(b.ref, 'instagram.com');
        assert.match(b.visitor, /^[a-f0-9]{32}$/);
        assert.ok(!JSON.stringify(b).includes('203.0.113') && !JSON.stringify(b).includes('Chrome'), 'no IP, no browser string');
        // Same person, same day → same hash; another site → a different one (no tracking across sites).
        await get('/'); await Promise.all(waits);
        assert.strictEqual(sent[1].body.visitor, b.visitor);
        await edge(new Request('https://other.bemoreswan.site/', { headers: { 'user-agent': CHROME } }), ctx); await Promise.all(waits);
        assert.notStrictEqual(sent[2].body.visitor, b.visitor);
        const before = sent.length;
        await get('/', 'Googlebot/2.1 (+http://www.google.com/bot.html)');
        await get('/sitemap.xml');
        await get('/', CHROME, { 'sec-purpose': 'prefetch' });
        await edge(new Request('https://syros.bemoreswan.site/', { method: 'HEAD', headers: { 'user-agent': CHROME } }), ctx);
        pageStatus = 404; await get('/nope'); pageStatus = 200;
        pageType = 'text/calendar'; await get('/listings/a'); pageType = 'text/html';
        await Promise.all(waits);
        assert.strictEqual(sent.length, before, 'bots, files, prefetches, HEAD, 404s and non-pages are not counted');
    } finally { (globalThis as any).fetch = realFetch; }
});

check('the app side: shared key, published sites only, upserts, hashes purged, 200 not 204', () => {
    const fn = read('netlify/functions/site-visit.ts');
    assert.ok(fn.includes("keyMatches(h['x-site-serve-key'], process.env.SITE_SERVE_SECRET)"));
    assert.ok(fn.includes("site.status !== 'published'"));
    assert.ok(!/statusCode: 204/.test(fn), 'a 204 with an empty body is a 502 under withLambda');
    const lib = read('src/utils/site-visits.ts');
    assert.ok(lib.includes('.onConflictDoNothing()') && lib.includes('onConflictDoUpdate'));
    assert.ok(lib.includes("lt(siteVisitSeen.day, addDays(ukDay(now), -1))"), 'hashes older than yesterday are deleted');
    const sql = read('db/z-site-visits.sql');
    assert.ok(!/\bip\b|user_agent/i.test(sql.split('BEGIN;')[1]), 'no IP or browser column');
});

check('the Results tab and the chat read the same figures, and the chat may not invent others', () => {
    const api = read('netlify/functions/sites.ts');
    assert.ok(api.includes("if (action === 'visits') {") && api.includes('await visitStats(db, site.id)'));
    const a = read('assistants.js');
    assert.ok(a.includes("post({ action: 'visits', assistantId })") && a.includes('function _paintSiteVisitDetail(s)'));
    assert.ok(read('src/components/assistant-dashboard-registry.js').includes("{ label: 'Visitors', title: 'In the Last 30 Days'"));
    const stats: VisitStats = { days: 30, from: '2026-10-07', to: '2026-11-05', views: 120, visitors: 45, prevViews: 80, prevVisitors: 30, series: [], topPages: [{ path: '/', views: 70 }], topRefs: [{ host: 'instagram.com', visits: 12 }] };
    const line = visitsLine(stats, true);
    assert.ok(line.includes('45 visitors, 120 page views') && line.includes('instagram.com 12') && line.includes('never invent others'));
    assert.match(visitsLine(stats, false), /counted once the site is published/);
    assert.ok(read('src/utils/site-store.ts').includes('visitsLine(v, site.status === \'published\')'));
});

(async () => {
    for (const [n, fn] of checks) { try { await fn(); passed++; console.log(`  ✓ ${n}`); } catch (e) { console.log(`  ✗ ${n}\n    ${(e as Error).message}`); } }
    console.log(`\n${passed}/${checks.length} passed`);
    if (passed !== checks.length) process.exit(1);
})();
