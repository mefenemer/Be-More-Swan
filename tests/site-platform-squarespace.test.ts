// tests/site-platform-squarespace.test.ts
// The Website import on Squarespace 7.0 and 7.1 sites (src/utils/site-builders/squarespace.ts).
// Synthetic pages modelled on Squarespace's markup: tests/fixtures/site-platforms/squarespace/.
// No network and no model: saved pages in, plan null.
//
// Run:  npx tsx tests/site-platform-squarespace.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, hslTripleToHex, readSquarespaceLook, squarespaceSiteCssUrl } from '../src/utils/site-builders/squarespace';
import { readImportPage, type ImportPage } from '../src/utils/site-extract';
import { draftWordsAllFromSource, runImport, type ImportDeps, type ReadPage } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const fx = (f: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/squarespace', f), 'utf8');
const SITE = 'https://fernlea.example';
const home71 = () => readImportPage(fx('home-71.html'), `${SITE}/`);
const home70 = () => readImportPage(fx('home-70.html'), 'https://brackenbury.example/');
const contact71 = () => readImportPage(fx('contact-71.html'), `${SITE}/contact`);
const texts = (p: ImportPage) => p.blocks.map((b) => (b.kind === 'image' ? `[img ${b.src}]` : `${b.kind}:${b.text}`));
const has = (p: ImportPage, kind: string, text: string) => p.blocks.some((b) => b.kind === kind && b.kind !== 'image' && b.text === text);

async function main() {
    await check('recognised from Squarespace\'s own marks, with no generator tag; a hot-linked picture alone is not Squarespace', () => {
        for (const f of ['home-71.html', 'home-70.html', 'contact-71.html']) {
            const html = fx(f);
            assert.strictEqual(adapterFor(html, cheerio.load(html))?.key, 'squarespace', f);
        }
        const old = readFileSync(join(root, 'tests/fixtures/site-import/sqsp-home.html'), 'utf8');
        assert.strictEqual(adapterFor(old, cheerio.load(old))?.key, 'squarespace');
        const hotlink = '<html><body><main><img src="https://images.squarespace-cdn.com/content/v1/x/y.jpg"><p>Hand-made page</p></main></body></html>';
        assert.strictEqual(adapter.detect(hotlink, '', cheerio.load(hotlink)), false);
        assert.strictEqual(adapter.rendersWithJs, false);
    });

    await check('menu: drop-down pages under their folder, no folder address, cart, account or phone-menu "Back"', () => {
        const nav = home71().navLinks.map((l) => `${l.text}${l.group ? ` (${l.group})` : ''}`);
        assert.deepStrictEqual(nav, ['Home', 'Taster sessions (Classes)', 'Six-week course (Classes)', 'Shop', 'Contact']);
        const nav70 = home70().navLinks.map((l) => `${l.text}${l.group ? ` (${l.group})` : ''}`);
        assert.deepStrictEqual(nav70, ['Home', 'Order a cake', 'Our story (About)', 'Stockists (About)', 'Contact']);
    });

    await check('7.1 list sections: each card\'s title, words and button read on their own', () => {
        const t = texts(home71());
        const at = t.indexOf('heading:Tableware');
        assert.ok(at > 0, t.join('\n'));
        assert.deepStrictEqual(t.slice(at, at + 3), ['heading:Tableware', 'text:Speckled mugs and bowls glazed in small batches.', 'button:See the shop']);
        assert.ok(!t.some((x) => x.startsWith('item:Tableware')));
    });

    await check('accordion questions become headings with their answers; image cards split into title, words, button', () => {
        const p = home71();
        assert.ok(has(p, 'heading', 'Do I need any experience?') && has(p, 'text', 'None at all. Most of our students have never touched clay.'));
        assert.ok(has(p, 'heading', 'Firing days') && has(p, 'button', 'How firing works'));
        assert.ok(has(p, 'text', 'We fire the kiln every other Friday. Your pieces are ready to collect the week after.'));
    });

    await check('words, the link inside a sentence and the hero button come across', () => {
        const p = home71();
        assert.ok(has(p, 'heading', 'Hand-thrown stoneware from the Calder Valley'));
        const intro = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Mugs, bowls'));
        assert.deepStrictEqual(intro && 'links' in intro ? intro.links : null, [{ text: 'try a taster session', href: `${SITE}/taster-sessions` }]);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Book the six-week course' && b.href === `${SITE}/six-week-course`));
        assert.ok(has(p, 'quote', '“The best Saturday morning I have had in years.”'));
    });

    await check('shop controls and the form\'s pop-up button are not read; the price stays for the import\'s price list', () => {
        const t = texts(home71()).join('\n');
        for (const gone of ['Add to cart', 'Decrease quantity by 1', 'Increase quantity by 1', 'button:Sign up']) assert.ok(!t.includes(gone), gone);
        assert.ok(t.includes('text:£24.00'));
    });

    await check('pictures: one full-size address each, lazy 7.0 pictures and gallery thumbnails folded into one', () => {
        const imgs = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));
        const i71 = imgs(home71());
        assert.ok(i71.includes('https://images.squarespace-cdn.com/content/v1/aaaa1111/1700000000001-HERO/wheel-hands.jpg?format=1500w'), i71.join('\n'));
        assert.ok(i71.includes('https://images.squarespace-cdn.com/content/v1/aaaa1111/1700000000003-KILN/kiln-door.jpg?format=1500w'));
        const i70 = imgs(home70());
        assert.deepStrictEqual(i70, [
            'https://static1.squarespace.com/static/dddd4444/t/aaaa0002/1600000000001/layer-cake.jpg?format=1500w',
            'https://static1.squarespace.com/static/dddd4444/t/aaaa0003/1600000000002/lemon-drizzle.jpg?format=1500w',
            'https://static1.squarespace.com/static/dddd4444/t/aaaa0004/1600000000003/wedding-tiers.jpg?format=1500w',
        ]);
        assert.strictEqual(adapter.fullSizeImage!('https://images.squarespace-cdn.com/x/anim.gif?format=300w'), null);
        assert.strictEqual(adapter.fullSizeImage!('https://cdn.example/x.jpg?format=300w'), null);
    });

    await check('video block (player kept in an attribute) becomes its thumbnail and a "Watch the video" button', () => {
        const p = home71();
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.href === 'https://www.youtube.com/watch?v=AbCdEf12345'));
        assert.ok(p.blocks.some((b) => b.kind === 'image' && b.src === 'https://i.ytimg.com/vi/AbCdEf12345/hqdefault.jpg' && b.alt === 'A morning in the studio'));
    });

    await check('7.1 form block (fields in a JSON script) is read as a form with its questions; hidden fields left out', () => {
        const c = contact71();
        assert.strictEqual(c.hasForm, true);
        assert.deepStrictEqual(c.formFields, ['Name', 'Email', 'Phone', 'Which class?', 'Message']);
        assert.ok(!texts(c).some((x) => x.includes('Which class?')), 'a form\'s labels are not page words');
        assert.deepStrictEqual(home71().formFields, ['Name', 'Email']);
    });

    await check('map block: the address it pins and a "See us on the map" button', () => {
        const c = contact71();
        assert.strictEqual(c.contact.address, 'Unit 3, Canal Wharf, Hebden Bridge HX7 8AA');
        const map = c.blocks.find((b) => b.kind === 'button' && b.text === 'See us on the map');
        assert.ok(map && map.kind === 'button' && map.href?.startsWith('https://maps.google.com/maps?q=Fernlea%20Pottery'), JSON.stringify(map));
    });

    await check('7.1 look: palette and fonts from site.css (helper for the shared look reader)', () => {
        assert.strictEqual(squarespaceSiteCssUrl(fx('home-71.html'), `${SITE}/`), 'https://static1.squarespace.com/static/versioned-site-css/aaaa1111/12/bbbb2222/cccc3333/1500/site.css');
        assert.strictEqual(squarespaceSiteCssUrl(fx('home-70.html'), 'https://brackenbury.example/'), 'https://static1.squarespace.com/static/sitecss/dddd4444/20/eeee5555/ffff6666/300/site.css?&filterFeatures=false');
        assert.strictEqual(hslTripleToHex('0,0%,100%'), '#ffffff');
        assert.strictEqual(hslTripleToHex('0,100%,50%'), '#ff0000');
        const look = readSquarespaceLook(fx('site-71.css'));
        assert.deepStrictEqual(look, { primaryColor: '#bb5935', textColor: '#1b2327', backgroundColor: '#faf8f5', headingFont: 'Playfair Display', font: 'classic' });
        assert.strictEqual(readSquarespaceLook('body{color:#333}'), null);
    });

    await check('whole import, no model: reads home + menu pages, words only from their pages, platform reported', async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: fx('home-71.html'), [`${SITE}/contact`]: fx('contact-71.html') };
        const asked: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { asked.push(url); const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture() { return null; },
        };
        const current = starterSite({ name: 'Fernlea Pottery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'squarespace');
        assert.ok(!asked.some((u) => /classes-folder|cart|back-to-root/.test(u)), asked.join(' '));
        assert.deepStrictEqual(r.report.formFields, ['Name', 'Email', 'Phone', 'Which class?', 'Message']);
        const read: ReadPage[] = [{ url: `${SITE}/`, menuLabel: 'Home', page: home71() }, { url: `${SITE}/contact`, menuLabel: 'Contact', page: contact71() }];
        assert.deepStrictEqual(draftWordsAllFromSource(r.definition, read, ['Fernlea Pottery']), []);
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
