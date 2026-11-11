// tests/site-platform-shopify.test.ts
// The Shopify adapter behind the Website import (src/utils/site-builders/shopify.ts), read against
// SYNTHETIC pages modelled on Dawn (Online Store 2.0) and an older Debut-style theme
// (tests/fixtures/site-platforms/shopify/). No network, no model. Report: docs/site-import-platforms/shopify.md
//
// Run:  npx tsx tests/site-platform-shopify.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { shopifyFullSize } from '../src/utils/site-builders/shopify';
import { readImportPage, type ImportPage } from '../src/utils/site-extract';
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
const fixture = (n: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/shopify', `${n}.html`), 'utf8');
const SITE = 'https://hollowoak.example';
const read = (n: string, path = '/') => readImportPage(fixture(n), `${SITE}${path}`);
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (p: ImportPage) => p.blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;

async function main() {
    console.log('\nShopify: recognising a shop');

    await check('Dawn and Debut-style pages are recognised as Shopify', () => {
        for (const n of ['home', 'legacy-home', 'contact', 'collection']) assert.strictEqual(found(fixture(n)), 'shopify', n);
        assert.strictEqual(read('home').platform, 'shopify');
    });

    await check('a page that only hot-links a picture from cdn.shopify.com is not a Shopify shop', () => {
        assert.strictEqual(found('<html><body><main><p>Our studio</p><img src="https://cdn.shopify.com/s/files/1/0000/0001/files/a.jpg"></main></body></html>'), null);
    });

    console.log('\nShopify: words, menu and links');

    await check('the owner\'s words come through in order, with a link inside a sentence kept', () => {
        const p = read('home');
        const t = texts(p);
        for (const w of ['Small-batch candles, poured by hand', 'Every candle starts in our Hebden Bridge workshop.', 'Made slowly, burns slowly', 'Why our candles', 'How long does a candle burn?', 'About fifty hours, if you trim the wick each time.', 'Join the candle club']) assert.ok(t.includes(w), w);
        assert.ok(t.indexOf('Small-batch candles, poured by hand') < t.indexOf('Made slowly, burns slowly'));
        const para = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('We pour soy wax')) as { links?: { text: string; href: string }[] };
        assert.deepStrictEqual(para.links, [{ text: 'how we started', href: `${SITE}/pages/our-story` }]);
    });

    await check('product cards become their names with links: no prices, badges, hover copies, reviews or "Choose options"', () => {
        const p = read('home');
        const items = p.blocks.filter((b) => b.kind === 'item').map((b) => (b as { text: string }).text);
        assert.ok(items.includes('Moorland Heather Candle') && items.includes('Calder River Candle'), items.join(' | '));
        const all = JSON.stringify(p.blocks);
        for (const junk of ['£', 'Regular price', 'Sale price', 'Unit price', 'Sold out', '"Sale"', 'Choose options', '12 reviews', 'Slide left', 'Load video', 'moorland-candle-2']) assert.ok(!all.includes(junk), junk);
        const item = p.blocks.find((b) => b.kind === 'item' && b.text === 'Moorland Heather Candle') as { links?: { href: string }[] };
        assert.strictEqual(item.links?.[0].href, `${SITE}/products/moorland-heather-candle`);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'View all' && b.href === `${SITE}/collections/all`));
    });

    await check('the cart drawer, announcement bar, app blocks, Inbox chat and privacy banner are left out', () => {
        const all = JSON.stringify(read('home').blocks);
        for (const junk of ['Your cart is empty', 'Continue shopping', 'Free UK delivery', 'Item added to your cart', 'Let customers speak for us', 'We use cookies', 'Powered by Shopify']) assert.ok(!all.includes(junk), junk);
    });

    await check('the menu is read once, drop-downs under their names, without Log in, Cart or the country picker', () => {
        const nav = read('home').navLinks;
        assert.deepStrictEqual(nav.map((l) => [l.text, l.group ?? null]), [['Home', null], ['All candles', 'Candles'], ['Travel tins', 'Candles'], ['Workshops', null], ['Our story', null], ['Contact', null]]);
        const legacy = read('legacy-home').navLinks;
        assert.deepStrictEqual(legacy.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Leather journals', 'Journals'], ['Linen journals', 'Journals'], ['About us', null]]);
        assert.ok(!read('contact', '/pages/contact').navLinks.some((l) => /log in|cart/i.test(l.text)));
    });

    await check('a phone-only drawer menu still keeps its drop-downs\' names', () => {
        const html = fixture('home').replace(/<nav class="header__inline-menu">[\s\S]*?<\/nav>/, '');
        const nav = readImportPage(html, `${SITE}/`).navLinks;
        assert.deepStrictEqual(nav.filter((l) => l.group).map((l) => [l.text, l.group]), [['All candles', 'Candles'], ['Travel tins', 'Candles']]);
    });

    await check('a collection page: its title without "Collection:", no count, sorting or page numbers', () => {
        const p = read('collection', '/collections/candles');
        assert.strictEqual(p.blocks[0].kind === 'heading' && p.blocks[0].text, 'All candles');
        const t = texts(p);
        assert.ok(!t.some((x) => /products|sort by/i.test(x)), t.join(' | '));
        assert.deepStrictEqual(p.navLinks, []);
        assert.ok(!p.hasForm);
    });

    console.log('\nShopify: forms');

    await check('search, country and newsletter forms are not an enquiry form; the contact page\'s is, with its questions', () => {
        const home = read('home');
        assert.strictEqual(home.hasForm, false);
        assert.deepStrictEqual(home.formFields, []);
        const contact = read('contact', '/pages/contact');
        assert.ok(contact.hasForm);
        assert.deepStrictEqual(contact.formFields, ['Name', 'Email', 'Phone number', 'Comment']);
        assert.ok(!texts(contact).includes('Contact form'));   // a heading only screen readers hear
        assert.deepStrictEqual(contact.contact.phones, ['+441422000000']);
    });

    console.log('\nShopify: pictures');

    await check('pictures are asked for at full size: &width=, _300x, _600x600_crop_center@2x and the lazy {width}x', () => {
        assert.strictEqual(shopifyFullSize(`${SITE}/cdn/shop/files/bench.jpg?v=17&width=533`), `${SITE}/cdn/shop/files/bench.jpg?v=17&width=2000`);
        assert.strictEqual(shopifyFullSize('https://cdn.shopify.com/s/files/1/0000/0001/files/a_300x.jpg?v=1'), 'https://cdn.shopify.com/s/files/1/0000/0001/files/a.jpg?v=1&width=2000');
        assert.strictEqual(shopifyFullSize('https://cdn.shopify.com/s/files/1/0000/0001/products/a_600x600_crop_center@2x.png?v=1'), 'https://cdn.shopify.com/s/files/1/0000/0001/products/a.png?v=1&width=2000');
        assert.strictEqual(shopifyFullSize('https://cdn.shopify.com/s/files/1/0000/0001/products/a_%7Bwidth%7Dx.jpg?v=1'), 'https://cdn.shopify.com/s/files/1/0000/0001/products/a.jpg?v=1&width=2000');
        assert.strictEqual(shopifyFullSize('https://cdn.shopify.com/s/files/1/0000/0001/products/a_grande.jpg'), 'https://cdn.shopify.com/s/files/1/0000/0001/products/a.jpg?width=2000');
        // A name that only contains a size in the middle is the uploaded file's own name.
        assert.strictEqual(shopifyFullSize(`${SITE}/cdn/shop/products/helix_1800x1800_10c6.jpg?v=1`), `${SITE}/cdn/shop/products/helix_1800x1800_10c6.jpg?v=1&width=2000`);
        assert.strictEqual(shopifyFullSize('https://images.example/a_300x.jpg'), null);
        assert.strictEqual(shopifyFullSize(`${SITE}/cdn/shop/files/icon.svg?v=1`), null);
    });

    await check('the pages\' pictures: one copy each at full size, the hover copy dropped, the video as its own thumbnail and a button', () => {
        const home = images(read('home'));
        assert.deepStrictEqual(home, [
            `${SITE}/cdn/shop/files/workshop-bench.jpg?v=1700000002&width=2000`,
            `${SITE}/cdn/shop/files/moorland-candle-1.jpg?v=1700000003&width=2000`,
            `${SITE}/cdn/shop/files/river-candle-1.jpg?v=1700000004&width=2000`,
            'https://i.ytimg.com/vi/AbCdEf12345/hqdefault.jpg',
        ]);
        assert.ok(read('home').blocks.some((b) => b.kind === 'button' && b.href === 'https://www.youtube.com/watch?v=AbCdEf12345'));
        const legacy = images(read('legacy-home'));
        assert.deepStrictEqual(legacy, [
            'https://cdn.shopify.com/s/files/1/0000/0001/files/bindery.jpg?v=1600000002&width=2000',
            'https://cdn.shopify.com/s/files/1/0000/0001/files/stitching.jpg?v=1600000003&width=2000',
            'https://cdn.shopify.com/s/files/1/0000/0001/products/oak-journal.jpg?v=1600000004&width=2000',
        ]);
    });

    await check('a video Shopify hosts keeps its poster picture, without "Load video:" in its description', () => {
        const html = fixture('home').replace(/<template><iframe[\s\S]*?<\/template>/, '<template><video playsinline controls><source src="//hollowoak.example/cdn/shop/videos/c/vp/x.mp4"></video></template>');
        const p = readImportPage(html, `${SITE}/`);
        const poster = p.blocks.find((b) => b.kind === 'image' && b.src.includes('video-poster')) as { alt: string } | undefined;
        assert.strictEqual(poster?.alt, 'Pouring a batch of candles');
    });

    console.log('\nShopify: the whole import, no network and no model');

    await check('runImport reads the shop\'s home, collection and contact pages; cart and account pages never', async () => {
        const pages: Record<string, string> = {
            [`${SITE}/`]: fixture('home'),
            [`${SITE}/collections/candles`]: fixture('collection'),
            [`${SITE}/pages/contact`]: fixture('contact'),
        };
        const asked: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { asked.push(url); const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture() { return null; },
        };
        const current = starterSite({ name: 'Hollow Oak Candle Co.', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 10 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.ok(!asked.some((u) => /\/(cart|account)/.test(u)), asked.join(' '));
        assert.deepStrictEqual(r.report.pages.filter((p) => p.read).map((p) => p.title), ['Home', 'All candles', 'Contact']);
        assert.deepStrictEqual(r.report.prices, []);   // product prices are Shopify's furniture here, not the owner's sentences
        assert.ok(r.report.hadForm);
        assert.strictEqual(r.report.contact.email, 'hello@hollowoak.example');
        const site = JSON.stringify(r.definition);
        assert.ok(site.includes('Small-batch candles, poured by hand') && site.includes('About fifty hours'));
        assert.ok(!/Regular price|Sold out|Your cart is empty|£18/.test(site));
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
