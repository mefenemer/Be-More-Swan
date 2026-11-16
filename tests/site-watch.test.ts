// tests/site-watch.test.ts
// Buying triggers Phase 4 (docs/buying-triggers-plan.md §5, FR#36): "website changed" on the Watch list.
//
// WHY THIS EXISTS. "Added the Meta Pixel: it may be starting to advertise" is a reason for an agency to call.
// A false one sends them chasing nothing. These pin: markers are narrow (a page that merely mentions
// Facebook is not a pixel), the first read is silent, only ADDED tools are news (a half-loaded page must
// not look like a removal), a builder change is one signal, a too-short page never becomes a baseline,
// a first website is matched only on the company's exact name with a UK/.com ending and only when it
// appeared after watching began, and both checks skip quietly until db/z-site-markers.sql is applied.
//
// Run:  npx tsx tests/site-watch.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    detectSiteMarkers, siteChangesToSignals, nameSlug, firstCertForName, launchSignal, normaliseDomain, MIN_HOMEPAGE_CHARS,
} from '../src/lib/triggers/site-watch';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

console.log('Markers');
check('ad tags are detected from their real snippets', () => {
    assert.deepStrictEqual(detectSiteMarkers(`<script>!function(f,b,e,v,n,t,s){t.src='https://connect.facebook.net/en_US/fbevents.js'}();fbq('init', '123');</script>`), ['meta_pixel']);
    assert.deepStrictEqual(detectSiteMarkers(`<script>gtag('config', 'AW-123456789');</script>`), ['google_ads']);
    assert.deepStrictEqual(detectSiteMarkers(`<script>ttq.load('C123');</script>`), ['tiktok_pixel']);
});
check('a page that only links to Facebook, Google or TikTok has no ad tag', () => {
    assert.deepStrictEqual(detectSiteMarkers(`<a href="https://facebook.com/acme">Facebook</a><a href="https://tiktok.com/@acme">TikTok</a> gtag('config', 'G-ABC123')`), []);
});
check('booking, shop and builder markers', () => {
    assert.ok(detectSiteMarkers(`<a href="https://www.fresha.com/a/acme-salon-leeds-xyz">Book</a>`).includes('fresha'));
    assert.ok(detectSiteMarkers(`<link href="//cdn.shopify.com/s/files/1/theme.css">`).includes('shopify'));
    assert.ok(detectSiteMarkers(`<img src="/wp-content/uploads/a.jpg">`).includes('wordpress'));
    assert.deepStrictEqual(detectSiteMarkers('<p>We love WooCommerce tips and Calendly alternatives</p>'), []);
});

console.log('Changes');
check('the first read is silent', () => {
    assert.deepStrictEqual(siteChangesToSignals(null, ['meta_pixel', 'shopify'], 'acme.co.uk', '2026-11-16'), []);
});
check('only ADDED tools are news; a removed one is not', () => {
    const s = siteChangesToSignals(['wordpress', 'meta_pixel'], ['wordpress', 'calendly'], 'acme.co.uk', '2026-11-16');
    assert.deepStrictEqual(s.map((x) => x.kind), ['booking_added']);
    assert.strictEqual(s[0].text, 'Started taking Calendly bookings on its website');
    assert.strictEqual(s[0].direction, 'positive');
    assert.strictEqual(s[0].ref, 'site:calendly');
    assert.strictEqual(s[0].url, 'https://acme.co.uk');
});
check('ad tracking and a shop read as reasons to get in touch', () => {
    const s = siteChangesToSignals(['wordpress'], ['google_ads', 'wordpress', 'woocommerce'], 'acme.co.uk', '2026-11-16');
    assert.deepStrictEqual(s.map((x) => [x.kind, x.direction]), [['ad_tracking_added', 'positive'], ['shop_added', 'positive']]);
    assert.match(s[0].text, /Google Ads conversion tracking .* it may be starting to advertise/);
});
check('a change of builder is ONE neutral signal; a second builder added beside the first is none', () => {
    const r = siteChangesToSignals(['wordpress'], ['squarespace'], 'acme.co.uk', '2026-11-16');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].kind, 'website_rebuilt');
    assert.strictEqual(r[0].direction, 'neutral');
    assert.match(r[0].text, /Rebuilt its website on Squarespace \(it was WordPress\)/);
    assert.deepStrictEqual(siteChangesToSignals(['wordpress'], ['wordpress', 'wix'], 'acme.co.uk', '2026-11-16'), []);
});
check('a too-short home page (parked, JS shell) is never read as markers', () => {
    const src = read('src/lib/lead-watch-sources.ts');
    assert.match(src, /look\.markers = home\.html\.length >= MIN_HOMEPAGE_CHARS \? detectSiteMarkers\(home\.html\) : null/);
    assert.ok(MIN_HOMEPAGE_CHARS >= 1000);
});

console.log('A first website (crt.sh)');
check('the name slug drops company words and refuses short names', () => {
    assert.strictEqual(nameSlug('Acme Signs Ltd'), 'acmesigns');
    assert.strictEqual(nameSlug('The Bread & Butter Co Limited'), 'breadandbutter');
    assert.strictEqual(nameSlug('ABC Ltd'), null);
});
check('only the exact name with .co.uk / .uk / .com counts, earliest certificate wins', () => {
    const entries = [
        { name_value: 'shop.acmesigns.co.uk', not_before: '2026-11-01T00:00:00' },
        { name_value: 'acmesignsltd.com', not_before: '2026-11-02T00:00:00' },
        { name_value: 'acmesigns.net', not_before: '2026-11-03T00:00:00' },
        { name_value: 'www.acmesigns.co.uk\nacmesigns.co.uk', not_before: '2026-11-12T08:00:00' },
        { name_value: 'acmesigns.co.uk', not_before: '2026-11-20T00:00:00' },
    ];
    assert.deepStrictEqual(firstCertForName(entries, 'acmesigns'), { domain: 'acmesigns.co.uk', firstSeen: '2026-11-12' });
    assert.strictEqual(firstCertForName([{ name_value: 'notacmesigns.com', not_before: '2026-11-12' }], 'acmesigns'), null);
});
check('a site that existed before watching began is never news; a new one says "may be theirs"', () => {
    assert.strictEqual(launchSignal({ domain: 'acmesigns.co.uk', firstSeen: '2025-01-01' }, '2026-11-16'), null);
    assert.strictEqual(launchSignal(null, '2026-11-16'), null);
    const s = launchSignal({ domain: 'acmesigns.co.uk', firstSeen: '2026-11-20' }, '2026-11-16')!;
    assert.strictEqual(s.kind, 'website_launched');
    assert.strictEqual(s.ref, 'launch:acmesigns.co.uk');
    assert.match(s.text, /may be theirs: check before you mention it/);
});
check('domains are normalised; internal names refused', () => {
    assert.strictEqual(normaliseDomain('https://www.Acme.co.uk/shop?x=1'), 'acme.co.uk');
    assert.strictEqual(normaliseDomain('localhost'), null);
    assert.strictEqual(normaliseDomain('printer.local'), null);
});

console.log('Wiring');
check('the website check records added tools with source "site" and keeps the old snapshot when unreadable', () => {
    const src = read('src/utils/lead-site-watch.ts');
    assert.match(src, /siteChangesToSignals\(prev, look\.markers, row\.domain, day\)/);
    assert.match(src, /source: 'site'/);
    assert.match(src, /to_jsonb\(c\) -> 'site_markers' AS site_markers/);
    assert.match(src, /hasMarkers && p\.siteMarkers \?/);
});
check('the first-website look skips until its column exists, is paced, and runs inside the daily run', () => {
    const src = read('src/utils/lead-launch-watch.ts');
    assert.match(src, /hasColumn\(db, 'lead_watch', 'crtsh_checked_at'\)/);
    assert.match(src, /CRT_GAP_MS = 2000/);
    assert.match(src, /safeFetchText\(`https:\/\/crt\.sh\//);
    assert.match(read('netlify/functions/run-lead-watch-background.ts'), /checkLaunches\(db, \{ deadline: started \+ RUN_MS \}\)/);
});
check('db/z-site-markers.sql only adds columns', () => {
    const s = read('db/z-site-markers.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.doesNotMatch(s, /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    assert.strictEqual((s.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 3);
});
check('the help article covers the Watch list and its website news', () => {
    const h = read('db/z-watch-list-help-2026-11-16.sql');
    assert.match(h, /'Lead Management', 60, 'The Watch List: News on Your Customers and Leads'/);
    assert.match(h, /add ad tracking/);
    assert.match(h, /may be theirs/);
    const body = h.slice(h.indexOf(", $$") + 4, h.indexOf("$$, TRUE)"));
    assert.ok(body.length > 1000);
    assert.doesNotMatch(body, /;/, 'no semicolons inside the body (the Neon editor splits on them)');
});

console.log(`\n${passed}/${total} passed`);
