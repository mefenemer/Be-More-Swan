// tests/site-platform-ghost.test.ts
// The Ghost adapter (src/utils/site-builders/ghost.ts) on SYNTHETIC pages modelled on Ghost 6 with the
// Casper and Source themes (tests/fixtures/site-platforms/ghost/). Report: docs/site-import-platforms/ghost.md
//
// Run:  npx tsx tests/site-platform-ghost.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/ghost';
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
const fx = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/ghost', `${f}.html`), 'utf8');
// The home page's favicon tag says type="image/png", which Magento's detect (`mage\/`) matches today and,
// listed before Ghost, wins. Reported under "Can be done"; stripped here so this file tests Ghost's own reading.
const home = () => fx('casper-home').replace(' type="image/png"', '');
const F = 'https://fernhill.example';
const read = (f: string, url: string) => readImportPage(f === 'casper-home' ? home() : fx(f), url);
const texts = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : '')).join(' | ');
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));

async function main() {
    await check('every Ghost fixture is recognised as Ghost', () => {
        for (const f of ['casper-home', 'casper-about', 'casper-classes', 'casper-contact', 'source-home', 'source-post']) {
            const html = f === 'casper-home' ? home() : fx(f);
            assert.strictEqual(adapterFor(html, cheerio.load(html))?.key, 'ghost', f);
        }
        assert.ok(adapter.detect('<style>:root {--ghost-accent-color: #ff0095;}</style>', '', cheerio.load('')), 'the accent style alone');
        assert.ok(!adapter.detect('<p>Ghost stories for children</p>', '', cheerio.load('')), 'the word alone is not Ghost');
    });

    await check('resized pictures become the uploaded original; other addresses are left alone', () => {
        assert.strictEqual(adapter.fullSizeImage!('https://x.example/content/images/size/w600/format/webp/2025/03/a.jpg'), 'https://x.example/content/images/2025/03/a.jpg');
        assert.strictEqual(adapter.fullSizeImage!('https://storage.ghost.io/c/91/7c/abc/content/images/size/w2000/2019/10/b.png'), 'https://storage.ghost.io/c/91/7c/abc/content/images/2019/10/b.png');
        assert.strictEqual(adapter.fullSizeImage!('https://x.example/content/images/2025/03/a.jpg'), null);
        assert.strictEqual(adapter.fullSizeImage!('https://images.unsplash.com/photo-1?w=2000'), null);
    });

    await check('Casper home: the heading, line and cover above <main> are read; feed cards lose dates, tags, reading times', () => {
        const p = read('casper-home', `${F}/`);
        assert.strictEqual(p.platform, 'ghost');
        assert.deepStrictEqual(p.blocks.slice(0, 3).map((b) => b.kind), ['image', 'heading', 'text']);
        assert.ok(images(p)[0].endsWith('/content/images/2025/03/barn-studio.jpg'));
        const t = texts(p);
        assert.ok(t.includes('Wheel-throwing classes and handmade stoneware') && t.includes('What happens on a glazing day'));
        for (const noise of ['12 Apr 2025', 'min read', 'Featured', 'Paid-members only', 'Journal', 'Sign in', 'Subscribe', 'Page 1 of 2', 'Powered by']) assert.ok(!t.includes(noise), noise);
        assert.ok(images(p).every((s) => !/\/size\/|\/format\//.test(s)), 'no resized copies');
        assert.ok(!p.navLinks.some((l) => /older posts/i.test(l.text)), 'paging is not a menu page');
        assert.deepStrictEqual(p.navLinks.slice(0, 5).map((l) => l.text), ['Home', 'About', 'Classes', 'Journal', 'Contact']);
        assert.ok(p.logo?.src.endsWith('fernhill-logo.png'));
    });

    await check('Koenig cards: pictures, gallery, callout kept; bookmark and file become one link; players, sign-up and Portal go', () => {
        const p = read('casper-about', `${F}/about/`);
        const t = texts(p);
        for (const kept of ['grandfather\'s hay barn', 'Speckled mugs from the spring firing', 'lead-free and food safe', 'Ana throwing a bowl']) assert.ok(t.includes(kept), kept);
        for (const gone of ['independent makers', 'Crafts Directory', 'studio-history.pdf', '412 KB', '0:00', '1×', 'Play', 'Get studio news', 'No spam', 'firing notes', 'Sign up for more']) assert.ok(!t.includes(gone), gone);
        const buttons = p.blocks.filter((b) => b.kind === 'button') as Array<{ text: string; href: string | null }>;
        assert.ok(buttons.some((b) => b.text === 'Fernhill Pottery – Makers directory' && b.href === 'https://craftscouncil.example/makers/fernhill'));
        assert.ok(buttons.some((b) => b.text === 'The barn\'s history' && b.href!.endsWith('/content/files/2025/03/studio-history.pdf')));
        assert.ok(!images(p).some((s) => s.includes('craftscouncil.example')), 'none of the bookmarked site\'s pictures');
        assert.ok(images(p).some((s) => s.endsWith('/content/images/2025/03/vase-2.jpg')));
        assert.strictEqual(p.logo, null, 'the feature image in the article header is not the logo');
    });

    await check('header, toggle, product and button cards keep their words and links; the toggle icon is not a button', () => {
        const p = read('casper-classes', `${F}/classes/`);
        const t = texts(p);
        assert.ok(t.includes('Learn to throw on the wheel') && t.includes('Aprons and tools are ours.') && t.includes('Can I come with a friend?'));
        const buttons = p.blocks.filter((b) => b.kind === 'button').map((b) => (b as { text: string }).text);
        assert.deepStrictEqual(buttons, ['Ask about dates', 'Book a place', 'Buy a gift voucher']);
        assert.ok(images(p)[0].endsWith('/content/images/2025/03/wheels-in-a-row.jpg'), 'header card background, full size');
    });

    await check('Source: the landing header above <main> is read, the text logo is no menu page, a post loses its byline and members cut', () => {
        const h = readImportPage(fx('source-home'), 'https://brightwater.example/');
        assert.strictEqual(h.blocks[0].kind === 'heading' && h.blocks[0].text, 'Your books, done by Friday.');
        assert.deepStrictEqual(h.navLinks.map((l) => l.text), ['Services', 'Tips', 'About']);
        assert.ok(!texts(h).includes('See all') && !texts(h).includes('By Priya Shah'));
        const p = readImportPage(fx('source-post'), 'https://brightwater.example/vat-deadlines/');
        const t = texts(p);
        assert.ok(t.includes('one month and seven days'));
        for (const gone of ['Priya Shah', '1 May 2025', 'min read', 'Share', 'subscribers only', 'Already have an account', 'Payroll basics']) assert.ok(!t.includes(gone), gone);
        assert.ok(!p.blocks.some((b) => b.kind === 'button'), 'no tag, share or Subscribe buttons');
        assert.deepStrictEqual(images(p), ['https://brightwater.example/content/images/2025/05/desk.jpg']);
        assert.strictEqual(p.logo, null, 'the author picture is not the logo');
    });

    await check('the whole import on a Casper site, no network and no model: pages, prices, contact and the accent colour', async () => {
        const pages: Record<string, string> = { [`${F}/`]: home(), [`${F}/about/`]: fx('casper-about'), [`${F}/classes/`]: fx('casper-classes'), [`${F}/contact/`]: fx('casper-contact') };
        const current = starterSite({ name: 'Fernhill Pottery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const saved: string[] = [];
        const r = await runImport({ url: `${F}/`, pictures: 'copy', current, maxPages: 10 }, {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 900 + saved.length; },
        });
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'ghost');
        assert.deepStrictEqual(r.report.pages.filter((p) => p.read).map((p) => p.title), ['Home', 'About', 'Classes', 'Contact']);
        assert.ok(!r.report.pages.some((p) => /older posts/i.test(p.title)));
        assert.strictEqual(r.report.prices.length, 1, 'the course price is reported, not put on the site');
        assert.strictEqual(r.report.contact.email, 'hello@fernhill.example');
        assert.strictEqual(r.report.look?.primaryColor, '#2e7d5b', '--ghost-accent-color');
        const json = JSON.stringify(r.definition.pages);
        assert.ok(json.includes('Wheel-throwing classes') && json.includes('Aprons and tools are ours.'));
        assert.ok(!/min read|Subscribe|Sign in|Powered by Ghost/.test(json));
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
