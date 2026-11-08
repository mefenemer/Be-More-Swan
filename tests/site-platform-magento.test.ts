// tests/site-platform-magento.test.ts
// The Website import on Adobe Commerce (Magento 2) shops: Luma-style themes with Page Builder, Hyvä and
// PWA Studio (src/utils/site-builders/magento.ts). Saved SYNTHETIC pages only — no network, no model:
// tests/fixtures/site-platforms/magento/. Report: docs/site-import-platforms/magento.md
//
// Run:  npx tsx tests/site-platform-magento.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/magento';
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

const dir = join(__dirname, 'fixtures/site-platforms/magento');
const fixture = (f: string) => readFileSync(join(dir, f), 'utf8');
const LUMA = 'https://www.hartleyfinch.example';
const HYVA = 'https://shop.moorlandtack.example';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : '')).filter(Boolean);
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));
const buttons = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'button' ? [`${b.text} → ${b.href ?? ''}`] : []));

const lumaHome = () => readImportPage(fixture('luma-home.html'), `${LUMA}/`);
const hyvaHome = () => readImportPage(fixture('hyva-home.html'), `${HYVA}/`);

async function main() {
    console.log('\nDetection');

    await check('Luma, Hyvä and PWA Studio pages are recognised as Magento', () => {
        assert.strictEqual(found(fixture('luma-home.html')), 'magento');
        assert.strictEqual(found(fixture('luma-contact.html')), 'magento');
        assert.strictEqual(found(fixture('hyva-home.html')), 'magento');
        assert.strictEqual(found(fixture('pwa-studio-shell.html')), 'magento');
    });

    await check('a plain page with an image/png icon is not Magento (the old `mage/` test matched inside "image/")', () => {
        const plain = '<html><head><link rel="icon" type="image/png" href="/favicon.png"><script src="/js/require.js"></script></head><body><main><h1>Hand-made page</h1><img src="/img/team.jpg" alt="Our team"></main></body></html>';
        assert.strictEqual(found(plain), null);
    });

    console.log('\nThe menu');

    await check('menu: top-level categories, then the footer\'s own pages, then sub-categories as drop-downs', () => {
        const nav = lumaHome().navLinks.map((l) => (l.group ? `${l.group} > ${l.text}` : l.text));
        assert.deepStrictEqual(nav, ['Ceramics', 'Linens', 'Candles', 'Workshops', 'About us', 'Delivery & returns', 'Contact Us',
            'Ceramics > Mugs', 'Ceramics > Bowls', 'Ceramics > Vases', 'Linens > Tea towels', 'Linens > Napkins']);
    });

    await check('account, cart, search, compare, guest-order and sample privacy links never reach the menu; the logo is not "store logo"', () => {
        for (const p of [lumaHome(), hyvaHome()]) {
            const all = p.navLinks.map((l) => `${l.text} ${l.href}`).join(' | ');
            for (const bad of ['Sign In', 'Create an Account', 'My Cart', 'Compare', 'Advanced Search', 'Search Terms', 'Orders and Returns', 'My Account', 'Privacy', 'store logo', 'Go to Home page', '/customer/', '/checkout/', '/catalogsearch/']) assert.ok(!all.includes(bad), bad);
        }
    });

    await check('Hyvä: the phone menu copy ("See all Saddles") does not replace the desktop menu\'s names', () => {
        const nav = hyvaHome().navLinks.map((l) => (l.group ? `${l.group} > ${l.text}` : l.text));
        assert.deepStrictEqual(nav, ['Saddles', 'Riding wear', 'Repairs', 'About', 'Contact', 'Saddles > General purpose', 'Saddles > Dressage']);
    });

    console.log('\nWords and pictures');

    await check('widget areas either side of <main> are read: the top notice and the testimonial at the bottom', () => {
        const p = lumaHome();
        assert.ok(texts(p).includes('Our Ludlow workshop is open for collection every Saturday.'));
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('still my favourite thing in the kitchen')));
    });

    await check('Page Builder: background pictures from data-background-images, desktop copy only, hidden text left out', () => {
        const p = lumaHome();
        const imgs = images(p);
        assert.ok(imgs.includes(`${LUMA}/media/wysiwyg/home/workshop-bench.jpg`) && imgs.includes(`${LUMA}/media/wysiwyg/home/kiln-day.jpg`));
        assert.ok(!imgs.some((s) => /-mobile\.jpg/.test(s)), 'no phone-only copies');
        assert.ok(!texts(p).some((t) => t.includes('Christmas orders close')), 'display:none element left out');
        assert.ok(!texts(p).includes('Home Page'), 'Magento\'s default home title is not a heading');
    });

    await check('banner, slide and promo-tile buttons keep the link the whole tile had', () => {
        assert.ok(buttons(lumaHome()).includes(`Shop ceramics → ${LUMA}/ceramics.html`));
        assert.ok(buttons(lumaHome()).includes(`Shop candles → ${LUMA}/candles.html`));
        assert.ok(buttons(lumaHome()).includes(`Browse linens → ${LUMA}/linens.html`));
        assert.ok(buttons(hyvaHome()).includes(`Book a fitting → ${HYVA}/saddle-fitting`));
    });

    await check('product cards: the name (linked to its page) and full-size picture, the price on its own line, no shop buttons', () => {
        for (const p of [lumaHome(), hyvaHome()]) {
            const all = texts(p).join(' | ');
            for (const bad of ['Add to Cart', 'Add to Wish List', 'Add to Compare', 'Rating', 'Reviews', 'Regular Price', 'Out of stock', 'View more about', 'Press to skip', 'slide']) assert.ok(!all.includes(bad), bad);
        }
        const p = lumaHome();
        const mug = p.blocks.find((b) => b.kind === 'item' && b.text === 'Speckled oat mug');
        assert.ok(mug && mug.kind === 'item' && mug.links?.[0].href === `${LUMA}/speckled-oat-mug.html`);
        assert.ok(texts(p).includes('Speckled oat mug: £28.00') && texts(p).includes('Sage linen tea towel: £12.00'), 'final price, not the old one');
        assert.ok(images(p).includes(`${LUMA}/media/catalog/product/s/p/speckled-oat-mug.jpg`));
        const towel = p.blocks.find((b) => b.kind === 'image' && b.src.endsWith('sage-tea-towel.jpg'));
        assert.ok(towel && towel.kind === 'image' && towel.alt === 'Sage linen tea towel', 'an empty alt becomes the product name');
        const h = hyvaHome();
        assert.ok(h.blocks.some((b) => b.kind === 'item' && b.text === 'Wool-lined girth'), 'Hyvä cards are <form>s and used to vanish');
        assert.ok(images(h).includes(`${HYVA}/media/catalog/product/c/a/cavesson-bridle-havana.jpg`), 'cache path and ?width= dropped');
    });

    await check('a category page: its description and picture, products, never the toolbar, filters or empty compare boxes', () => {
        const p = readImportPage(fixture('luma-category.html'), `${LUMA}/candles.html`);
        const all = texts(p).join(' | ');
        assert.ok(all.includes('poured into our own seconds'));
        assert.ok(images(p).includes(`${LUMA}/media/catalog/category/candles-header.jpg`));
        for (const bad of ['View as', 'Sort By', 'Position', 'per page', 'Shop By', 'Shopping Options', 'Compare Products', 'You have no items', 'My Wish List', 'currently reading']) assert.ok(!all.includes(bad), bad);
        assert.ok(p.blocks.some((b) => b.kind === 'item' && b.text === 'Bowl candle – woodsmoke'));
        assert.ok(!images(p).some((s) => s.includes('/placeholder/')), 'Magento\'s "no picture" placeholder is not their picture');
    });

    await check('a Page Builder map: the address becomes the page\'s address, and a "See us on the map" link', () => {
        const p = readImportPage(fixture('luma-about.html'), `${LUMA}/about-us`);
        assert.strictEqual(p.contact.address, '12 Corve Street, Ludlow, Shropshire, SY8 1DA');
        assert.ok(buttons(p).includes('See us on the map → https://maps.google.com/maps?q=52.3681,-2.7176'));
        assert.ok(texts(p).includes('Open Saturdays 10am to 4pm'));
        assert.ok(images(p).includes(`${LUMA}/media/wysiwyg/about/dairy-studio.jpg`), 'media-gallery rendition → the original');
    });

    await check('forms: the contact form\'s questions are kept; search, newsletter, sign-in and add-to-basket forms are not "their form"', () => {
        assert.strictEqual(lumaHome().hasForm, false);
        assert.strictEqual(hyvaHome().hasForm, false);
        const c = readImportPage(fixture('luma-contact.html'), `${LUMA}/contact/`);
        assert.ok(c.hasForm);
        assert.deepStrictEqual(c.formFields, ['Name', 'Email', 'Phone Number', 'What’s on your mind?']);
        assert.deepStrictEqual(c.contact.emails, ['hello@hartleyfinch.example']);
    });

    await check('full-size pictures: catalogue cache paths (Magento 2 and 1), renditions and resize parameters', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f('https://s.example/media/catalog/product/cache/0f1e2d3c4b5a69788796a5b4c3d2e1f0/w/s/ws12-orange.jpg'), 'https://s.example/media/catalog/product/w/s/ws12-orange.jpg');
        assert.strictEqual(f('https://s.example/pub/media/catalog/product/cache/0f1e2d3c4b5a69788796a5b4c3d2e1f0/w/s/ws12.jpg'), 'https://s.example/pub/media/catalog/product/w/s/ws12.jpg');
        assert.strictEqual(f('https://s.example/media/catalog/product/cache/1/small_image/240x300/9df78eab33525d08d6e5fb8d27136e95/a/b/abc.jpg'), 'https://s.example/media/catalog/product/a/b/abc.jpg');
        assert.strictEqual(f('https://s.example/media/catalog/product/a/b/abc.jpg?auto=webp&format=pjpg&width=640&height=800&fit=cover'), 'https://s.example/media/catalog/product/a/b/abc.jpg');
        assert.strictEqual(f('https://s.example/media/wysiwyg/.renditions/wysiwyg/home/a.jpg'), 'https://s.example/media/wysiwyg/home/a.jpg');
        assert.strictEqual(f('https://s.example/media/wysiwyg/home/a.jpg'), null);
    });

    await check('PWA Studio: the server sends an empty shell, so the plain read finds nothing (the headless browser is needed)', () => {
        const p = readImportPage(fixture('pwa-studio-shell.html'), 'https://shop.fernleafgarden.example/');
        assert.strictEqual(p.platform, 'magento');
        assert.strictEqual(p.words, 0);
    });

    console.log('\nThe whole import (no network, no model)');

    const PAGES: Record<string, string> = {
        [`${LUMA}/`]: fixture('luma-home.html'),
        [`${LUMA}/ceramics.html`]: fixture('luma-category.html'),
        [`${LUMA}/candles.html`]: fixture('luma-category.html'),
        [`${LUMA}/about-us`]: fixture('luma-about.html'),
        [`${LUMA}/contact/`]: fixture('luma-contact.html'),
    };
    const pictures: string[] = [];
    const deps: ImportDeps = {
        async fetchHtml(url) { const html = PAGES[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async plan() { return null; },
        async savePicture(src) { pictures.push(src); return 700 + pictures.length; },
        async fetchCss(url) { return url.endsWith('styles-m.css') ? fixture('luma-styles-m.css') : null; },
    };
    const current = () => starterSite({ name: 'Hartley & Finch', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
    const r = await runImport({ url: `${LUMA}/`, pictures: 'copy', current: current(), maxPages: 8 }, deps);

    await check('runImport reads the shop\'s own pages, never account, search or guest-order pages', () => {
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'magento');
        const urls = [...r.report.pages.map((p) => p.url), ...r.report.notImported.map((p) => p.url)].join(' ');
        for (const bad of ['/customer/', '/catalogsearch/', '/sales/guest/', '/search/term/', '/privacy-policy-cookie-restriction-mode', '/checkout/']) assert.ok(!urls.includes(bad), bad);
        assert.ok(r.report.pages.some((p) => p.url === `${LUMA}/about-us` && p.read), 'About us (a footer link) is read');
        assert.ok(r.report.pages.some((p) => p.url === `${LUMA}/contact/` && p.read), 'the contact page is read');
    });

    await check('product prices go to the report\'s price list (for Business Information), never onto the draft', () => {
        if (!r.ok) return;
        assert.ok(r.report.prices.includes('Speckled oat mug: £28.00'));
        const all = JSON.stringify(r.definition.pages);
        assert.ok(!all.includes('£'), 'no price on the site');
        assert.ok(all.includes('Speckled oat mug') && all.includes('Thrown by hand in Shropshire'));
        assert.strictEqual(r.definition.settings.email, 'hello@hartleyfinch.example');
        assert.ok(r.report.hadForm);
    });

    await check('pictures are copied full size; the look comes from their Luma stylesheet', () => {
        if (!r.ok) return;
        assert.ok(pictures.length > 0 && !pictures.some((s) => s.includes('/cache/') || s.includes('.renditions') || /-mobile\.jpg/.test(s)));
        assert.ok(pictures.includes(`${LUMA}/media/logo/stores/1/hartley-finch-logo.png`), 'the logo');
        assert.ok(r.report.look, 'a look was read');
        assert.strictEqual(r.report.look?.primaryColor?.toLowerCase(), '#7a4b2a');
    });

    console.log(`\n${passed}/${total} passed`);
}

main();
