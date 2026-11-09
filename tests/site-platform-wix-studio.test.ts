// tests/site-platform-wix-studio.test.ts
// The Website import on Wix Studio pages (src/utils/site-builders/wix-studio.ts): told apart from
// classic Wix, real pictures instead of blurred placeholders, crops kept, FAQ accordions opened,
// Studio's own controls left out. Fixtures are synthetic (tests/fixtures/site-platforms/wix-studio/).
//
// Run:  npx tsx tests/site-platform-wix-studio.test.ts

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/wix-studio';
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
const dir = join(root, 'tests/fixtures/site-platforms/wix-studio');
const fixture = (f: string) => readFileSync(join(dir, `${f}.html`), 'utf8');
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const SITE = 'https://www.fernlea.example';
const home = () => readImportPage(fixture('studio-home'), `${SITE}/`);
const texts = (p: ImportPage) => p.blocks.map((b) => ('text' in b ? b.text : ''));
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b] : []));

async function main() {
    console.log('\nWix Studio: detection');

    await check('Studio pages are Wix Studio; a classic Wix page is not, though it carries the same "wix-studio" logging script', () => {
        assert.strictEqual(found(fixture('studio-home')), 'wix-studio');
        assert.strictEqual(found(fixture('studio-contact')), 'wix-studio');
        const classic = fixture('classic-home');
        assert.ok(classic.includes('wix-studio'), 'the classic fixture must carry the string that fooled the old test');
        assert.strictEqual(found(classic), 'wix');
        assert.strictEqual(found(readFileSync(join(root, 'tests/fixtures/site-import/wix-home.html'), 'utf8')), 'wix');
    });

    await check('no false positives: other platforms\' fixtures, and "wix-studio" or "Studio" in a non-Wix page', () => {
        const others = [join(root, 'tests/fixtures/site-import')];
        const plat = join(root, 'tests/fixtures/site-platforms');
        if (existsSync(plat)) for (const d of readdirSync(plat)) if (d !== 'wix-studio') others.push(join(plat, d));
        for (const d of others) {
            if (!existsSync(d)) continue;
            for (const f of readdirSync(d).filter((x) => x.endsWith('.html'))) assert.notStrictEqual(found(readFileSync(join(d, f), 'utf8')), 'wix-studio', `${d}/${f}`);
        }
        assert.notStrictEqual(found('<html><body><main><p>We are a wix-studio agency. "editorName":"Studio"</p></main></body></html>'), 'wix-studio');
        assert.notStrictEqual(found('<html><head><meta name="generator" content="WordPress 6.6"></head><body><p>Our Wix Studio portfolio</p></body></html>'), 'wix-studio');
    });

    await check('a Studio page saved without its scripts is still known by its page body', () => {
        const bare = '<html><head><meta name="generator" content="Wix.com Website Builder"></head><body><main id="PAGE_SECTIONSab12c" data-main-content-parent="true"><p>Hello</p></main></body></html>';
        assert.strictEqual(found(bare), 'wix-studio');
        assert.strictEqual(found(bare.replace('<p>', '<script>{"editorName":"Unknown"}</script><p>')), 'wix');
    });

    console.log('\nWix Studio: reading a page');

    await check('words, headings, the button and the link inside a sentence come through, in order', () => {
        const p = home();
        assert.strictEqual(p.platform, 'wix-studio');
        assert.strictEqual(p.builder, 'wix');
        const h1 = p.blocks.find((b) => b.kind === 'heading' && b.level === 1);
        assert.ok(h1 && 'text' in h1 && h1.text === 'Stoneware made slowly, by hand');
        const intro = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('We throw'));
        assert.ok(intro && intro.kind === 'text' && intro.links?.[0]?.text === 'try the wheel' && intro.links[0].href === `${SITE}/classes`);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Book a class' && b.href === `${SITE}/classes`));
        assert.deepStrictEqual(p.navLinks.map((l) => l.text), ['Home', 'Classes', 'Visit the studio', 'Contact']);
    });

    await check('responsive pictures: the placeholder\'s tiny size no longer drops them, and they come full size with their own description', () => {
        const imgs = images(home());
        const mugs = imgs.find((i) => i.src.includes('aa11bb_mugs0001'));
        assert.ok(mugs, 'the 74×49 placeholder picture was dropped as an icon');
        assert.ok(mugs.src.includes('/v1/fit/w_1600,h_1600,q_85/') && !/blur|w_74/.test(mugs.src), mugs.src);
        assert.strictEqual(mugs.alt, 'Speckled mugs drying on a wooden shelf');
        assert.ok(mugs.altFromSite);
        assert.ok(imgs.some((i) => i.src.includes('aa11bb_kiln00001')), 'the section background picture');
        assert.ok(!imgs.some((i) => i.src.includes('ig000001')), 'the footer icon is not a picture');
    });

    await check('a cropped picture keeps its crop and a clean file name (the shared rule mangled chained steps)', () => {
        const bowl = images(home()).find((i) => i.src.includes('aa11bb_bowl0001'));
        assert.ok(bowl);
        assert.strictEqual(bowl.src, 'https://static.wixstatic.com/media/aa11bb_bowl0001~mv2.jpg/v1/crop/x_40,y_120,w_2000,h_1500/fit/w_1600,h_1600,q_85/bowl.jpg');
    });

    await check('FAQ accordion: each question is a heading and its answer its own text, links kept', () => {
        const p = home();
        const at = p.blocks.findIndex((b) => b.kind === 'heading' && b.text === 'Do I need any experience?');
        assert.ok(at > 0, 'question as a heading');
        const ans = p.blocks[at + 1];
        assert.ok(ans.kind === 'text' && ans.text.startsWith('None at all'));
        const second = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('About three weeks'));
        assert.ok(second && second.kind === 'text' && second.links?.[0]?.href === `${SITE}/shop-visits`);
        assert.ok(!p.blocks.some((b) => b.kind === 'button' && /experience|collect/.test(b.text)), 'questions are not buttons');
        assert.ok(!p.blocks.some((b) => b.kind === 'item' && /experience/.test(b.text)), 'question and answer are not one list item');
    });

    await check('Studio\'s own controls and furniture are not content; the owner\'s marquee words are, once', () => {
        const t = texts(home());
        for (const noise of ['Play Marquee', '1/3', 'top of page', 'bottom of page', 'Powered and secured by Wix', '© 2026']) assert.ok(!t.some((x) => x.includes(noise)), noise);
        assert.strictEqual(t.filter((x) => x.includes('Wheel classes')).length, 1);
        assert.strictEqual(t.filter((x) => x.startsWith('Mugs, bowls and planters')).length, 1, 'the duplicate copy is read once');
        assert.ok(t.some((x) => x.includes('The calmest Saturday morning')));
    });

    await check('"24/7" and "3/4" are the owner\'s words, kept even beside a slideshow', () => {
        const html = fixture('studio-home').replace('<span>1/3</span>', '<span>1/3</span></div><div><span>24/7</span><span>3/4</span>');
        const t = texts(readImportPage(html, `${SITE}/`));
        assert.ok(t.includes('24/7') && t.includes('3/4') && !t.includes('1/3'));
    });

    await check('contact page: form questions, map button, phone and address line', () => {
        const p = readImportPage(fixture('studio-contact'), `${SITE}/contact`);
        assert.strictEqual(p.platform, 'wix-studio');
        assert.ok(p.hasForm);
        assert.deepStrictEqual(p.formFields, ['First name', 'Email', 'Your message']);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'See us on the map'));
        assert.ok(p.contact.phones.length === 1);
        assert.ok(texts(p).includes('Studio 4, Mill Yard, Fernlea'));
    });

    await check('a broken picture description never stops the read', () => {
        const html = fixture('studio-home').replace(/data-image-info="\{&quot;containerId&quot;:&quot;comp-img01/, 'data-image-info="{not json');
        const p = readImportPage(html, `${SITE}/`);
        assert.ok(p.blocks.some((b) => b.kind === 'heading'));
    });

    console.log('\nWix Studio: picture addresses');

    await check('fullSizeImage: Wix steps → one sensible size, crop kept; originals sized; other hosts left', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f('https://static.wixstatic.com/media/ab_c~mv2.png/v1/fill/w_49,h_16,al_c,blur_2/n.png'), 'https://static.wixstatic.com/media/ab_c~mv2.png/v1/fit/w_1600,h_1600,q_85/n.png');
        assert.strictEqual(f('https://static.wixstatic.com/media/ab_c~mv2.png/v1/crop/x_0,y_150,w_1896,h_1749/fill/w_49,h_45/Leopard.png'), 'https://static.wixstatic.com/media/ab_c~mv2.png/v1/crop/x_0,y_150,w_1896,h_1749/fit/w_1600,h_1600,q_85/Leopard.png');
        assert.strictEqual(f('https://static.wixstatic.com/media/ab_c~mv2.jpg'), 'https://static.wixstatic.com/media/ab_c~mv2.jpg/v1/fit/w_1600,h_1600,q_85/ab_c~mv2.jpg');
        assert.strictEqual(f('https://images.example/photo.jpg'), null);
        assert.strictEqual(f('not a url'), null);
    });

    console.log('\nWix Studio: the whole import (no network, no model)');

    await check('runImport reads home and contact, copies the real pictures, keeps the form questions', async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: fixture('studio-home'), [`${SITE}/contact`]: fixture('studio-contact') };
        const saved: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const h = pages[url]; return h ? { ok: true, html: h, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 900 + saved.length; },
        };
        const current = starterSite({ name: 'Fernlea Pottery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'wix-studio');
        assert.ok(r.report.pages.find((p) => p.url === `${SITE}/contact`)?.read);
        assert.ok(r.report.pictures.found >= 3, `found ${r.report.pictures.found}`);
        assert.ok(!saved.some((s) => /blur_|w_74|\/fill\/.*\/fill\//.test(s)), saved.join(' '));
        assert.deepStrictEqual(r.report.formFields, ['First name', 'Email', 'Your message']);
        assert.strictEqual(r.report.contact.email, 'hello@fernlea.example');
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
