// tests/site-platform-godaddy.test.ts
// The Website import on GoDaddy Website Builder (Websites + Marketing) sites: src/utils/site-builders/godaddy.ts.
// Saved SYNTHETIC pages only, no network and no model: tests/fixtures/site-platforms/godaddy/.
// Report: docs/site-import-platforms/godaddy.md
//
// Run:  npx tsx tests/site-platform-godaddy.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, goDaddyFullSize, goDaddySrcset, readGoDaddyLook } from '../src/utils/site-builders/godaddy';
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
const fixture = (f: string) => readFileSync(join(root, `tests/fixtures/site-platforms/godaddy/${f}.html`), 'utf8');
const SITE = 'https://hollinlane.example';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => ('text' in b ? b.text : ''));
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));

async function main() {
    console.log('\nDetection');

    await check('a GoDaddy page is recognised by its generator tag, on its own domain too', () => {
        assert.strictEqual(found(fixture('home')), 'godaddy');
        assert.strictEqual(found(fixture('contact-us')), 'godaddy');
        assert.strictEqual(found('<html><head><meta name="generator" content="Starfield Technologies; Go Daddy Website Builder 7.0.5350"></head><body><p>Old builder</p></body></html>'), 'godaddy');
    });

    await check('without the generator tag: GoDaddy\'s widget markup and picture host together', () => {
        const html = '<html><body><div data-ux="Page"><div data-ux="Widget"><h1 data-aid="HEADER_TAGLINE_RENDERED">Hi</h1><img src="//img1.wsimg.com/isteam/ip/abc/a.jpg"></div></div></body></html>';
        assert.strictEqual(found(html), 'godaddy');
    });

    await check('a page that only mentions GoDaddy, or shows one of its pictures, is not taken for a GoDaddy site', () => {
        assert.strictEqual(found('<html><body><main><p>Our domain is registered with GoDaddy.</p><a href="https://www.godaddy.com">GoDaddy</a></main></body></html>'), null);
        assert.strictEqual(found('<html><body><main><img src="https://img1.wsimg.com/isteam/ip/abc/a.jpg"><p>Hand-made page</p></main></body></html>'), null);
    });

    console.log('\nReading a page');
    const home = readImportPage(fixture('home'), `${SITE}/`);

    await check('the page says GoDaddy read it, and its words come out once each, in order', () => {
        assert.strictEqual(home.platform, 'godaddy');
        const t = texts(home);
        assert.deepStrictEqual(t.slice(0, 4), ['Stoneware made by hand in the Dales', 'Pots for everyday tables', 'Book a class', 'Why people visit']);
        assert.strictEqual(t.filter((x) => x === 'Book a class').length, 1, 'the phone copy of the hero is not a second button');
        assert.strictEqual(t.filter((x) => x === 'Pots for everyday tables').length, 1);
    });

    await check('each card keeps its own heading (the hidden copies that even out card heights are not read)', () => {
        const t = texts(home);
        const at = (s: string) => t.indexOf(s);
        assert.ok(at('Small batches') < at('Every piece is thrown, trimmed and fired in our barn, a dozen at a time.'));
        assert.ok(at('Every piece is thrown, trimmed and fired in our barn, a dozen at a time.') < at('Glazes mixed on site from local clay'), 'card 2\'s heading is not pulled up into card 1');
        assert.ok(at('Glazes mixed on site from local clay') < at('We test each glaze on our own clay before it goes near a customer\'s mug.'));
    });

    await check('a link inside a sentence is kept with it', () => {
        const b = home.blocks.find((x) => x.kind === 'text' && x.text.startsWith('We test each glaze'));
        assert.ok(b && b.kind === 'text' && b.links?.some((l) => l.text === 'our own clay' && l.href === `${SITE}/about-us`));
    });

    await check('opening hours: each day keeps its hours (identical hours are not dropped as repeats)', () => {
        const t = texts(home);
        for (const d of ['Thu', 'Fri', 'Sat']) assert.ok(t.includes(`${d} 10:00 am – 04:00 pm`), d);
        assert.ok(t.includes('Sun Closed'));
        assert.ok(!t.includes('Open today'), 'the collapsed "today" summary is not read');
    });

    await check('GoDaddy\'s furniture is not read: cookie banner, chat bubble, gallery counter, "#" links, account menu, powered-by', () => {
        const all = texts(home).join('\n');
        for (const s of ['This website uses cookies', 'Message us', '1/6', 'Sign In', 'Create Account', 'filler@godaddy.com', 'Shopping Cart Icon', 'Powered by', 'Accept']) assert.ok(!all.includes(s), s);
        assert.ok(!home.blocks.some((b) => b.kind === 'button' && (b.text === '#' || /^#?$/.test(b.href ?? 'x'))));
        assert.ok(!home.contact.emails.includes('filler@godaddy.com'));
    });

    await check('the menu: their pages once each, the "More" overflow box is no drop-down, the logo is not a menu entry', () => {
        assert.deepStrictEqual(home.navLinks.map((l) => [l.text, l.href, l.group ?? null]), [
            ['Home', `${SITE}/`, null], ['About us', `${SITE}/about-us`, null], ['Classes', `${SITE}/classes`, null],
            ['Contact us', `${SITE}/contact-us`, null], ['Gallery', `${SITE}/gallery`, null],
        ], 'Gallery was only in the overflow box: it joins the menu at the end');
        assert.ok(!home.navLinks.some((l) => /cart|\/m\//.test(l.href)));
        const contact = readImportPage(fixture('contact-us'), `${SITE}/contact-us`);
        assert.deepStrictEqual(contact.navLinks.map((l) => l.text), ['Home', 'About us', 'Contact us'], 'a text logo ("Hollin Lane Pottery" ×3) is not a menu entry');
    });

    console.log('\nPictures');

    await check('lazy pictures are read from their real address, not GoDaddy\'s transparent placeholder', () => {
        const srcs = images(home);
        assert.ok(srcs.some((s) => s.includes('/mugs-drying.jpg/')), 'data-srclazy');
        assert.ok(srcs.some((s) => s.includes('/glaze-test.jpg/')), 'data-srcsetlazy');
        assert.ok(!srcs.some((s) => /transparent_placeholder|^data:/.test(s)));
        const mugs = home.blocks.find((b) => b.kind === 'image' && b.src.includes('mugs-drying'));
        assert.ok(mugs && mugs.kind === 'image' && mugs.alt === 'Mugs drying on a wooden board' && mugs.altFromSite);
    });

    await check('background pictures (hero, ranges) are read from GoDaddy\'s per-screen-size stylesheet, once each', () => {
        const srcs = images(home);
        assert.strictEqual(srcs.filter((s) => s.includes('/barn-wheel.jpg/')).length, 1);
        assert.ok(srcs.some((s) => s.includes('/glaze-shelf.jpg/')));
        assert.ok(srcs.indexOf(srcs.find((s) => s.includes('barn-wheel'))!) === 0, 'the hero picture comes first');
    });

    await check('GoDaddy stock-library pictures are left out (licensed for GoDaddy sites, not the owner\'s)', () => {
        assert.ok(!images(home).some((s) => s.includes('/isteam/stock/')));
    });

    await check('the logo: the image logo, from a srcset whose addresses contain commas', () => {
        assert.ok(home.logo && home.logo.src.startsWith('https://img1.wsimg.com/isteam/ip/') && home.logo.src.includes('rs=w:400,h:400'));
        assert.strictEqual(home.logo?.alt, 'Hollin Lane Pottery');
    });

    await check('full size: one large address per picture, keeping the owner\'s percentage crop', () => {
        assert.strictEqual(goDaddyFullSize('//img1.wsimg.com/isteam/ip/s1/a.jpg/:/cr=t:5.99%25,l:0%25,w:88.02%25,h:88.02%25/rs=w:365,h:365,cg:true'), 'https://img1.wsimg.com/isteam/ip/s1/a.jpg/:/cr=t:5.99%25,l:0%25,w:88.02%25,h:88.02%25/rs=w:1600,m');
        assert.strictEqual(goDaddyFullSize('https://img1.wsimg.com/isteam/ip/s1/b.jpg/:/rs=w:388,h:194,cg:true,m/cr=w:388,h:194/qt=q:95'), 'https://img1.wsimg.com/isteam/ip/s1/b.jpg/:/rs=w:1600,m', 'a pixel crop after the resize goes');
        assert.strictEqual(goDaddyFullSize('https://img1.wsimg.com/isteam/ip/s1/c.jpg'), 'https://img1.wsimg.com/isteam/ip/s1/c.jpg');
        assert.strictEqual(goDaddyFullSize('https://images.example/a.jpg'), null);
        const about = readImportPage(fixture('about-us'), `${SITE}/about-us`);
        assert.deepStrictEqual(images(about), ['https://img1.wsimg.com/isteam/ip/0a1b2c3d-0000-4000-8000-00000000hl01/the-barn.jpg/:/rs=w:1600,m']);
    });

    await check('srcsets with commas inside the addresses', () => {
        assert.strictEqual(goDaddySrcset('//x.wsimg.com/a/:/rs=w:200,h:200,cg:true,m, //x.wsimg.com/a/:/rs=w:600,h:600,cg:true,m 3x'), '//x.wsimg.com/a/:/rs=w:600,h:600,cg:true,m');
        assert.strictEqual(goDaddySrcset('https://a.example/1.jpg 400w, https://a.example/2.jpg 1200w'), 'https://a.example/2.jpg');
        assert.strictEqual(goDaddySrcset(undefined), null);
    });

    console.log('\nContact page and look');

    await check('the contact page: address, email, phone and form questions', () => {
        const p = readImportPage(fixture('contact-us'), `${SITE}/contact-us`);
        assert.strictEqual(p.contact.emails[0], 'hello@hollinlane.example');
        assert.strictEqual(p.contact.phones[0], '01632960123');
        assert.ok(texts(p).includes('Hollin Lane Barn, Kettlewell, Skipton BD23 0QZ'));
        assert.deepStrictEqual(p.formFields, ['Name', 'Email', 'Message']);
        assert.ok(p.hasForm);
    });

    await check('their look as GoDaddy draws it: button colour and lettering from its per-class rules (helper, not wired yet)', () => {
        const html = fixture('home');
        const look = readGoDaddyLook(html, cheerio.load(html));
        assert.strictEqual(look.primaryColor, '#1f6b63');
        assert.strictEqual(look.headingFont, 'Fraunces');
        assert.strictEqual(look.font, 'editorial');
        const grey = '<html><head><style data-glamor="x">.x .c1-a{background-color:rgb(237, 235, 235)}</style></head><body><a data-ux="ButtonPrimary" class="c1-a">Go</a></body></html>';
        assert.strictEqual(readGoDaddyLook(grey, cheerio.load(grey)).primaryColor, null, 'a grey template button is not a brand colour');
    });

    await check('a broken page never throws out of the adapter', () => {
        const $ = cheerio.load('<div data-ux="ContentCard"><h4 data-ux="ContentCardHeading">x</h4></div><img data-srclazy="">');
        assert.doesNotThrow(() => adapter.prepare!($, null));
    });

    console.log('\nThe whole import (no network, no model)');

    const PAGES: Record<string, string> = { [`${SITE}/`]: fixture('home'), [`${SITE}/about-us`]: fixture('about-us'), [`${SITE}/contact-us`]: fixture('contact-us') };
    const calls = { pictures: [] as string[] };
    const deps: ImportDeps = {
        async fetchHtml(url) { const html = PAGES[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async plan() { return null; },
        async savePicture(src) { calls.pictures.push(src); return 900 + calls.pictures.length; },
    };
    const current = () => starterSite({ name: 'Hollin Lane Pottery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

    await check('runImport reads the menu pages, reports GoDaddy, finds the pictures and the contact details', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'godaddy');
        assert.deepStrictEqual(r.report.pages.map((p) => [p.title, p.read]), [['Home', true], ['About us', true], ['Classes', false], ['Contact us', true], ['Gallery', false]]);
        assert.strictEqual(r.report.contact.email, 'hello@hollinlane.example');
        assert.ok(r.report.hadForm);
        assert.ok(r.report.pictures.found >= 6, `found ${r.report.pictures.found}`);
        const all = JSON.stringify(r.definition.pages);
        for (const s of ['Pots for everyday tables', 'Every piece is thrown, trimmed and fired in our barn, a dozen at a time.', 'Hollin Lane started in 2014']) assert.ok(all.includes(s), s);
        for (const s of ['This website uses cookies', 'Message us', 'filler@godaddy.com']) assert.ok(!all.includes(s), s);
    });

    console.log(`\n${passed}/${total} passed`);
}

main();
