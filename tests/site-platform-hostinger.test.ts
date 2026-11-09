// tests/site-platform-hostinger.test.ts
// The Website import on Hostinger Website Builder sites (src/utils/site-builders/hostinger.ts).
// Fixtures are SYNTHETIC (an invented florist), modelled on real Hostinger markup seen 2026-11-08:
// Astro + Vue islands, header and footer inside <main>, comma-filled Cloudflare srcsets, desktop and
// phone copies of each picture, "Embed code" boxes filled from the island's props.
// Report: docs/site-import-platforms/hostinger.md
//
// Run:  npx tsx tests/site-platform-hostinger.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/hostinger';
import { readImportPage, type ImportBlock } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const dir = join(__dirname, 'fixtures/site-platforms/hostinger');
const fixture = (f: string) => readFileSync(join(dir, f), 'utf8');
const SITE = 'https://bramble-birch.example';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (blocks: ImportBlock[]) => blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (blocks: ImportBlock[]) => blocks.filter((b): b is Extract<ImportBlock, { kind: 'image' }> => b.kind === 'image');

(async () => {
    const home = readImportPage(fixture('home.html'), `${SITE}/`);
    const contact = readImportPage(fixture('contact.html'), `${SITE}/contact`);

    console.log('Detection');

    await check('Hostinger Website Builder and AI Builder pages are recognised', () => {
        assert.strictEqual(found(fixture('home.html')), 'hostinger');
        assert.strictEqual(found(fixture('contact.html')), 'hostinger');
        assert.strictEqual(home.platform, 'hostinger');
        assert.strictEqual(found('<html><head><meta name="generator" content="Zyro"></head><body><main>x</main></body></html>'), 'hostinger');
    });

    await check('without the generator tag, Hostinger\'s picture host plus its grid markup still says Hostinger', () => {
        const html = '<html><body><main class="page"><div class="page__blocks"><div class="text-box layout-element__component layout-element__component--GridTextBox"><p>x</p></div><img src="https://assets.zyrosite.com/cdn-cgi/image/w=768/abc/a.jpg"></div></main></body></html>';
        assert.strictEqual(found(html), 'hostinger');
    });

    await check('the bare word "Zyro", or a picture borrowed from zyrosite.com, is not a Hostinger site', () => {
        assert.strictEqual(found('<html><body><main><h1>Zyro vs Wix: which builder?</h1><p>We tried Zyro last year.</p></main></body></html>'), null);
        // (Other adapters may claim this page — Magento's starter detect matches "mage/" in "/cdn-cgi/image/" — but not Hostinger.)
        assert.notStrictEqual(found('<html><body><main><img src="https://assets.zyrosite.com/cdn-cgi/image/w=768/abc/a.jpg"></main></body></html>'), 'hostinger');
        assert.strictEqual(found('<html><head><meta name="generator" content="WordPress 6.6"></head><body><main><p>Hosted by Hostinger, built with zyro tips</p></main></body></html>'), 'wordpress');
    });

    console.log('\nReading a page');

    await check('their words come out in order; the header, cart and footer are not content', () => {
        const t = texts(home.blocks);
        assert.strictEqual(t[0], 'Flowers picked this morning, arranged by hand');
        assert.ok(t.indexOf('What we do') > t.indexOf('Order a bouquet'));
        for (const no of ['Shopping Bag', 'Home', 'Contact', 'hello@bramble-birch.example', 'Instagram', 'Find us at the Saturday market, stall 12.']) assert.ok(!t.includes(no), no);
        assert.ok(!t.some((x) => x.startsWith('©')));
        assert.ok(!images(home.blocks).some((b) => b.src.includes('bramble-logo')), 'the logo is the logo, not a picture on the page');
    });

    await check('the menu keeps its drop-down group, same site only, and the logo is found', () => {
        assert.deepStrictEqual(home.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Weddings', 'Flowers'], ['Workshops', 'Flowers'], ['Contact', null]]);
        assert.ok(home.logo && home.logo.src.includes('bramble-logo') && home.logo.alt === 'Bramble & Birch logo');
    });

    await check('the footer\'s email, phone and social links are still read', () => {
        assert.deepStrictEqual(home.contact.emails, ['hello@bramble-birch.example']);
        assert.ok(home.contact.phones.includes('01632 960123'));
        assert.deepStrictEqual(home.socialLinks, ['https://www.instagram.com/bramble.birch.example/', 'https://www.facebook.com/brambleandbirchexample']);
        assert.deepStrictEqual(contact.contact.emails, ['hello@bramble-birch.example'], 'the AI Builder\'s block--footer too');
        assert.ok(!texts(contact.blocks).includes('Find us at the Saturday market, stall 12.'));
    });

    await check('pictures: one full-size copy each, never a broken address cut from a comma-filled srcset', () => {
        const srcs = images(home.blocks).map((b) => b.src);
        assert.deepStrictEqual(srcs, [
            'https://assets.zyrosite.com/cdn-cgi/image/w=1600,fit=scale-down/AbCdEf123GhIjK45/dahlias-in-bucket-M1n2O3p4Q5r6S7t8.jpg',
            'https://images.unsplash.com/photo-1000000000000-abcdef?auto=format&fit=max&w=1600',
            'https://i.ytimg.com/vi/AbCdEfGhIjK/hqdefault.jpg',
        ]);
        assert.ok(!srcs.some((s) => s.startsWith(SITE)), 'no picture address on their own domain made from a srcset fragment');
        assert.strictEqual(images(home.blocks)[0].alt, 'Dahlias in a zinc bucket');
        assert.ok(images(contact.blocks)[0].src.endsWith('/w=1600,fit=scale-down/AbCdEf123GhIjK45/studio-door-U1v2W3x4Y5z6A7b8.jpg'));
    });

    await check('an "Embed code" box drawn by JavaScript is read from the page\'s data; a script-only one adds nothing', () => {
        const t = texts(home.blocks);
        const at = t.indexOf('Questions people ask');
        assert.deepStrictEqual(t.slice(at, at + 5), ['Questions people ask', 'Do you deliver?', 'Yes, by bicycle within three miles of the studio on Fridays.', 'Can I choose the colours?', 'Tell us a mood and we will pick what is blooming that week.']);
        assert.ok(t.includes('Watch the video'), 'the embedded video becomes a button');
        assert.ok(!t.includes('FAQ'), 'the embed\'s own <title> is not content');
        assert.ok(!JSON.stringify(home.blocks).includes('widgetcode'));
    });

    await check('an element hidden on both computers and phones is not on their site', () => {
        assert.ok(!texts(home.blocks).includes('Old opening hours from last winter'));
    });

    await check('inline links, buttons and the contact page\'s form questions survive', () => {
        const weddings = home.blocks.find((b) => b.kind === 'text' && b.text.startsWith('From buttonholes'));
        assert.deepStrictEqual(weddings && 'links' in weddings ? weddings.links : null, [{ text: 'our wedding flowers', href: `${SITE}/weddings` }]);
        assert.deepStrictEqual(home.blocks.filter((b) => b.kind === 'button' && b.href?.startsWith(SITE)).map((b) => (b as { text: string }).text), ['Order a bouquet', 'See workshop dates']);
        assert.deepStrictEqual(contact.formFields, ['Your name', 'Your message']);
        assert.ok(texts(contact.blocks).includes('Unit 4, The Old Dairy, Exampleton'));
    });

    await check('full-size pictures: Hostinger\'s resize addresses only; custom domains and other hosts are left alone', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f('https://assets.zyrosite.com/cdn-cgi/image/format=auto,w=375,h=273,fit=crop/Xy1/a-b.png'), 'https://assets.zyrosite.com/cdn-cgi/image/w=1600,fit=scale-down/Xy1/a-b.png');
        assert.strictEqual(f('https://bramble-birch.example/cdn-cgi/image/w=375/Xy1/a.png'), null);
        assert.strictEqual(f('https://assets.zyrosite.com/Xy1/a.png'), null);
        assert.strictEqual(f('https://example.org/a.jpg'), null);
        assert.strictEqual(f('not a url'), null);
    });

    await check('a page with broken island props is still read as it is', () => {
        const html = fixture('home.html').replace(/props="\{&quot;pageData[^"]*"/, 'props="{&quot;pageData&quot;:[0,{oops"');
        const p = readImportPage(html, `${SITE}/`);
        assert.strictEqual(p.platform, 'hostinger');
        assert.ok(texts(p.blocks).includes('Flowers picked this morning, arranged by hand'));
        assert.ok(!texts(p.blocks).includes('Do you deliver?'));
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport reads home and contact, copies only their pictures, and keeps every non-price word', async () => {
        const pages: Record<string, string> = { '/': 'home.html', '/contact': 'contact.html' };
        const saved: string[] = [];
        const page = async (url: string) => {
            const f = pages[new URL(url).pathname];
            return f ? { ok: true as const, html: fixture(f), finalUrl: url } : { ok: false as const, message: 'Not found (404)' };
        };
        const deps: ImportDeps = {
            fetchHtml: page,
            renderHtml: async () => ({ ok: false, message: 'no browser in tests' }),
            plan: async () => null,
            savePicture: async (src) => { saved.push(src); return 700 + saved.length; },
            fetchCss: async () => null,
        };
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: starterSite({ name: 'Bramble & Birch', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null)), maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'hostinger');
        assert.deepStrictEqual(r.report.pages.filter((p) => p.read).map((p) => p.title), ['Home', 'Contact']);
        const all = JSON.stringify(r.definition.pages);
        for (const w of ['Flowers picked this morning, arranged by hand', 'Do you deliver?', 'Come and see us']) assert.ok(all.includes(w), w);
        assert.ok(!all.includes('Shopping Bag') && !all.includes('Old opening hours'));
        assert.ok(saved.length >= 1 && saved.every((s) => /^https:\/\/(assets\.zyrosite\.com|images\.unsplash\.com|i\.ytimg\.com)\//.test(s)), saved.join(' '));
        assert.ok(saved.some((s) => s.includes('bramble-logo')), 'the logo is copied');
        assert.strictEqual(r.report.contact.email, 'hello@bramble-birch.example');
        assert.ok(r.report.hadForm);
    });

    console.log(`\n${passed}/${total} passed`);
})();
