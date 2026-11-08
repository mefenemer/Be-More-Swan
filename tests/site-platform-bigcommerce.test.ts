// tests/site-platform-bigcommerce.test.ts
// The Website import on BigCommerce (Stencil / Cornerstone) shops — src/utils/site-builders/bigcommerce.ts.
// Saved SYNTHETIC pages only (tests/fixtures/site-platforms/bigcommerce/, a fictional candle shop
// modelled on Cornerstone's markup): no network, no model.
//
// Run:  npx tsx tests/site-platform-bigcommerce.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/bigcommerce';
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
const fixture = (f: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/bigcommerce', f), 'utf8');
const SITE = 'https://hollinfern.example';
const PAGES: Record<string, string> = {
    [`${SITE}/`]: fixture('home.html'),
    [`${SITE}/our-story/`]: fixture('our-story.html'),
    [`${SITE}/contact-us/`]: fixture('contact-us.html'),
    [`${SITE}/candles/`]: fixture('candles.html'),
};
const page = (path: string): ImportPage => readImportPage(PAGES[`${SITE}${path}`], `${SITE}${path}`);
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (p: ImportPage) => p.blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);

const current = () => starterSite({ name: 'Hollin & Fern', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
function deps(): ImportDeps & { asked: string[] } {
    const asked: string[] = [];
    return {
        asked,
        async fetchHtml(url) { asked.push(url); const html = PAGES[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async plan() { return null; },
        async savePicture(src) { return src ? 901 : null; },
        async fetchCss(url) { return /\/css\/theme-[\w-]+\.css$/.test(url) ? fixture('theme.css') : null; },
    };
}

async function main() {
    console.log('\nFinding a BigCommerce shop');

    await check('Stencil pages are recognised: the platform tag, a store\'s CDN path, or the Stencil stylesheet', () => {
        for (const f of ['home.html', 'our-story.html', 'contact-us.html', 'candles.html']) assert.strictEqual(found(fixture(f)), 'bigcommerce', f);
        assert.strictEqual(found('<html><head><meta name="platform" content="bigcommerce.stencil"></head><body><main>x</main></body></html>'), 'bigcommerce');
        assert.strictEqual(found('<html><body><main><img src="https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/500x659/products/1/2/a.jpg"></main></body></html>'), 'bigcommerce');
        assert.strictEqual(found('<html><head><link data-stencil-stylesheet href="/theme.css" rel="stylesheet"></head><body></body></html>'), 'bigcommerce');
    });

    await check('the word "BigCommerce" alone is not a BigCommerce shop (an agency page, a link to them)', () => {
        assert.strictEqual(found('<html><body><main><h1>We build BigCommerce stores</h1><p>Moving from BigCommerce? <a href="https://www.bigcommerce.com/">bigcommerce.com</a></p></main></body></html>'), null);
        assert.strictEqual(found('<html><body><main><img src="https://cdn11.bigcommerce.com/assets/logo.png"></main></body></html>'), null);
    });

    console.log('\nThe menu');

    await check('the menu is the owner\'s pages: no cart, currency, sign in, register, compare or gift certificates', () => {
        const home = page('/');
        assert.deepStrictEqual(home.navLinks.map((l) => l.text), ['Candles', 'Travel Tins', 'Wax Melts', 'Our Story', 'Journal', 'Contact Us', 'Shipping & Returns']);
        assert.ok(!home.navLinks.some((l) => /cart\.php|login\.php|giftcertificates|setCurrencyId|\/compare/.test(l.href)));
    });

    await check('a category\'s sub-menu is grouped under the category, and its "All …" repeat is dropped', () => {
        const tins = page('/').navLinks.find((l) => l.text === 'Travel Tins');
        assert.strictEqual(tins?.group, 'Candles');
        assert.ok(!page('/').navLinks.some((l) => l.text === 'All Candles'));
    });

    await check('inner pages add no breadcrumbs, filters or page numbers to the menu', () => {
        const cat = page('/candles/');
        assert.deepStrictEqual(cat.navLinks.map((l) => l.text), page('/').navLinks.map((l) => l.text));
    });

    console.log('\nThe page\'s own words and pictures');

    await check('the hero carousel: each slide\'s title is a heading, then its words and its button', () => {
        const b = page('/').blocks;
        const at = b.findIndex((x) => x.kind === 'heading' && x.text === 'Poured by hand in Kendal');
        assert.ok(at > 0 && b[at - 1].kind === 'image');
        assert.deepStrictEqual(b[at + 1], { kind: 'text', text: 'Small batches of soy candles, scented with oils we blend ourselves.' });
        assert.deepStrictEqual(b[at + 2], { kind: 'button', text: 'Shop the candles', href: `${SITE}/candles/` });
        assert.ok(b.some((x) => x.kind === 'heading' && x.text === 'Wax melts for every room'));
    });

    await check('Page Builder text and picture widgets are read in order', () => {
        const t = texts(page('/'));
        assert.ok(t.includes('A little about us'));
        assert.ok(t.some((x) => x.startsWith('We are Hannah and Tom.')));
        assert.ok(images(page('/')).some((s) => s.endsWith('/images/stencil/original/image-manager/barn-workshop.jpg?t=1700000002')));
    });

    await check('the home page\'s automatic product lists (and the theme\'s "Featured Products") are left out', () => {
        const t = texts(page('/'));
        assert.ok(!t.includes('Featured Products') && !t.includes('Fell Walk Candle'));
        assert.ok(!images(page('/')).some((s) => s.includes('/products/')));
    });

    await check('a category page keeps its description and product names with pictures — never prices or shop buttons', () => {
        const cat = page('/candles/');
        assert.deepStrictEqual(texts(cat), ['Candles', 'Our candles burn for around forty hours. Each scent is named after a walk we love in the Lake District.', 'Fell Walk Candle', 'Tarn Hows Candle']);
        const all = JSON.stringify(cat.blocks);
        for (const furniture of ['£', 'Quick view', 'Add to Cart', 'Choose Options', 'Compare', 'Sale', 'Sort By', 'Hollin & Fern', 'Next']) assert.ok(!all.includes(furniture), furniture);
        assert.strictEqual(images(cat).length, 2);
    });

    await check('a web page (Our Story): heading, uploaded picture, paragraphs and list, nothing from the header', () => {
        const p = page('/our-story/');
        assert.deepStrictEqual(texts(p), [
            'Our Story',
            'Hollin & Fern began with one candle for a friend\'s wedding. People kept asking for more, so we kept pouring.',
            'How we make them',
            'We melt the wax slowly, add our own blend of oils, and leave every candle to cure for two weeks before it goes out.',
            'British soy wax', 'Cotton wicks, no lead', 'Refillable amber jars',
        ]);
        assert.deepStrictEqual(images(p), [`${SITE}/product_images/uploaded_images/workshop.jpg`]);
    });

    await check('every word read is on the saved page: the adapter adds none of its own', () => {
        for (const [url, html] of Object.entries(PAGES)) {
            const source = cheerio.load(html).text().replace(/\s+/g, ' ');
            for (const t of texts(readImportPage(html, url))) assert.ok(source.includes(t), `${url}: ${t}`);
        }
    });

    console.log('\nPictures at full size');

    await check('CDN pictures: any stencil size becomes 1600w; "original" stays; the logo too', () => {
        assert.ok(images(page('/')).every((s) => !/\/stencil\/(80w|640w|1280w|500x659)\//.test(s)));
        assert.ok(images(page('/')).includes('https://cdn11.bigcommerce.com/s-q7w2k9x4/images/stencil/1600w/carousel/11/workbench-pouring__10001.jpg?c=2'));
        // the lazy slide: a 1-pixel placeholder in src, the real picture only in data-srcset
        assert.ok(images(page('/')).includes('https://cdn11.bigcommerce.com/s-q7w2k9x4/images/stencil/1600w/carousel/12/melts-tray__10002.jpg?c=2'));
        assert.strictEqual(page('/').logo?.src, 'https://cdn11.bigcommerce.com/s-q7w2k9x4/images/stencil/1600w/hollin-fern-logo_1700000001__12345.original.png');
    });

    await check('fullSizeImage: Stencil, older Blueprint themes, a headless shop\'s resizer; anything else is left alone', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f('https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/320x320/products/7/9/mug__1.jpg?c=2'), 'https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/1600w/products/7/9/mug__1.jpg?c=2');
        assert.strictEqual(f('https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/original/products/7/9/mug__1.jpg'), 'https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/original/products/7/9/mug__1.jpg');
        assert.strictEqual(f('https://cdn3.bigcommerce.com/s-ab12cd34/products/7/images/9/mug__1.1456436682.220.290.jpg?c=2'), 'https://cdn3.bigcommerce.com/s-ab12cd34/products/7/images/9/mug__1.1456436682.1280.1280.jpg?c=2');
        assert.strictEqual(f(`https://shop.example/_next/image?url=${encodeURIComponent('https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/640w/products/7/9/mug.jpg')}&w=640&q=75`), 'https://cdn11.bigcommerce.com/s-ab12cd34/images/stencil/1600w/products/7/9/mug.jpg');
        assert.strictEqual(f('https://images.example/cat.jpg'), null);
        assert.strictEqual(f('not a url'), null);
    });

    console.log('\nForms and the shop\'s details');

    await check('the search box and the newsletter sign-up are not "their form"; the contact form\'s questions are clean', () => {
        assert.strictEqual(page('/').hasForm, false);
        assert.strictEqual(page('/candles/').hasForm, false);
        const c = page('/contact-us/');
        assert.strictEqual(c.hasForm, true);
        assert.deepStrictEqual(c.formFields, ['Full Name', 'Phone Number', 'Email Address', 'Order Number', 'Comments/Questions']);
    });

    await check('the footer\'s store details: the address lines kept apart, the phone read without a link', () => {
        const home = page('/');
        assert.strictEqual(home.contact.address, 'Unit 3, Fellside Barns, Kendal LA9 0ZZ');
        assert.deepStrictEqual(home.contact.phones, ['01632 960123']);
        assert.deepStrictEqual(home.socialLinks, ['https://www.instagram.com/hollinfern.example']);
        const paren = readImportPage('<html><head><meta name="platform" content="bigcommerce.stencil"></head><body><main id="main-content"><p>Words of the shop.</p></main><footer><article data-section-type="storeInfo"><strong>Call us at (415) 555-5555</strong></article></footer></body></html>', `${SITE}/`);
        assert.deepStrictEqual(paren.contact.phones, ['(415) 555-5555']);
    });

    await check('the carousel\'s Pause control is not a button of theirs', () => {
        assert.ok(!page('/').blocks.some((b) => b.kind === 'button' && /pause/i.test(b.text)));
    });

    console.log('\nThe whole import (no model)');

    await check('runImport reads the owner\'s pages, never shop machinery; no prices reach the draft', async () => {
        const d = deps();
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 8 }, d);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.ok(!d.asked.some((u) => /cart\.php|login\.php|giftcertificates|compare|setCurrencyId/.test(u)), d.asked.join(' '));
        assert.deepStrictEqual(r.report.pages.filter((p) => p.read).map((p) => p.title), ['Home', 'Candles', 'Our Story', 'Contact Us']);
        assert.strictEqual(r.report.platform, 'bigcommerce');
        assert.deepStrictEqual(r.report.prices, []);
        assert.strictEqual(r.report.contact.phone, '01632 960123');
        assert.ok(r.report.hadForm);
        const all = JSON.stringify(r.definition.pages);
        assert.ok(!all.includes('£') && !all.includes('Quick view') && !all.includes('Add to Cart') && !all.includes('British Pound'));
        assert.ok(all.includes('Poured by hand in Kendal') && all.includes('Tarn Hows Candle'));
    });

    await check('their look comes from the compiled Stencil stylesheet', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 8 }, deps());
        assert.ok(r.ok && r.report.look);
        if (!r.ok || !r.report.look) return;
        assert.strictEqual(r.report.look.backgroundColor, '#fbf8f3');
        assert.strictEqual(r.report.look.headingFont, 'Lora');
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
