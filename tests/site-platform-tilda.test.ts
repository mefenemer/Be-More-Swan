// tests/site-platform-tilda.test.ts
// The Tilda adapter (src/utils/site-builders/tilda.ts) on SYNTHETIC pages modelled on Tilda's markup
// (tests/fixtures/site-platforms/tilda/): lazy pictures at full size, <div> titles as headings, cards
// read one by one, Zero Block in reading order, older sites' menu and drop-downs, no Tilda furniture.
// Report: docs/site-import-platforms/tilda.md
//
// Run:  npx tsx tests/site-platform-tilda.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { tildaFullSize } from '../src/utils/site-builders/tilda';
import { readImportPage, type ImportBlock } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
const queue: Array<() => Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>): void {
    queue.push(async () => {
        total++;
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    });
}
const SITE = 'https://fernhill.example';
const fx = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/tilda', f), 'utf8');
const HOME = fx('home.html');
const ABOUT = fx('about.html');
const home = readImportPage(HOME, `${SITE}/`);
const about = readImportPage(ABOUT, `${SITE}/about`);
const said = (b: ImportBlock) => (b.kind === 'image' ? `image ${b.src}` : `${b.kind} ${b.text}`);
const texts = (blocks: ImportBlock[]) => blocks.map(said);
const at = (blocks: ImportBlock[], s: string) => blocks.findIndex((b) => b.kind !== 'image' && b.text.startsWith(s));

if (process.env.DUMP) { for (const p of [home, about]) { console.log(p.url, JSON.stringify(p.navLinks), JSON.stringify(p.logo)); for (const l of texts(p.blocks)) console.log('   ', l); } }

check('recognised: both the newer page (no generator tag) and the older one', () => {
    assert.strictEqual(adapterFor(HOME, cheerio.load(HOME))?.key, 'tilda');
    assert.strictEqual(adapterFor(ABOUT, cheerio.load(ABOUT))?.key, 'tilda');
    assert.strictEqual(home.platform, 'tilda');
    const plain = '<html><body><main><p>A site that links a picture from https://static.tildacdn.com/x.jpg in words</p></main></body></html>';
    assert.notStrictEqual(adapterFor(plain, cheerio.load(plain))?.key, 'tilda');
});

check('lazy pictures come at full size: data-original, not the empty or 20px thumbnail', () => {
    const imgs = home.blocks.filter((b): b is Extract<ImportBlock, { kind: 'image' }> => b.kind === 'image').map((b) => b.src);
    assert.ok(imgs.includes('https://static.tildacdn.com/tild6435-aaaa-4bbb-cccc-000000000002/studio-wheels.jpg'), 'cover background');
    assert.ok(imgs.includes('https://static.tildacdn.com/tild3862-aaaa-4bbb-cccc-000000000003/bowls.jpg'), 'card picture');
    assert.ok(imgs.includes('https://static.tildacdn.com/tild3964-aaaa-4bbb-cccc-000000000004/coil-pots.jpg'), 'webp thumbnail → original');
    assert.ok(imgs.includes('https://static.tildacdn.com/tild3337-aaaa-4bbb-cccc-000000000005/mill.jpg'), 'Zero Block picture with no src');
    assert.ok(!imgs.some((s) => /thb\.|optim\.|\/-\//.test(s)), imgs.join('\n'));
    const aboutImgs = about.blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);
    assert.deepStrictEqual(aboutImgs, ['https://static.tildacdn.com/tild3065-aaaa-4bbb-cccc-000000000007/ruth-and-sam.jpg']);
});

check('a background-only gallery picture is kept, with its own description', () => {
    const glaze = home.blocks.find((b) => b.kind === 'image' && b.src.includes('glaze-wall.jpg'));
    assert.ok(glaze && glaze.kind === 'image' && glaze.altFromSite && glaze.alt.startsWith('A wall of glaze test tiles'));
});

check('the full-size address: thb/optim chains, regional domains, originals and others left alone', () => {
    assert.strictEqual(tildaFullSize('https://thb.tildacdn.net/tild3738-3139/-/empty/3.jpg'), 'https://static.tildacdn.net/tild3738-3139/3.jpg');
    assert.strictEqual(tildaFullSize('https://optim.tildacdn.one/tild6438-aa/-/cover/360x230/center/center/-/format/webp/photo.png.webp'), 'https://static.tildacdn.one/tild6438-aa/photo.png');
    assert.strictEqual(tildaFullSize('https://static.tildacdn.com/tild3738-3139/3.jpg'), null);
    assert.strictEqual(tildaFullSize('https://images.example/tild3738/-/resize/20x/3.jpg'), null);
    assert.strictEqual(tildaFullSize('not a url'), null);
});

check('titles drawn as <div>s are headings: cover title h2, card titles h3', () => {
    assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.level === 2 && b.text === 'Make something with your hands'));
    assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.level === 2 && b.text === 'Why people come back'));
    for (const t of ['Wheel throwing', 'Hand-building']) assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.level === 3 && b.text === t), t);
});

check('cards are read one by one: title, then its words — not one run-on list item', () => {
    assert.ok(!home.blocks.some((b) => b.kind === 'item' && b.text.includes('Centre the clay')));
    const t = at(home.blocks, 'Wheel throwing'), d = at(home.blocks, 'Centre the clay');
    assert.ok(t >= 0 && d === t + 1, texts(home.blocks).join('\n'));
});

check('Zero Block in reading order (top to bottom, left to right), not editor order', () => {
    const order = ['Our story', 'image https://static.tildacdn.com/tild3337', 'Fernhill started', 'When we teach', 'Classes run on', 'Meet the team'];
    const idx = order.map((s) => (s.startsWith('image ') ? home.blocks.findIndex((b) => said(b).startsWith(s)) : at(home.blocks, s)));
    assert.ok(idx.every((n) => n >= 0), JSON.stringify(idx));
    assert.deepStrictEqual([...idx].sort((a, b) => a - b), idx, texts(home.blocks).join('\n'));
    // Positions only in the record's CSS (no data-field-*), and @media (phone) rules ignored.
    const a = [at(about.blocks, 'The people behind'), at(about.blocks, 'Ruth trained'), about.blocks.findIndex((b) => b.kind === 'image')];
    assert.ok(a[0] >= 0 && a[0] < a[1] && a[1] < a[2], texts(about.blocks).join('\n'));
});

check('Zero Block text is a heading by its size: 48px → h2, 28px → h3, the owner\'s own h1 kept', () => {
    assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.level === 2 && b.text === 'Our story'));
    assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.level === 3 && b.text === 'When we teach'));
    assert.ok(home.blocks.some((b) => b.kind === 'text' && b.text.startsWith('Fernhill started')));
    assert.ok(about.blocks.some((b) => b.kind === 'heading' && b.level === 1 && b.text === 'The people behind the wheel'));
});

check('buttons: a real link keeps it; one that opens a pop-up has no link (never the old site\'s #popup)', () => {
    assert.ok(home.blocks.some((b) => b.kind === 'button' && b.text === 'Meet the team' && b.href === `${SITE}/about`));
    assert.ok(home.blocks.some((b) => b.kind === 'button' && b.text === 'Book a class' && b.href === null));
});

check('menu with its drop-down; the logo link does not rename Home', () => {
    assert.deepStrictEqual(home.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Wheel throwing', 'Classes'], ['Hand-building', 'Classes'], ['About', null]]);
    assert.ok(home.logo && home.logo.src.endsWith('fernhill-logo.png'));
});

check('older page: menu record and t794 drop-down read as the menu, not as the page\'s words; logo found', () => {
    assert.deepStrictEqual(about.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Wheel throwing', 'Classes'], ['Hand-building', 'Classes'], ['About', null]]);
    assert.ok(about.logo && about.logo.src.endsWith('fernhill-logo.png'));
    for (const t of ['Home', 'Classes', 'Wheel throwing', 'Book now']) assert.strictEqual(at(about.blocks, t), -1, t);
});

check('no Tilda furniture: "Made on Tilda", its badge, the pop-up form\'s title and success line', () => {
    const all = JSON.stringify([home.blocks, about.blocks]);
    for (const s of ['Made on', 'tildacopy', 'Book your place', 'Your data has been submitted', '© 2026']) assert.ok(!all.includes(s), s);
    assert.strictEqual(home.contact.emails[0], 'hello@fernhill.example');
    assert.ok(home.socialLinks?.some((l) => l.includes('instagram.com')));
});

check('runImport, no network and no model: both pages read, nothing left behind, full-size pictures copied', async () => {
    const pages: Record<string, string> = { [`${SITE}/`]: HOME, [`${SITE}/about`]: ABOUT };
    const pictures: string[] = [];
    const deps: ImportDeps = {
        async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async plan() { return null; },
        async savePicture(src) { pictures.push(src); return 900 + pictures.length; },
    };
    const current = starterSite({ name: 'Fernhill Pottery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
    const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 10 }, deps);
    assert.ok(r.ok, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.ok(r.report.pages.filter((p) => p.read).map((p) => p.url).includes(`${SITE}/about`), JSON.stringify(r.report.pages));
    const words = JSON.stringify(r.definition);
    for (const s of ['Make something with your hands', 'Our story', 'Fernhill started in a garden shed', 'The people behind the wheel']) assert.ok(words.includes(s), s);
    assert.ok(!words.includes('Made on') && !words.includes('Book your place'));
    assert.ok(pictures.length > 0 && pictures.every((p) => !/thb\.|optim\.|\/-\//.test(p)), pictures.join('\n'));
});

(async () => {
    console.log('\nTilda');
    for (const t of queue) await t();
    console.log(`\n${passed}/${total} passed`);
})();
