// tests/site-platform-strapi.test.ts
// The Website import on sites whose content comes from Strapi (src/utils/site-builders/strapi.ts):
// how such a site is recognised, how its resized pictures become the full-size ones, and how words a
// page keeps only in its data are read. Saved SYNTHETIC pages only (a made-up bakery), no network,
// no model: tests/fixtures/site-platforms/strapi/. Report: docs/site-import-platforms/strapi.md
//
// Run:  npx tsx tests/site-platform-strapi.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/strapi';
import { readImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const fixture = (f: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/strapi', f), 'utf8');
const SITE = 'https://www.hollinlane.example';
const detects = (html: string) => adapter.detect(html, '', cheerio.load(html));
const images = (html: string, url = `${SITE}/`) => readImportPage(html, url).blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);

// Two adapters listed before Strapi claim pages that aren't theirs on the base commit: Magento's
// `mage\/` matches inside "image/jpeg", HubSpot's `hs-scripts.com` is HubSpot's tracking code on any
// site. Both are fixed on their own branches; until those merge, this test runs with the fixed tests
// so it checks Strapi's adapter, not theirs (see the report's Detection section).
const restore: Array<() => void> = [];
for (const [key, fixed] of [['magento', /Magento_|(?<![a-z])mage\/|requirejs-config/], ['hubspot', /hubspotusercontent|hs-sites/]] as const) {
    const a = ADAPTERS.find((x) => x.key === key) as { detect: unknown } | undefined;
    if (!a) continue;
    const was = a.detect;
    a.detect = (html: string, gen: string) => gen.includes(key) || fixed.test(html);
    restore.push(() => { a.detect = was; });
}

async function main() {
    console.log('\nRecognising a Strapi site');

    await check('the media library gives it away: Strapi Cloud host, resized-file names, media objects in the data', () => {
        assert.ok(detects(fixture('next-app-about.html')), 'Strapi Cloud media host');
        assert.ok(detects('<img src="https://cms.example/uploads/medium_hero_0f9e8d7c6b.jpg">'), 'resized upload name');
        assert.ok(detects('<img src="/_next/image?url=https%3A%2F%2Fcms.example%2Fuploads%2Fsmall_hero_0f9e8d7c6b.webp&w=640">'), 'inside next/image');
        assert.ok(detects('<script id="__NEXT_DATA__">{"cover":{"alternativeText":null,"provider_metadata":null,"url":"/uploads/a.jpg"}}</script>'), 'media object');
        assert.ok(detects('<script>self.__next_f.push([1,"{\\"alternativeText\\":null,\\"provider_metadata\\":null}"])</script>'), 'escaped in the App Router payload');
        for (const f of ['next-pages-home.html', 'next-csr-visit.html', 'nuxt-home.html']) assert.ok(detects(fixture(f)), f);
    });

    await check('the word "Strapi" alone is not a Strapi site, nor is a WordPress picture called medium_…', () => {
        assert.ok(!detects(fixture('not-strapi-agency.html')));
        assert.ok(!detects(fixture('not-strapi-wordpress.html')));
        assert.ok(!detects('<p>Built with Strapi. Uploads at /uploads/small_team.jpg</p>'));
        assert.ok(!detects('<img src="/uploads/medium_photo_2024031512.jpg">'), 'ten digits is a date, not a Strapi hash');
        assert.strictEqual(adapterFor(fixture('not-strapi-wordpress.html'), cheerio.load(fixture('not-strapi-wordpress.html')))?.key, 'wordpress');
    });

    await check('each Strapi fixture is read by the Strapi adapter', () => {
        for (const f of ['next-pages-home.html', 'next-app-about.html', 'next-csr-visit.html', 'nuxt-home.html']) assert.strictEqual(readImportPage(fixture(f), `${SITE}/`).platform, 'strapi', f);
        assert.strictEqual(readImportPage(fixture('not-strapi-agency.html'), `${SITE}/`).platform, null);
    });

    console.log('\nPictures');

    await check('next/image is unwrapped and the resized copy becomes the upload itself', () => {
        const src = images(fixture('next-pages-home.html'));
        assert.ok(src.includes('https://cms.hollinlane.example/uploads/sourdough_loaves_a1b2c3d4e5.jpg'), src.join('\n'));
        assert.ok(src.includes('https://cms.hollinlane.example/uploads/shop_counter_0f9e8d7c6b.jpg'), 'medium_ → full size');
        assert.ok(!src.some((s) => s.includes('/_next/image')));
    });

    await check('an upload too big to copy (over 8 MB in the page data) keeps its largest resized copy', () => {
        const home = images(fixture('next-pages-home.html'));
        assert.ok(home.includes('https://cms.hollinlane.example/uploads/large_ovens_at_dawn_5a6b7c8d9e.jpg'), home.join('\n'));
        const about = images(fixture('next-app-about.html'));
        assert.ok(about.includes('https://gentle-river-3f2a1b9c0d.media.strapiapp.com/large_our_bakers_9c8b7a6f5e.jpg'), 'srcset picked the 4000w original; the payload says 11 MB');
        assert.ok(about.includes('https://gentle-river-3f2a1b9c0d.media.strapiapp.com/stone_milled_flour_1d2e3f4a5b.jpg'), 'a small one goes full size');
    });

    await check('Nuxt Image (/_ipx/…) is unwrapped onto the Strapi server named in the page', () => {
        assert.deepStrictEqual(images(fixture('nuxt-home.html')), ['https://cms.hollinlane.example/uploads/window_display_3c4d5e6f7a.jpg']);
    });

    await check('fullSizeImage leaves what it cannot be sure of alone', () => {
        readImportPage('<html><body></body></html>', `${SITE}/`);   // a fresh page: no media from the data
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f('https://cms.example/uploads/medium_hero_0f9e8d7c6b.jpg'), 'https://cms.example/uploads/hero_0f9e8d7c6b.jpg');
        assert.strictEqual(f('https://x.example/uploads/medium_team.jpg'), null, 'no Strapi hash: not ours to rename');
        assert.strictEqual(f('https://x.example/photos/hero.jpg'), null);
        assert.strictEqual(f('https://x.example/_next/image?url=%2Fimg%2Fhero.png&w=3840&q=75'), 'https://x.example/img/hero.png');
        assert.strictEqual(f('https://x.example/_next/image?url=javascript%3Aalert(1)&w=64'), null);
    });

    console.log('\nWords kept only in the page data');

    await check('a page drawn in the browser is read from __NEXT_DATA__: Blocks, Markdown, links, a picture, a button', () => {
        const p = readImportPage(fixture('next-csr-visit.html'), `${SITE}/visit`);
        const text = p.blocks.map((b) => ('text' in b ? b.text : '')).join('\n');
        assert.ok(p.words >= 40, `words ${p.words}`);
        assert.ok(p.blocks.some((b) => b.kind === 'heading' && b.text === 'Visit the shop'));
        assert.ok(text.includes('We are at the top of Hollin Lane, opposite the old chapel. Look for the green door.'));
        assert.ok(p.blocks.some((b) => b.kind === 'item' && b.text === 'Saturday, 8am until we sell out'));
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('kindest welcome')));
        const order = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Ordering for a party?')) as { links?: Array<{ text: string; href: string }> };
        assert.deepStrictEqual(order.links, [{ text: 'Send us a message', href: `${SITE}/contact` }]);
        assert.ok(text.includes('There is free parking on Mill Street, two minutes\' walk away.'), 'Markdown ** gone, words kept');
        assert.ok(p.blocks.some((b) => b.kind === 'item' && b.text === 'Step-free entrance'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Get directions'));
        assert.ok(p.blocks.some((b) => b.kind === 'image' && b.alt === 'The green door of the bakery'));
        assert.ok(!text.includes('Loading'), 'the loading line is replaced');
        assert.ok(!/How to find Hollin Lane Bakery|Hollin Lane Bakery$/m.test(text), 'nothing from seo, navbar or footer');
    });

    await check('a server-drawn page is never doubled from its data', () => {
        const p = readImportPage(fixture('next-pages-home.html'), `${SITE}/`);
        assert.strictEqual(p.blocks.filter((b) => b.kind === 'heading' && b.text === 'Bread baked before the town wakes').length, 1);
        assert.ok(!p.blocks.some((b) => b.kind === 'heading' && b.text === 'Home'), 'the data\'s page title is not added');
    });

    await check('words from the data go in as text, never as markup', () => {
        const nd = { props: { pageProps: { page: { title: 'Hello <img src=x onerror=alert(1)>', content: [{ type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script> We bake bread every single morning for the whole village and beyond.' }, { type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', text: 'click' }] }] }] } } } };
        const html = `<html><body><main></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nd).replace(/</g, '\\u003c')}</script><img src="https://c.example/uploads/small_a_0123456abc.jpg"></body></html>`;
        const p = readImportPage(html, `${SITE}/`);
        assert.ok(p.blocks.some((b) => b.kind === 'heading' && b.text === 'Hello <img src=x onerror=alert(1)>'), 'kept as words');
        assert.ok(!p.blocks.some((b) => b.kind === 'image' && b.src.includes('x')  && !b.src.includes('c.example')));
        assert.ok(!JSON.stringify(p.blocks).includes('javascript:'), 'no javascript: link');
    });

    console.log('\nThe whole import (no network, no model)');

    await check('three Strapi pages import: every page read, full-size pictures, the logo copied', async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: fixture('next-pages-home.html'), [`${SITE}/about`]: fixture('next-app-about.html'), [`${SITE}/visit`]: fixture('next-csr-visit.html') };
        const pictures: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url] ?? pages[url.replace(/\/$/, '')]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: '404' }; },
            async plan() { return null; },
            async savePicture(src) { pictures.push(src); return 900 + pictures.length; },
        };
        const current = starterSite({ name: 'Hollin Lane Bakery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        assert.strictEqual(r.report.platform, 'strapi');
        assert.deepStrictEqual(r.report.pages.map((p) => p.read), [true, true, true]);
        assert.ok(r.report.pages[2].words >= 40, 'the browser-drawn Visit page has its words');
        const all = JSON.stringify(r.definition.pages);
        assert.ok(all.includes('Slow sourdough from a small bakery on Hollin Lane.') && all.includes('Look for the green door.'));
        assert.deepStrictEqual(pictures, ['https://cms.hollinlane.example/uploads/logo_hollin_lane_1a2b3c4d5e.png'], 'unplanned: only the logo');
    });

    for (const r of restore) r();
    console.log(`\n${passed}/${total} passed`);
}
main();
