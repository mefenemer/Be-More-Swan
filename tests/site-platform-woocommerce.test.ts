// tests/site-platform-woocommerce.test.ts
// The Website import on WooCommerce shops (src/utils/site-builders/woocommerce.ts): classic themes
// (Storefront-style product loops, shop archive, single product) and block themes (Product Collection,
// Mini-Cart). Saved SYNTHETIC pages only — no network, no model: tests/fixtures/site-platforms/woocommerce/.
// Report: docs/site-import-platforms/woocommerce.md
//
// Run:  npx tsx tests/site-platform-woocommerce.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, wooFullSizeImage } from '../src/utils/site-builders/woocommerce';
import { readImportPage, type ImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { readImportedLook } from '../src/utils/site-import-theme';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const dir = join(__dirname, 'fixtures/site-platforms/woocommerce');
const fixture = (f: string) => readFileSync(join(dir, f), 'utf8');
const SITE = 'https://fernbrook.example';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : '')).filter(Boolean);
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));
const all = (p: ImportPage) => texts(p).join('\n');

const home = () => readImportPage(fixture('storefront-home.html'), `${SITE}/`);
const shop = () => readImportPage(fixture('shop.html'), `${SITE}/shop/`);
const product = () => readImportPage(fixture('product.html'), `${SITE}/product/moorland-heather-candle/`);
const blocks = () => readImportPage(fixture('block-home.html'), 'https://ashgrove.example/');
const story = () => readImportPage(fixture('our-story.html'), `${SITE}/our-story/`);

async function main() {
    console.log('\nDetection');

    await check('every WooCommerce page is WooCommerce, not plain WordPress — content pages too', () => {
        for (const f of ['storefront-home.html', 'shop.html', 'product.html', 'block-home.html', 'our-story.html']) assert.strictEqual(found(fixture(f)), 'woocommerce', f);
    });

    await check('a WordPress blog post that only MENTIONS WooCommerce stays WordPress', () => {
        const html = '<html><head><meta name="generator" content="WordPress 7.1"></head><body class="single-post"><main><h1>Why we moved off woocommerce</h1><p>Our woocommerce shop was slow.</p></main></body></html>';
        assert.strictEqual(found(html), 'wordpress');
    });

    await check('signals: generator tag, plugin assets, body class, block markup — any one is enough', () => {
        assert.strictEqual(found('<html><head><meta name="generator" content="WooCommerce 9.8.7"></head><body><main>x</main></body></html>'), 'woocommerce');
        assert.strictEqual(found('<html><head><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css"></head><body><main>x</main></body></html>'), 'woocommerce');
        assert.strictEqual(found('<html><body class="page woocommerce-no-js"><main>x</main></body></html>'), 'woocommerce');
        assert.strictEqual(found('<html><body><main><ul class="wc-block-product-template"></ul><div class="wp-block-woocommerce-mini-cart"></div></main></body></html>'), 'woocommerce');
    });

    console.log('\nReading a page');

    await check('the menu keeps their pages; mini-cart, "My account" and pagination are not menu items', () => {
        assert.deepStrictEqual(home().navLinks.map((l) => l.text), ['Home', 'Shop', 'Candles', 'Wax melts', 'Our story', 'Workshops', 'Contact']);
        assert.deepStrictEqual(shop().navLinks.map((l) => l.text), ['Home', 'Shop', 'Contact']);
        assert.deepStrictEqual(story().navLinks.map((l) => l.text), ['Home', 'Our story']);
        assert.ok(!blocks().navLinks.some((l) => /login|cart/i.test(l.text)));
    });

    await check('shop categories in the menu are catalogue pages, read after their own pages, still under "Shop"', () => {
        const nav = home().navLinks;
        const candles = nav.find((l) => l.text === 'Candles')!;
        assert.ok(candles.catalogue && candles.group === 'Shop');
        assert.ok(!nav.find((l) => l.text === 'Our story')!.catalogue);
    });

    await check('a product card becomes its name (linked to its page) and its picture — no price, badge, stars or basket button', () => {
        const p = home();
        const card = p.blocks.find((b) => b.kind === 'item' && b.text === 'Moorland Heather candle');
        assert.ok(card && 'links' in card && card.links?.[0].href === `${SITE}/product/moorland-heather-candle/`);
        assert.ok(p.blocks.some((b) => b.kind === 'item' && b.text === 'Rhubarb & Custard wax melts'));
        assert.doesNotMatch(all(p), /£|Sale!|Rated|Add to basket|Select options|Read more|add-to-cart/);
        // Category tiles lose their "(6)" product count.
        assert.ok(p.blocks.some((b) => b.kind === 'item' && b.text === 'Candles'));
    });

    await check('their own words are all still there, inline links included', () => {
        const p = home();
        assert.ok(texts(p).includes('Hand-poured soy candles from Hebden Bridge'));
        const intro = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Every candle'));
        assert.ok(intro && 'links' in intro && intro.links?.length === 2);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Browse the shop'));
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('Stoodley Pike')));
    });

    await check('pictures at full size: WordPress sizes, Jetpack\'s CDN and Optimole\'s CDN', () => {
        const imgs = images(home());
        assert.ok(imgs.includes(`${SITE}/wp-content/uploads/2025/02/moorland-heather.jpg`));
        assert.ok(imgs.includes(`${SITE}/wp-content/uploads/2025/02/workbench.jpg`), 'a CSS background picture too');
        assert.ok(imgs.includes('https://i0.wp.com/fernbrook.example/wp-content/uploads/2025/02/canal-fig.jpg'));
        assert.ok(imgs.includes(`${SITE}/wp-content/uploads/2025/02/rhubarb-melts.jpg`));
        assert.ok(!imgs.some((s) => /-\d+x\d+\.|optimole|resize=/.test(s)), imgs.join('\n'));
        assert.strictEqual(wooFullSizeImage(`${SITE}/wp-content/uploads/2025/02/x-scaled.jpg`), null, '-scaled is already WordPress\'s full size');
        assert.strictEqual(wooFullSizeImage('https://cdn.example/x-300x300.jpg'), null, 'only WordPress uploads');
    });

    await check('the shop page: its title and description; sorting, result count, notices and filters are gone', () => {
        const p = shop();
        assert.deepStrictEqual(texts(p), ['Shop', 'Our full range of candles and wax melts, poured to order. Orders placed by noon go out the same day.', 'Moorland Heather candle', 'Beck Side Moss candle', 'Rhubarb & Custard wax melts']);
    });

    await check('a product page: gallery at full size, description and care notes; reviews become quotes; tabs, SKU, stock, related products go', () => {
        const p = product();
        assert.deepStrictEqual(images(p), [`${SITE}/wp-content/uploads/2025/02/moorland-heather-scaled.jpg`, `${SITE}/wp-content/uploads/2025/02/moorland-heather-lid.jpg`]);
        assert.ok(texts(p).some((t) => t.startsWith('We walked the tops above Heptonstall')));
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('smells of the moors') && b.text.includes('Priya')));
        assert.doesNotMatch(all(p), /^(Description|Additional information|Reviews \(2\)|Related products|SKU:.*|Category:.*|7 in stock|Add a review|Sale!)$/m);
        assert.doesNotMatch(all(p), /£|Beck Side Moss/);
    });

    await check('a block theme: Product Collection cards read like classic ones; Mini-Cart and account block gone', () => {
        const p = blocks();
        assert.ok(p.blocks.some((b) => b.kind === 'item' && b.text === 'Tide mug'));
        assert.doesNotMatch(all(p), /£|Add to cart|View cart|Product on sale|^Sale$/m);
        assert.ok(images(p).includes('https://ashgrove.example/wp-content/uploads/2025/05/studio-shelf.jpg'));
    });

    await check('an ordinary page on the shop reads like any WordPress page', () => {
        const p = story();
        assert.deepStrictEqual(texts(p), ['Our story', 'Fernbrook started on a kitchen table in 2019, when Sam couldn’t find a candle that smelt like the valley after rain.', 'Pouring the autumn batch', 'What we believe', 'Small batches, so nothing sits on a shelf for months', 'Refills for every jar we sell']);
        assert.strictEqual(p.products, undefined);
    });

    console.log('\nProducts for Business Information');

    await check('cards give name, price as shown (sale = current price, ranges kept), page and full-size picture', () => {
        assert.deepStrictEqual(home().products, [
            { name: 'Moorland Heather candle', price: '£18.00', href: `${SITE}/product/moorland-heather-candle/`, image: `${SITE}/wp-content/uploads/2025/02/moorland-heather.jpg` },
            { name: 'Canal Fig candle', price: '£12.00 – £24.00', href: `${SITE}/product/canal-fig-candle/`, image: 'https://i0.wp.com/fernbrook.example/wp-content/uploads/2025/02/canal-fig.jpg' },
            { name: 'Rhubarb & Custard wax melts', price: '£6.50', href: `${SITE}/product/rhubarb-wax-melts/`, image: `${SITE}/wp-content/uploads/2025/02/rhubarb-melts.jpg` },
        ]);
        assert.deepStrictEqual(blocks().products?.map((x) => [x.name, x.price]), [['Tide mug', '£28.00'], ['Harvest bowl', '£42.00']]);
    });

    await check('a product page gives its own product with its page and large picture', () => {
        const first = product().products?.[0];
        assert.deepStrictEqual(first, { name: 'Moorland Heather candle', price: '£18.00', href: `${SITE}/product/moorland-heather-candle/`, image: `${SITE}/wp-content/uploads/2025/02/moorland-heather-scaled.jpg` });
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport: their pages and words, products listed for Business Information, no price on the draft', async () => {
        const pages: Record<string, string> = {
            [`${SITE}/`]: fixture('storefront-home.html'),
            [`${SITE}/our-story/`]: fixture('our-story.html'),
            [`${SITE}/shop/`]: fixture('shop.html'),
        };
        const pictures: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { pictures.push(src); return 500 + pictures.length; },
        };
        const current = starterSite({ name: 'Fernbrook Candle Co.', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 5 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        const draft = JSON.stringify(r.definition.pages);
        assert.ok(draft.includes('Every candle is poured by hand'));
        assert.ok(draft.includes('Moorland Heather candle'), 'product names stay on the site');
        assert.ok(draft.includes('Sam couldn'), 'their own pages are read');
        assert.ok(!draft.includes('£'), 'no price on the site');
        assert.ok(!/basket|my-account|add-to-cart/i.test(draft), draft.match(/.{40}(basket|my-account|add-to-cart).{40}/i)?.[0]);
        const names = (r.report.products ?? []).map((p) => p.name);
        assert.ok(names.includes('Moorland Heather candle') && names.includes('Beck Side Moss candle'), names.join(', '));
        assert.strictEqual(r.report.contact.email, 'hello@fernbrook.example');
        assert.strictEqual(pictures.length, 0);
    });

    await check('the look: Storefront\'s inline colours and a block theme\'s preset colours are read (shared code, no adapter needed)', () => {
        const sf = readImportedLook(fixture('storefront-home.html'), `${SITE}/`);
        assert.strictEqual(sf.primaryColor, '#7a4e2d');
        const bt = readImportedLook(fixture('block-home.html'), 'https://ashgrove.example/');
        assert.deepStrictEqual([bt.primaryColor, bt.textColor, bt.backgroundColor], ['#2f6b5a', '#1e1b18', '#fbf8f3']);
    });

    await check('the adapter never reads with JavaScript and keeps the WordPress adapter\'s work', () => {
        assert.strictEqual(adapter.rendersWithJs, false);
        assert.ok(adapter.noise?.test('Add to basket') && adapter.noise.test('Showing 1–12 of 30 results') && !adapter.noise.test('Our candles'));
    });

    console.log(`\n${passed}/${total} passed`);
}

void main();
