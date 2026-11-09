// tests/site-platform-weebly.test.ts
// The Website import on Weebly (classic `wsite-*` sites) and Square Online (the page sent as JSON in
// window.__BOOTSTRAP_STATE__): src/utils/site-builders/weebly.ts. Saved SYNTHETIC pages only — no
// network, no model: tests/fixtures/site-platforms/weebly/. Findings: docs/site-import-platforms/weebly.md
//
// Run:  npx tsx tests/site-platform-weebly.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, balancedJson, decodeCfEmail } from '../src/utils/site-builders/weebly';
import { readImportPage, type ImportPage } from '../src/utils/site-extract';
import { draftWordsAllFromSource, runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const fx = (f: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/weebly', f), 'utf8');
const W = 'https://www.kestrelcycles.example';
const SQ = 'https://www.kestrel-online.example';
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => ('text' in b ? b.text : ''));
const images = (p: ImportPage) => p.blocks.filter((b): b is Extract<typeof b, { kind: 'image' }> => b.kind === 'image');
const current = () => starterSite({ name: 'Kestrel Cycle Repairs', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

function deps(pages: Record<string, string>): ImportDeps & { calls: { render: string[]; pictures: string[] } } {
    const calls = { render: [] as string[], pictures: [] as string[] };
    return {
        calls,
        async fetchHtml(url) {
            const html = pages[url] ?? pages[url.replace(/\/$/, '')];
            return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' };
        },
        async renderHtml(url) { calls.render.push(new URL(url).pathname); return { ok: false, message: 'no browser in tests' }; },
        async plan() { return null; },
        async savePicture(src) { calls.pictures.push(src); return 700 + calls.pictures.length; },
    };
}

async function main() {
    const home = readImportPage(fx('classic-home.html'), `${W}/`);
    const about = readImportPage(fx('classic-about.html'), `${W}/about.html`);
    const blog = readImportPage(fx('classic-blog.html'), `${W}/blog.html`);
    const sq = readImportPage(fx('square-online-home.html'), `${SQ}/`);

    console.log('\nWhich pages are Weebly');

    await check('classic Weebly and Square Online pages are read by the weebly adapter', () => {
        for (const f of ['classic-home.html', 'classic-about.html', 'classic-blog.html', 'square-online-home.html']) {
            const html = fx(f);
            assert.strictEqual(adapterFor(html, cheerio.load(html))?.key, 'weebly', f);
        }
        assert.strictEqual(home.platform, 'weebly');
        assert.strictEqual(sq.platform, 'weebly');
    });

    await check('a page that only mentions Weebly in its words is not taken for one', () => {
        const html = '<html><body><main><p>We moved our site off Weebly last year.</p></main></body></html>';
        assert.strictEqual(adapter.detect(html, '', cheerio.load(html)), false);
    });

    console.log('\nClassic Weebly');

    await check('the menu is read from Weebly\'s script, with the sub-pages its HTML leaves out', () => {
        assert.deepStrictEqual(home.navLinks.map((l) => [l.text, new URL(l.href).pathname, l.group ?? null]), [
            ['Home', '/', null], ['Services', '/services.html', null],
            ['Wheel Building', '/wheel-building.html', 'Services'], ['E-bike Servicing', '/e-bike-servicing.html', 'Services'],
            ['About', '/about.html', null], ['Blog', '/blog.html', null], ['Contact', '/contact.html', null],
        ]);
    });

    await check('without the script, the menu in the page is still the menu (not page content), and the logo link is not "Home"', () => {
        assert.deepStrictEqual(about.navLinks.map((l) => l.text), ['Home', 'About', 'Contact']);
        assert.ok(!texts(about).some((t) => /^(Home|About|Contact|Kestrel Cycle Repairs)$/.test(t)), texts(about).join(' | '));
    });

    await check('the logo is the logo, not a picture on the page', () => {
        assert.strictEqual(home.logo?.src, `${W}/uploads/1/2/3/4/123456789/kestrel-logo_1.png`);
        assert.ok(!images(home).some((i) => i.src.includes('kestrel-logo')));
    });

    await check('a text box split by blank lines, with a list inside, keeps every sentence — as its own paragraph', () => {
        const t = texts(home);
        const at = (s: string) => t.findIndex((x) => x.startsWith(s));
        assert.ok(at('We have looked after') >= 0 && at('Every service starts') > at('We have looked after'));
        assert.ok(at('Puncture repairs') > at('Every service starts') && at('Drop in or ring ahead') > at('Gears and brakes'));
        const p = home.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Every service starts'));
        assert.deepStrictEqual(p && 'links' in p ? p.links : null, [{ text: 'free safety check', href: `${W}/services.html` }], 'a link in a sentence stays in the sentence');
        assert.ok(!home.blocks.some((b) => b.kind === 'button' && b.text === 'free safety check'));
    });

    await check('columns keep their headings, captions and text apart', () => {
        const kinds = home.blocks.map((b) => `${b.kind}:${'text' in b ? b.text.slice(0, 20) : ''}`);
        assert.ok(kinds.includes('heading:Servicing') && kinds.includes('heading:Wheel building'), kinds.join(' | '));
        assert.ok(texts(home).includes('Our workshop stand'));
    });

    await check('pictures: Weebly\'s default "Picture" is no description, galleries give the original, slideshows are found', () => {
        const srcs = images(home).map((i) => i.src);
        const stand = images(home).find((i) => i.src.includes('workshop-stand'))!;
        assert.strictEqual(stand.altFromSite, false);
        assert.strictEqual(stand.src, `${W}/uploads/1/2/3/4/123456789/published/workshop-stand.jpg`, 'cache-buster dropped');
        assert.ok(srcs.includes(`${W}/uploads/1/2/3/4/123456789/tandem-restored_orig.jpg`) && srcs.includes(`${W}/uploads/1/2/3/4/123456789/cargo-bike_orig.jpg`));
        const slide = images(home).find((i) => i.src.endsWith('/shop-front.jpg'))!;
        assert.ok(slide && slide.alt === 'The shop on Mill Lane' && slide.altFromSite);
        assert.ok(srcs.some((s) => s.endsWith('/customer-ride.jpg')));
        assert.ok(srcs.some((s) => s.includes('background-images/')), 'the header section\'s picture');
        assert.ok(!srcs.some((s) => s.includes('editmysite.com')), 'no Weebly advert picture');
    });

    await check('Weebly\'s map becomes a map link; a Cloudflare-hidden email address is read', () => {
        assert.ok(home.blocks.some((b) => b.kind === 'button' && b.href === 'https://www.google.com/maps?q=53.8008,-1.5491'));
        assert.deepStrictEqual(home.contact.emails, ['hello@kestrelcycles.example']);
        assert.ok(texts(home).includes('Write to us at hello@kestrelcycles.example or ring 01632 960123.'));
        assert.strictEqual(decodeCfEmail('5a323f3636351a313f292e283f36392339363f29743f223b372a363f'), 'hello@kestrelcycles.example');
        assert.strictEqual(decodeCfEmail('zz'), null);
    });

    await check('Weebly\'s furniture is left out: footer advert, search, log-in, cart, mobile menu copy', () => {
        const all = texts(home).join(' | ');
        for (const bit of ['Powered by', 'Get Started', 'Create your own', 'Cart', 'Log In', 'Search', 'Menu']) assert.ok(!all.includes(bit), bit);
        assert.deepStrictEqual(home.socialLinks, ['https://www.facebook.com/kestrelcycles.example'], 'the footer\'s profiles are still found');
        assert.ok(!all.includes('4 Mill Lane'), 'the footer is a footer, as on every other platform');
    });

    await check('older themes: title, picture, paragraphs, video and quote, no "Powered by"', () => {
        assert.deepStrictEqual(about.blocks.map((b) => b.kind), ['heading', 'image', 'text', 'text', 'image', 'button', 'quote']);
        assert.ok(!texts(about).some((t) => /powered by|©/i.test(t)));
    });

    await check('a blog page keeps the post, not its date, comment counts, sharing or sidebar', () => {
        assert.deepStrictEqual(texts(blog), ['Winter chain care', 'Salt on the roads eats chains. Rinse yours after every wet ride and oil it once it is dry.', 'Read More']);
    });

    console.log('\nSquare Online');

    await check('the page sent as JSON is read without a browser: banner, rows, list, links by page id', () => {
        assert.ok(sq.words >= 40, `words ${sq.words}`);
        assert.deepStrictEqual(sq.blocks.map((b) => `${b.kind}:${'text' in b ? b.text : ''}`), [
            'heading:Bikes fixed properly, first time', 'image:', 'button:Book a repair',
            'heading:Pure craftsmanship', 'text:Every bike gets a free safety check before we touch a spanner.', 'text:We use the same parts we would fit to our own bikes.', 'image:',
            'heading:What we fix', 'item:Punctures while you wait', 'item:Gears and brakes', 'text:Questions? Write to us any time.', 'button:See all repairs',
            'heading:Why riders come back', `text:${texts(sq).at(-1)}`,
        ]);
        assert.ok(texts(sq).at(-1)!.startsWith('We explain every job'));
        assert.ok(!images(sq).some((i) => i.src.includes('hidden_1')), 'a hidden picture stays out');
        const p = sq.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Every bike'));
        assert.deepStrictEqual(p && 'links' in p ? p.links : null, [{ text: 'free safety check', href: `${SQ}/our-story` }]);
        assert.strictEqual(sq.blocks.find((b) => b.kind === 'button')!.kind === 'button' && (sq.blocks.find((b) => b.kind === 'button') as { href: string }).href, `${SQ}/repairs`);
    });

    await check('Square Online: hidden elements, theme placeholder labels and store blocks stay out', () => {
        const all = texts(sq).join(' | ');
        for (const bit of ['Hidden editor text', 'Default banner label', 'Shop now', 'View products', 'Quality Craftsmanship', 'Popular this week']) assert.ok(!all.includes(bit), bit);
    });

    await check('Square Online: original pictures with their descriptions, the logo, the menu with its sub-page, the email', () => {
        assert.deepStrictEqual(images(sq).map((i) => [i.src, i.altFromSite]), [
            [`${SQ}/uploads/b/cccc0000/workshop_1700000001.jpg`, true],
            [`${SQ}/uploads/b/cccc0000/stand_1700000002.jpg`, false],
        ]);
        assert.strictEqual(sq.logo?.src, `${SQ}/uploads/b/cccc0000/kestrel-logo_1700000000.png`);
        assert.deepStrictEqual(sq.navLinks.map((l) => [l.text, new URL(l.href).pathname, l.group ?? null]), [['Home', '/', null], ['Our story', '/our-story', null], ['Repairs', '/repairs', 'Our story'], ['Contact', '/contact-us', null]]);
        assert.deepStrictEqual(sq.contact.emails, ['hello@kestrelcycles.example']);
    });

    await check('picture addresses: Square Online sizes and Weebly cache-busters are dropped, others kept', () => {
        assert.strictEqual(adapter.fullSizeImage!('https://abc.cdn6.editmysite.com/uploads/b/x/y.jpg?width=640&optimize=high&dpr=2'), 'https://abc.cdn6.editmysite.com/uploads/b/x/y.jpg');
        assert.strictEqual(adapter.fullSizeImage!(`${W}/uploads/1/2/3/4/123/published/a.jpg?1700000000`), `${W}/uploads/1/2/3/4/123/published/a.jpg`);
        assert.strictEqual(adapter.fullSizeImage!('https://elsewhere.example/a.jpg?w=200'), null);
        assert.strictEqual(balancedJson('x = {"a":"}{","b":[1]}; y', 4), '{"a":"}{","b":[1]}');
    });

    await check('a broken bootstrap falls back to reading the page as it is', () => {
        const page = readImportPage('<html><head><meta name="generator" content="Square Online"></head><body><div id="app"></div><script>window.__BOOTSTRAP_STATE__ = {"siteData": {broken</script><main><p>Words outside the app.</p></main></body></html>', `${SQ}/`);
        assert.strictEqual(page.platform, 'weebly');
        assert.ok(texts(page).includes('Words outside the app.'));
    });

    console.log('\nThe whole import (no network, no model)');

    await check('classic Weebly: every page read, sub-pages offered, words kept as theirs, the logo copied', async () => {
        const d = deps({ [`${W}/`]: fx('classic-home.html'), [`${W}/about.html`]: fx('classic-about.html'), [`${W}/blog.html`]: fx('classic-blog.html') });
        const r = await runImport({ url: `${W}/`, pictures: 'copy', current: current(), maxPages: 20 }, d);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'weebly');
        const tried = r.report.pages.map((p) => new URL(p.url).pathname);
        for (const p of ['/', '/services.html', '/wheel-building.html', '/e-bike-servicing.html', '/about.html', '/blog.html', '/contact.html']) assert.ok(tried.includes(p), `${p} in ${tried.join(', ')}`);
        assert.ok(r.report.pages.find((p) => p.url.endsWith('/about.html'))?.read);
        assert.strictEqual(r.report.contact.email, 'hello@kestrelcycles.example');
        assert.deepStrictEqual(d.calls.render, ['/blog.html'], 'the browser only for the one short page');
        // No plan (no model): only the logo is copied — and from the logo's own address, not a resized copy.
        assert.ok(d.calls.pictures.includes(`${W}/uploads/1/2/3/4/123456789/kestrel-logo_1.png`), d.calls.pictures.join(', '));
        const homeRead = { url: `${W}/`, menuLabel: 'Home', page: home };
        assert.deepStrictEqual(draftWordsAllFromSource(r.definition, [homeRead, { url: `${W}/about.html`, menuLabel: 'About', page: about }, { url: `${W}/blog.html`, menuLabel: 'Blog', page: blog }]), []);
    });

    await check('Square Online: the home page imports without the headless browser', async () => {
        const d = deps({ [`${SQ}/`]: fx('square-online-home.html') });
        const r = await runImport({ url: `${SQ}/`, pictures: 'skip', current: current(), maxPages: 1 }, d);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.deepStrictEqual(d.calls.render, []);
        assert.ok(r.report.wordsRead >= 80, `words ${r.report.wordsRead}`);
        assert.ok(JSON.stringify(r.definition).includes('Every bike gets a'));
    });

    console.log(`\n${passed}/${total} passed`);
}

void main();
