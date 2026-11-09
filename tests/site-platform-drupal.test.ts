// tests/site-platform-drupal.test.ts
// Website import on Drupal sites (src/utils/site-builders/drupal.ts): Olivero (Drupal 10) and Bartik
// (Drupal 7) pages, synthetic fixtures in tests/fixtures/site-platforms/drupal/. No network, no model.
//
// Run:  npx tsx tests/site-platform-drupal.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS } from '../src/utils/site-builders';
import { adapter, drupalFullSize } from '../src/utils/site-builders/drupal';
import { readImportPage, type ImportPage } from '../src/utils/site-extract';
import { runImport } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const fx = (f: string) => readFileSync(join(root, `tests/fixtures/site-platforms/drupal/${f}.html`), 'utf8');
const SITE = 'https://fernhill-pottery.example';
const D7 = 'https://oakbridge-bakery.example';

// Magento's detect (/mage\//) also matches "image/", and Magento is listed before Drupal, so today it
// claims these pages (reported in docs/site-import-platforms/drupal.md → Can be done). Until that is
// fixed, earlier adapters are kept off Drupal pages here so this file tests the Drupal adapter.
for (const a of ADAPTERS) {
    if (a.key === 'drupal') break;
    const d = a.detect;
    (a as { detect: typeof d }).detect = (h, g, $) => !adapter.detect(h, g, $) && d(h, g, $);
}

const read = (f: string, url: string): ImportPage => readImportPage(fx(f), url);
const texts = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : '')).join(' | ');

async function main() {
    console.log('\nDetection');

    await check('Drupal 10 and Drupal 7 pages are recognised; other builders\' pages are not', () => {
        for (const f of ['olivero-home', 'olivero-about', 'olivero-contact', 'd7-bartik-home']) {
            const html = fx(f);
            const $ = cheerio.load(html);
            assert.ok(adapter.detect(html, ($('meta[name="generator"]').attr('content') ?? '').toLowerCase(), $), f);
        }
        const noGen = '<html><body><main><p>x</p></main><script type="application/json" data-drupal-selector="drupal-settings-json">{}</script></body></html>';
        assert.ok(adapter.detect(noGen, '', cheerio.load(noGen)), 'generator tag removed: drupal-settings-json still tells');
        for (const f of ['sqsp-home', 'wix-home']) {
            const html = readFileSync(join(root, `tests/fixtures/site-import/${f}.html`), 'utf8');
            assert.ok(!adapter.detect(html, '', cheerio.load(html)), f);
        }
    });

    console.log('\nReading an Olivero (Drupal 10) page');

    await check('the page\'s words, headings, list, quote, button and layout-builder blocks come out in order', () => {
        const p = read('olivero-home', `${SITE}/`);
        assert.strictEqual(p.platform, 'drupal');
        assert.deepStrictEqual(p.blocks.map((b) => b.kind), ['heading', 'image', 'text', 'text', 'heading', 'image', 'item', 'item', 'item', 'quote', 'button', 'heading', 'text', 'heading', 'text']);
        const t = texts(p);
        for (const w of ['Clay, wheels and good company', 'no experience needed', 'A hand-built planter', 'stayed for three years', 'Open Tuesday to Saturday', 'follow the signs']) assert.ok(t.includes(w), w);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Book a class' && b.href === `${SITE}/classes`));
        assert.ok(p.blocks.some((b) => b.kind === 'text' && b.links?.[0]?.href === `${SITE}/gallery`), 'inline link kept');
    });

    await check('Drupal\'s furniture is not content: messages, submitted-by, hidden labels, tags, comment links, comments, sidebar, pager', () => {
        const t = texts(read('olivero-home', `${SITE}/`));
        for (const noise of ['newsletter preferences', 'Submitted by', 'Hero image', 'Tags', 'Stoneware', 'post comments', '152 views', 'Comments', 'casino', 'Ring the studio', 'Kiln day', 'Next', 'RSS', 'Powered by', 'Manage']) assert.ok(!t.includes(noise), noise);
    });

    await check('the menu is the main menu only, drop-downs kept; no breadcrumbs, tabs, pager, account or sidebar links', () => {
        const p = read('olivero-home', `${SITE}/`);
        const hrefs = p.navLinks.map((l) => new URL(l.href).pathname);
        assert.deepStrictEqual(hrefs, ['/', '/classes', '/classes/beginners', '/classes/hand-building', '/about', '/contact']);
        assert.strictEqual(p.navLinks.find((l) => l.text === 'Hand-building')?.group, 'Classes');
    });

    await check('contact details in the sidebar are still read before it goes', () => {
        const p = read('olivero-home', `${SITE}/`);
        assert.deepStrictEqual(p.contact.emails, ['hello@fernhill-pottery.example']);
        assert.ok(p.contact.phones.length === 1 && p.contact.address?.includes('Mill Lane'));
        assert.deepStrictEqual(p.socialLinks, ['https://www.instagram.com/fernhillpottery.example']);
    });

    await check('pictures are the originals, not the image-style copies (and not the .webp conversion)', () => {
        const imgs = read('olivero-home', `${SITE}/`).blocks.filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? b.src : ''));
        assert.deepStrictEqual(imgs, [`${SITE}/sites/default/files/2026-03/studio-wheels.jpg`, `${SITE}/sites/default/files/2026-02/mugs-on-shelf.jpg`]);
        const about = read('olivero-about', `${SITE}/about`);
        assert.ok(about.blocks.some((b) => b.kind === 'image' && b.src.endsWith('/inline-images/kiln-door.jpg') && b.altFromSite));
    });

    await check('full-size addresses: public, private, multisite, s3fs, Drupal 6 imagecache; anything else is left alone', () => {
        assert.strictEqual(drupalFullSize('https://a.example/sites/default/files/styles/large/public/2024-01/x.png?itok=abc'), 'https://a.example/sites/default/files/2024-01/x.png');
        assert.strictEqual(drupalFullSize('https://a.example/sites/shop.example/files/styles/hero_xl/public/a%20b.jpeg.webp?itok=1'), 'https://a.example/sites/shop.example/files/a%20b.jpeg');
        assert.strictEqual(drupalFullSize('https://a.example/system/files/styles/thumb/private/doc/x.jpg?itok=1'), 'https://a.example/system/files/doc/x.jpg');
        assert.strictEqual(drupalFullSize('https://cdn.example/s3/files/styles/wide/s3/x.jpg'), 'https://cdn.example/s3/files/x.jpg');
        assert.strictEqual(drupalFullSize('https://a.example/files/imagecache/preview/x.gif'), 'https://a.example/files/x.gif');
        assert.strictEqual(drupalFullSize('https://a.example/sites/default/files/x.jpg'), null);
        assert.strictEqual(drupalFullSize('not a url'), null);
    });

    await check('a webform\'s questions are read for the report; its labels are not content', () => {
        const p = read('olivero-contact', `${SITE}/contact`);
        assert.deepStrictEqual(p.formFields, ['Your name', 'Your email', 'Message']);
        assert.ok(p.hasForm && !texts(p).includes('Your email'));
    });

    console.log('\nReading a Bartik (Drupal 7) page');

    await check('Drupal 7: the <div> menu is the menu, and only the content column is read', () => {
        const p = read('d7-bartik-home', `${D7}/`);
        assert.deepStrictEqual(p.navLinks.map((l) => l.text), ['Home', 'Our bread', 'Wholesale', 'Contact']);
        assert.deepStrictEqual(p.blocks.map((b) => b.kind), ['heading', 'image', 'text', 'heading', 'item', 'item']);
        const t = texts(p);
        for (const noise of ['Main menu', 'Bread baked before dawn', 'Status message', 'You are here', 'Order by phone', 'User login', 'Primary tabs', 'Edit', 'Submitted by', 'post comments', 'Bridge Street, Oakbridge', 'Facebook']) assert.ok(!t.includes(noise), noise);
        assert.ok(p.blocks.some((b) => b.kind === 'image' && b.src === `${D7}/sites/default/files/field/image/sourdough-loaves.jpg`));
        assert.ok(p.contact.phones.length === 1, 'sidebar phone still read');
        assert.deepStrictEqual(p.socialLinks, ['https://www.facebook.com/oakbridgebakery.example']);
        assert.ok(p.logo?.src.endsWith('/oakbridge_logo.png'));
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport reads the home page and the menu pages; every word read is on the draft', async () => {
        const PAGES: Record<string, string> = { [`${SITE}/`]: fx('olivero-home'), [`${SITE}/about`]: fx('olivero-about'), [`${SITE}/contact`]: fx('olivero-contact') };
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: starterSite({ name: 'Fernhill Pottery Studio', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null)), maxPages: 6 }, {
            async fetchHtml(url) { const html = PAGES[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture() { return null; },
        });
        assert.ok(r.ok);
        if (!r.ok) return;
        const read = r.report.pages.filter((p) => p.read).map((p) => new URL(p.url).pathname);
        assert.deepStrictEqual(read, ['/', '/about', '/contact']);
        const all = JSON.stringify(r.definition.pages);
        for (const w of ['no experience needed', 'Open Tuesday to Saturday', 'gas kiln', 'reply within two days']) assert.ok(all.includes(w), w);
        for (const noise of ['Submitted by', 'casino', 'Hero image', 'newsletter preferences']) assert.ok(!all.includes(noise), noise);
        assert.strictEqual(r.report.contact.email, 'hello@fernhill-pottery.example');
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
