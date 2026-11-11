// tests/site-platform-framer.test.ts
// The Framer adapter (src/utils/site-builders/framer.ts) against synthetic Framer pages
// (tests/fixtures/site-platforms/framer/). No network, no model.
//
// Run:  npx tsx tests/site-platform-framer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, mediaHoldsAt } from '../src/utils/site-builders/framer';
import { readImportPage, type ImportBlock } from '../src/utils/site-extract';
import { runImport } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
const pending: Array<Promise<void>> = [];
function check(name: string, fn: () => void | Promise<void>): void {
    total++;
    pending.push((async () => {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    })());
}
const dir = join(__dirname, 'fixtures/site-platforms/framer');
const html = (f: string) => readFileSync(join(dir, `${f}.html`), 'utf8');
const SITE = 'https://harbourlane.example';
const home = readImportPage(html('home'), `${SITE}/`);
const texts = (bs: ImportBlock[]) => bs.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (bs: ImportBlock[]) => bs.filter((b): b is Extract<ImportBlock, { kind: 'image' }> => b.kind === 'image');

check('Framer pages are recognised, and a hand-made page is not', () => {
    for (const f of ['home', 'about', 'contact', 'no-hydrate']) assert.strictEqual(adapterFor(html(f), cheerio.load(html(f)))?.key, 'framer');
    assert.strictEqual(adapterFor('<html><body><main><p>Hi</p></main></body></html>', cheerio.load('<p>Hi</p>')), null);
    assert.strictEqual(adapter.rendersWithJs, false);
});

check('breakpoint media queries are judged at desktop width', () => {
    assert.strictEqual(mediaHoldsAt('(min-width: 1200px)', 1280), true);
    assert.strictEqual(mediaHoldsAt('(min-width: 810px) and (max-width: 1199.98px)', 1280), false);
    assert.strictEqual(mediaHoldsAt('(max-width: 809.98px)', 1280), false);
    assert.strictEqual(mediaHoldsAt('(hover: hover)', 1280), null);
});

check('the menu drawn in plain divs is read as the menu, with the logo, and not as content', () => {
    assert.deepStrictEqual(home.navLinks.map((l) => l.text), ['Home', 'Classes', 'About', 'Contact']);
    assert.ok(home.logo && /LogoHlp7Qw2Er\.png\?width=800&height=240$/.test(home.logo.src));
    assert.ok(!texts(home.blocks).includes('Classes'));
    assert.ok(!images(home.blocks).some((i) => i.src.includes('Logo')));
});

check('only the desktop copy of each breakpoint is kept: desktop heading levels, no repeated pictures', () => {
    const muddy = home.blocks.find((b) => b.kind === 'heading' && b.text === 'Come and get your hands muddy');
    assert.ok(muddy && muddy.kind === 'heading' && muddy.level === 2, 'phone copy (h4) came first in the page; desktop h2 kept');
    const ids = images(home.blocks).map((i) => i.src.split('?')[0]);
    assert.strictEqual(ids.length, new Set(ids).size);
    assert.strictEqual(ids.length, 5);
    const nh = readImportPage(html('no-hydrate'), `${SITE}/`);
    assert.strictEqual(nh.blocks.filter((b) => b.kind === 'heading').length, 1);
    assert.ok(nh.blocks.some((b) => b.kind === 'heading' && b.level === 1));
});

check('pictures are full size: scale-down-to gone, capped at 2048 for very large originals', () => {
    assert.ok(images(home.blocks).every((i) => !/scale-down-to/.test(i.src)));
    assert.strictEqual(adapter.fullSizeImage!('https://framerusercontent.com/images/A.jpg?scale-down-to=512&width=1600&height=1200'), 'https://framerusercontent.com/images/A.jpg?width=1600&height=1200');
    assert.strictEqual(adapter.fullSizeImage!('https://framerusercontent.com/images/A.jpg?scale-down-to=512&width=6000&height=4000'), 'https://framerusercontent.com/images/A.jpg?width=6000&height=4000&scale-down-to=2048');
    assert.strictEqual(adapter.fullSizeImage!('https://example.com/a.jpg?scale-down-to=512'), null);
});

check('buttons drawn as a link round a heading read as buttons; links inside sentences are kept', () => {
    const buttons = home.blocks.filter((b) => b.kind === 'button').map((b) => b.kind === 'button' && [b.text, b.href]);
    assert.deepStrictEqual(buttons, [['See our classes', `${SITE}/classes`], ['Call the studio', 'tel:+441947000000'], ['Book a class', `${SITE}/contact`]]);
    assert.ok(!home.blocks.some((b) => b.kind === 'heading' && b.level === 6));
    const intro = home.blocks.find((b) => b.kind === 'text' && b.text.startsWith('We make mugs'));
    assert.deepStrictEqual(intro && intro.kind === 'text' && intro.links, [{ text: 'evening classes', href: `${SITE}/classes` }]);
    // A card link (picture, title, line) is left as content.
    assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.text === 'Firing the wood kiln'));
});

check('footer, cookie banner and "Made in Framer" badge are not content; contact details still read', () => {
    const t = texts(home.blocks).join(' | ');
    assert.ok(!/Made in Framer|cookies|© 2026|Customise|3 Harbour Lane/.test(t), t);
    assert.deepStrictEqual(home.contact.emails, ['hello@harbourlane.example']);
    assert.deepStrictEqual(home.socialLinks, ['https://www.instagram.com/harbourlanepottery.example']);
    assert.ok(adapter.noise!.test('Made in Framer'));
});

check('contact page: form questions without select options, and the Maps frame becomes a map button', () => {
    const c = readImportPage(html('contact'), `${SITE}/contact`);
    assert.deepStrictEqual(c.formFields, ['Name', 'Email', 'Which class?', 'Message']);
    const map = c.blocks.find((b) => b.kind === 'button' && b.text === 'See us on the map');
    assert.ok(map && map.kind === 'button' && map.href === 'https://www.google.com/maps?q=54.4858%2C-0.6206&z=15');
});

check('runImport reads the menu pages too (no network, no model)', async () => {
    const files: Record<string, string> = { [`${SITE}/`]: 'home', [`${SITE}/about`]: 'about', [`${SITE}/contact`]: 'contact', [`${SITE}/classes`]: 'about' };
    const current = starterSite({ name: 'Harbour Lane Pottery', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@x.example' }, themeFromBrandKit(null));
    const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 5 }, {
        fetchHtml: async (u) => (files[u] ? { ok: true, html: html(files[u]), finalUrl: u } : { ok: false, message: 'missing' }),
        plan: async () => null, savePicture: async () => null,
    });
    assert.ok(r.ok, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.strictEqual(r.report.platform, 'framer');
    assert.deepStrictEqual(r.report.pages.map((p) => p.title), ['Home', 'Classes', 'About', 'Contact']);
    assert.ok(r.report.pages.every((p) => p.read));
    assert.strictEqual(r.report.look?.primaryColor, '#c2562b');
    assert.strictEqual(r.report.look?.font, 'editorial');
});

void Promise.all(pending).then(() => console.log(`\n${passed}/${total} passed`));
