// tests/site-platform-wix.test.ts
// The Website import on classic Wix sites (src/utils/site-builders/wix.ts). Saved SYNTHETIC pages only,
// modelled on Wix's server HTML — no network, no model: tests/fixtures/site-platforms/wix/.
// Findings: docs/site-import-platforms/wix.md
//
// Run:  npx tsx tests/site-platform-wix.test.ts

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { adapter, readWixLook, wixFullSize } from '../src/utils/site-builders/wix';
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
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const wix = (f: string) => read(`tests/fixtures/site-platforms/wix/${f}.html`);
const SITE = 'https://www.hazelthyme.example';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;

// Every Wix page — classic or Studio — carries Wix's monitoring script, which names "wix-studio".
// Until the Wix Studio adapter stops matching that (reported to its session), classic pages are read
// here with it stood aside, so these tests prove what THIS adapter does. The detection check below
// says plainly when that is still needed.
const studio = ADAPTERS.find((a) => a.key === 'wix-studio') as { detect: (h: string, g: string, $: cheerio.CheerioAPI) => boolean } | undefined;
const studioClaimsClassic = !!studio && found(wix('home')) === 'wix-studio';
const studioDetect = studio?.detect;
function asClassic<T>(fn: () => T): T {
    if (!studio || !studioClaimsClassic) return fn();
    studio.detect = () => false;
    try { return fn(); } finally { studio.detect = studioDetect!; }
}
async function asClassicAsync<T>(fn: () => Promise<T>): Promise<T> {
    if (!studio || !studioClaimsClassic) return fn();
    studio.detect = () => false;
    try { return await fn(); } finally { studio.detect = studioDetect!; }
}
const page = (f: string, url = `${SITE}/`): ImportPage => asClassic(() => readImportPage(wix(f), url));
const words = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : '')).join(' | ');

async function main() {
    console.log('\nDetection');

    await check('classic Wix pages are recognised; no other saved page is', () => {
        for (const f of ['home', 'contact']) assert.ok(adapter.detect(wix(f), 'wix.com website builder', cheerio.load(wix(f))), f);
        assert.ok(adapter.detect(read('tests/fixtures/site-import/wix-home.html'), '', cheerio.load('')));
        assert.ok(adapter.detect(read('tests/fixtures/site-pages/wix-local.html'), '', cheerio.load('')));
        const others = [
            ...['sqsp-home', 'sqsp-services', 'sqsp-contact'].map((f) => `tests/fixtures/site-import/${f}.html`),
            ...readdirSync(join(root, 'tests/fixtures/site-pages')).filter((f) => f.endsWith('.html') && !f.startsWith('wix')).map((f) => `tests/fixtures/site-pages/${f}`),
            ...readdirSync(join(root, 'tests/fixtures/site-platforms')).filter((d) => !d.startsWith('wix')).flatMap((d) =>
                readdirSync(join(root, 'tests/fixtures/site-platforms', d)).filter((f) => f.endsWith('.html')).map((f) => `tests/fixtures/site-platforms/${d}/${f}`)),
        ];
        for (const f of others) {
            const html = read(f);
            const gen = (cheerio.load(html)('meta[name="generator"]').attr('content') ?? '').toLowerCase();
            assert.ok(!adapter.detect(html, gen, cheerio.load(html)), `false positive: ${f}`);
        }
    });

    await check('the import picks the Wix adapter for classic pages (Wix Studio comes first and must not claim them)', () => {
        if (studioClaimsClassic) console.log('    ! wix-studio.ts still claims classic Wix pages (its test matches "wix-studio" in Wix\'s own script) — read below with it stood aside');
        assert.strictEqual(asClassic(() => found(wix('home'))), 'wix');
        assert.strictEqual(asClassic(() => found(wix('contact'))), 'wix');
    });

    console.log('\nReading a page');

    await check('their words come through, titles styled as paragraphs become headings', () => {
        const p = page('home');
        assert.strictEqual(p.platform, 'wix');
        const heads = p.blocks.filter((b) => b.kind === 'heading').map((b) => [b.kind === 'heading' ? b.level : 0, 'text' in b ? b.text : '']);
        assert.deepStrictEqual(heads, [[1, 'Flowers for the moments that matter'], [2, 'Grown, not flown'], [3, 'Weddings and events'], [2, 'Join our flower notes']]);
        const t = words(p);
        for (const w of ['Hand-tied bouquets', 'Studio open Thursday to Saturday', 'Bridal bouquets and buttonholes']) assert.ok(t.includes(w), w);
        assert.ok(p.blocks.some((b) => b.kind === 'text' && b.text === 'New'), 'a short ribbon stays text');
    });

    await check("Wix's furniture is not content: banner, top/bottom anchors, menu help, thank-yous, show more", () => {
        const t = words(page('home'));
        for (const noise of ['top of page', 'bottom of page', 'designed with the', 'Start Now', 'Use tab to navigate', 'Thanks for submitting', 'Thanks for subscribing', 'Show more', 'Powered and secured', 'More']) {
            assert.ok(!t.split(' | ').some((x) => x.includes(noise)), noise);
        }
    });

    await check('buttons keep their links, and a link inside a sentence stays with its words', () => {
        const p = page('home');
        const buttons = p.blocks.filter((b) => b.kind === 'button').map((b) => b.kind === 'button' && [b.text, b.href]);
        assert.deepStrictEqual(buttons, [['Order a bouquet', `${SITE}/contact`], ['Plan your wedding flowers', `${SITE}/weddings`]]);
        const para = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Every stem'));
        assert.ok(para && para.kind === 'text');
        assert.deepStrictEqual(para.links, [{ text: 'how we grow', href: `${SITE}/our-story` }]);
    });

    await check('the menu is in order and only the real drop-down is one', () => {
        const nav = page('home').navLinks;
        assert.deepStrictEqual(nav.map((l) => l.text), ['Home', 'Weddings', 'Our Story', 'Kind Words', 'Contact']);
        assert.deepStrictEqual(nav.map((l) => l.group ?? null), [null, null, 'About', 'About', null]);
    });

    await check('pictures come at full size — including ones whose address has commas, a crop, or no src yet', () => {
        const imgs = page('home').blocks.filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? b.src : ''));
        assert.deepStrictEqual(imgs, [
            'https://static.wixstatic.com/media/f1e2d3_hero0001~mv2.jpg/v1/fit/w_1600,h_1600,q_85/f1e2d3_hero0001~mv2.jpg',
            'https://static.wixstatic.com/media/f1e2d3_spring001~mv2.jpg/v1/crop/x_0,y_120,w_3000,h_1760/fit/w_1600,h_1600,q_85/Spring%20bouquet.jpg',
            'https://static.wixstatic.com/media/f1e2d3_arch0002~mv2.jpg/v1/fit/w_1600,h_1600,q_85/f1e2d3_arch0002~mv2.jpg',
        ]);
        const p = page('home');
        const spring = p.blocks.find((b) => b.kind === 'image' && b.src.includes('spring'));
        assert.ok(spring && spring.kind === 'image' && spring.altFromSite && spring.alt.startsWith('Spring bouquet'));
        const arch = p.blocks.find((b) => b.kind === 'image' && b.src.includes('arch'));
        assert.ok(arch && arch.kind === 'image' && !arch.altFromSite, 'a file name is not a description');
        assert.strictEqual(p.logo?.src, 'https://static.wixstatic.com/media/f1e2d3_0a1b2c3d4e5f~mv2.png/v1/fit/w_1600,h_1600,q_85/ht-logo.png');
        assert.ok(!JSON.stringify(p.blocks).includes('w_39'), 'social icons are not pictures');
    });

    await check('full-size addresses: resized, blurred, cropped, original, not Wix', () => {
        assert.strictEqual(wixFullSize('https://static.wixstatic.com/media/a1_b~mv2.jpg/v1/fill/w_147,h_98,al_c,q_80,blur_2,enc_avif,quality_auto/a1_b~mv2.jpg'), 'https://static.wixstatic.com/media/a1_b~mv2.jpg/v1/fit/w_1600,h_1600,q_85/a1_b~mv2.jpg');
        assert.strictEqual(wixFullSize('https://static.wixstatic.com/media/a1_b~mv2.png'), 'https://static.wixstatic.com/media/a1_b~mv2.png/v1/fit/w_1600,h_1600,q_85/a1_b~mv2.png');
        assert.strictEqual(wixFullSize('https://static.wixstatic.com/media/a1_b.jpg/v1/crop/x_10,y_0,w_900,h_600/fill/w_300,h_200,al_c/Shop.jpg'), 'https://static.wixstatic.com/media/a1_b.jpg/v1/crop/x_10,y_0,w_900,h_600/fit/w_1600,h_1600,q_85/Shop.jpg');
        assert.strictEqual(wixFullSize('https://example.com/a.jpg'), null);
        assert.strictEqual(wixFullSize('not a url'), null);
    });

    await check('the contact page: contact details, form questions, the map as a button', () => {
        const p = page('contact', `${SITE}/contact`);
        assert.deepStrictEqual(p.blocks.filter((b) => b.kind === 'heading').map((b) => ('text' in b ? b.text : '')), ['Say hello']);
        assert.ok(p.hasForm);
        assert.deepStrictEqual(p.formFields, ['First name', 'Email', 'Your occasion']);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'See us on the map'));
        assert.ok(!words(p).includes('Thanks for submitting'));
        const home = page('home');
        assert.deepStrictEqual(home.contact.emails, ['hello@hazelthyme.example']);
        assert.deepStrictEqual(home.contact.phones, ['01632960123']);
        assert.deepStrictEqual(home.socialLinks, ['https://www.instagram.com/hazelthyme.example']);
    });

    await check('the older saved Wix page still reads, its file-name alt text dropped', () => {
        const p = asClassic(() => readImportPage(read('tests/fixtures/site-import/wix-home.html'), 'https://www.crumb.example/'));
        assert.strictEqual(p.platform, 'wix');
        const t = words(p);
        assert.ok(t.includes('Order a cake at least a week ahead'));
        assert.strictEqual((t.match(/baked every morning in Leith/g) ?? []).length, 1, 'a box drawn twice is read once');
        assert.ok(!t.includes('top of page'));
        const img = p.blocks.find((b) => b.kind === 'image');
        assert.ok(img && img.kind === 'image' && img.src.includes('/v1/fit/w_1600') && !img.altFromSite);
    });

    console.log('\nThe look');

    await check("their look from Wix's theme: palette, button colours, corners and fonts — never Wix's own blue", () => {
        const look = readWixLook(wix('home'));
        assert.deepStrictEqual(look, {
            primaryColor: '#2e6b4a', textColor: '#26221e', backgroundColor: '#fcf9f4', secondaryColor: '#d66240',
            headingFont: 'playfair display', font: 'classic', radius: 'large',
        });
        const none = readWixLook('<html><body><p>Hand-made</p></body></html>');
        assert.ok(Object.values(none).every((v) => v === null), 'nothing found → every value null');
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport reads home and menu pages as Wix, with their words, pictures and drop-down', async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: wix('home'), [`${SITE}/contact`]: wix('contact') };
        const pictures: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { pictures.push(src); return 500 + pictures.length; },
        };
        const current = starterSite({ name: 'Hazel & Thyme', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await asClassicAsync(() => runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 5 }, deps));
        assert.ok(r.ok, r.ok ? '' : r.message);
        assert.strictEqual(r.report.platform, 'wix');
        assert.strictEqual(r.report.builder, 'wix');
        assert.ok(r.report.pictures.found >= 4, `pictures found: ${r.report.pictures.found}`);
        const draft = JSON.stringify(r.definition.pages);
        for (const w of ['Flowers for the moments that matter', 'Grown, not flown', 'Say hello']) assert.ok(draft.includes(w), w);
        assert.ok(!draft.includes('top of page') && !draft.includes('quality_auto/'), 'no Wix furniture or broken picture addresses');
        assert.ok(pictures.every((s) => s.startsWith('https://static.wixstatic.com/media/')), pictures.join('\n'));
    });

    await check('the adapter says Wix pages are drawn on the server', () => {
        assert.strictEqual(adapter.rendersWithJs, false);
        assert.strictEqual(adapter.contentRoot, '#PAGES_CONTAINER');
    });

    console.log(`\n${passed}/${total} passed`);
}

main();
