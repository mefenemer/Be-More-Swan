// tests/site-platform-elementor.test.ts
// The Website import on Elementor pages (src/utils/site-builders/elementor.ts), against SYNTHETIC
// fixtures modelled on Elementor 3.x markup (tests/fixtures/site-platforms/elementor/). No network, no model.
//
// Run:  npx tsx tests/site-platform-elementor.test.ts      (ELEMENTOR_DEBUG=1 prints the blocks)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { elementorFullSize, elementorKitStylesheet, readElementorKit } from '../src/utils/site-builders/elementor';
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
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fx = (f: string) => read(`tests/fixtures/site-platforms/elementor/${f}`);
const SITE = 'https://hazelandrye.example';
const home = readImportPage(fx('home.html'), `${SITE}/`);
const about = readImportPage(fx('about.html'), `${SITE}/about/`);
const texts = (bs: ImportBlock[]) => bs.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (bs: ImportBlock[]) => bs.filter((b): b is Extract<ImportBlock, { kind: 'image' }> => b.kind === 'image');
const buttons = (bs: ImportBlock[]) => bs.filter((b): b is Extract<ImportBlock, { kind: 'button' }> => b.kind === 'button');
if (process.env.ELEMENTOR_DEBUG) for (const p of [home, about]) { console.log(p.url, p.navLinks, p.logo); for (const b of p.blocks) console.log(' ', JSON.stringify(b)); }

console.log('Detection');

check('Elementor pages are recognised; the other saved platforms and a hand-made page are not', () => {
    const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
    assert.strictEqual(found(fx('home.html')), 'elementor');
    assert.strictEqual(found(fx('about.html')), 'elementor');
    assert.strictEqual(found(read('tests/fixtures/site-import/wix-home.html')), 'wix');
    assert.strictEqual(found(read('tests/fixtures/site-import/sqsp-home.html')), 'squarespace');
    for (const f of ['bare-html', 'spa-shell', 'webflow-saas', 'wix-local', 'squarespace-weak']) assert.notStrictEqual(found(read(`tests/fixtures/site-pages/${f}.html`)), 'elementor', f);
    assert.strictEqual(found('<html><head><meta name="generator" content="WordPress 6.6"></head><body><main>x</main></body></html>'), 'wordpress');
});

check('a WooCommerce product page on an Elementor site is left to the WooCommerce adapter', () => {
    const html = '<html><body class="product-template-default single-product woocommerce woocommerce-page elementor-default elementor-kit-6"><main><h1>Rye loaf</h1></main><script src="/wp-content/plugins/woocommerce/x.js"></script></body></html>';
    assert.notStrictEqual(adapterFor(html, cheerio.load(html))?.key, 'elementor');
});

console.log('\nWords, headings and menu');

check('menu with its drop-down, read once although Elementor prints it twice', () => {
    assert.deepStrictEqual(home.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Our Bakes', null], ['Sourdough', 'Our Bakes'], ['Celebration Cakes', 'Our Bakes'], ['About', null], ['Contact', null]]);
});

check('counters show the number a visitor sees (1,200+), not the "0" in the HTML', () => {
    const t = texts(home.blocks);
    assert.ok(t.includes('1,200+'), t.join(' | '));
    assert.ok(t.includes('18'));
    assert.ok(t.indexOf('Loaves baked each week') < t.indexOf('1,200+'));
});

check('a heading widget set to <span>/<div> is read as a heading; the animated headline keeps its first word', () => {
    assert.ok(home.blocks.some((b) => b.kind === 'heading' && b.text === 'Baked in Kendal since 2016'));
    assert.ok(about.blocks.some((b) => b.kind === 'heading' && b.text === 'Questions we are often asked'));
    assert.ok(about.blocks.some((b) => b.kind === 'heading' && b.level === 1 && b.text === 'A family bakery for sourdough'));
});

check('the phone copy of a section is dropped (no "What we bake:" twice, no cropped thumbnail)', () => {
    assert.ok(!texts(home.blocks).includes('What we bake:'));
    assert.ok(!images(home.blocks).some((i) => i.src.includes('/elementor/thumbs/')));
    assert.strictEqual(texts(home.blocks).filter((t) => t === 'What we bake').length, 1);
});

check('testimonials are quotes, each once (carousel clones gone), and carousel buttons are not words', () => {
    const quotes = home.blocks.filter((b) => b.kind === 'quote').map((b) => (b as { text: string }).text);
    assert.deepStrictEqual(quotes, ['Our wedding cake was beautiful and tasted even better than it looked.', 'The seeded rye is the best bread in the county, and they always remember our order.']);
    assert.ok(!texts(home.blocks).some((t) => /^(next slide|previous)$/i.test(t)));
});

check('popups (printed hidden on every page) are not read as content', () => {
    for (const p of [home, about]) assert.ok(!texts(p.blocks).some((t) => /10% off|newsletter/i.test(t)), p.url);
});

check('links inside sentences and buttons are kept', () => {
    const p = home.blocks.find((b) => b.kind === 'text' && b.text.startsWith('We mill'));
    assert.deepStrictEqual(p && 'links' in p ? p.links : null, [{ text: 'ask about wholesale', href: `${SITE}/wholesale/` }]);
    assert.ok(buttons(home.blocks).some((b) => b.text === 'Order for collection' && b.href === `${SITE}/order/`));
});

check('social icons are profiles, not "Instagram"/"Facebook" buttons', () => {
    assert.ok(!buttons(home.blocks).some((b) => /instagram|facebook/i.test(b.text)));
    assert.deepStrictEqual(home.socialLinks, ['https://www.instagram.com/hazelandrye.example', 'https://www.facebook.com/hazelandrye.example']);
});

check('accordion questions and answers are text, never buttons to the same page', () => {
    const t = texts(about.blocks);
    for (const q of ['Do you bake gluten-free bread?', 'Not yet. Our bakery is full of rye and wheat flour, so we can\'t promise anything is free from gluten.', 'Can I collect on Sundays?']) assert.ok(t.includes(q), q);
    assert.ok(!buttons(about.blocks).some((b) => /Sundays/.test(b.text)));
});

check('Canvas page with no theme header: the top row is the header (menu + logo), the © row the footer', () => {
    assert.deepStrictEqual(about.navLinks.map((l) => l.text), ['Home', 'About', 'Contact']);
    assert.ok(about.logo?.src.endsWith('hazel-rye-logo.png'));
    assert.ok(!images(about.blocks).some((i) => i.src.includes('logo')));
    assert.ok(!buttons(about.blocks).some((b) => b.href === 'tel:01539000000'), 'the header\'s call button is not page content');
    assert.ok(about.contact.phones.length === 1 && about.contact.emails[0] === 'hello@hazelandrye.example');
});

console.log('\nPictures, video and map');

check('pictures: lazy-loaded (WP Rocket) at full size, style-sheet background, slideshow, gallery originals', () => {
    const h = images(home.blocks).map((i) => i.src);
    assert.ok(h.includes(`${SITE}/wp-content/uploads/2024/05/shaping-rye.jpg`), h.join(' '));
    assert.ok(h.includes(`${SITE}/wp-content/uploads/2024/05/hero-loaves.jpg`));
    assert.ok(h.includes(`${SITE}/wp-content/uploads/2024/05/counter-morning.jpg`));
    assert.ok(!h.some((s) => s.includes('hover-flour')), 'a hover picture is not a picture of the page');
    const a = images(about.blocks);
    assert.deepStrictEqual(a.filter((i) => /starter-jar|night-shift/.test(i.src)).map((i) => [i.src.split('/').pop(), i.altFromSite]), [['starter-jar.jpg', true], ['night-shift.jpg', false]]);
});

check('video widget (drawn by JavaScript) and WP Rocket\'s lazy YouTube become a thumbnail and a "Watch" button; the map a map button', () => {
    assert.ok(buttons(home.blocks).some((b) => b.href === 'https://www.youtube.com/watch?v=Hz7RyeBake0'));
    assert.ok(images(home.blocks).some((i) => i.src === 'https://i.ytimg.com/vi/Hz7RyeBake0/hqdefault.jpg'));
    assert.ok(buttons(about.blocks).some((b) => b.href === 'https://www.youtube.com/watch?v=AbCdEfGh123'));
    const map = buttons(home.blocks).find((b) => b.text === 'See us on the map');
    assert.ok(map?.href?.startsWith('https://www.google.com/maps?q=4%20Mill%20Yard'), map?.href ?? 'no map');
});

check('full-size addresses: WordPress -WxH copies and Jetpack resizes; Elementor crops kept', () => {
    assert.strictEqual(elementorFullSize(`${SITE}/wp-content/uploads/2024/05/a-1024x683.jpg`), `${SITE}/wp-content/uploads/2024/05/a.jpg`);
    assert.strictEqual(elementorFullSize(`${SITE}/wp-content/uploads/2024/05/a-scaled.jpg`), null);
    assert.strictEqual(elementorFullSize(`${SITE}/wp-content/uploads/elementor/thumbs/a-qd8x1z9.jpg`), null);
    assert.strictEqual(elementorFullSize('https://i0.wp.com/x.example/wp-content/uploads/a.jpg?resize=800%2C600&ssl=1'), 'https://i0.wp.com/x.example/wp-content/uploads/a.jpg?ssl=1');
    assert.strictEqual(elementorFullSize('https://cdn.example/a-300x200.jpg'), null);
});

console.log('\nThe look');

check('the kit stylesheet is found, and its global colours and fonts read (not wired into the import yet)', () => {
    assert.strictEqual(elementorKitStylesheet(fx('home.html'), `${SITE}/`), `${SITE}/wp-content/uploads/elementor/css/post-6.css?ver=1730000000`);
    const k = readElementorKit(fx('home.html'), fx('post-6.css'));
    assert.deepStrictEqual([k.primaryColor, k.secondaryColor, k.textColor, k.accentColor, k.headingFont, k.bodyFont, k.font, k.defaults], ['#7a4b2a', '#2f3b2f', '#3a3a3a', '#d98e32', 'Fraunces', 'Inter', 'editorial', false]);
});

check('a kit left at Elementor\'s defaults (#6EC1E4, Roboto) gives no colours or fonts', () => {
    const k = readElementorKit('<style>.elementor-kit-5{--e-global-color-primary:#6EC1E4;--e-global-color-secondary:#54595F;--e-global-color-text:#7A7A7A;--e-global-color-accent:#61CE70;--e-global-typography-primary-font-family:"Roboto";--e-global-typography-text-font-family:"Roboto"}</style>');
    assert.deepStrictEqual([k.primaryColor, k.accentColor, k.headingFont, k.font, k.defaults], [null, null, null, null, true]);
});

console.log('\nThe whole import');

check('runImport with no model: home + menu pages read, nothing from popups or phone copies lands', async () => {
    const pages: Record<string, string> = { [`${SITE}/`]: fx('home.html'), [`${SITE}/about/`]: fx('about.html') };
    const deps: ImportDeps = {
        async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async plan() { return null; },
        async savePicture() { return null; },
        async fetchCss(u) { return u.includes('post-6.css') ? fx('post-6.css') : null; },
    };
    const current = starterSite({ name: 'Hazel & Rye Bakery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
    const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 8 }, deps);
    assert.ok(r.ok, r.ok ? '' : r.message);
    if (!r.ok) return;
    assert.strictEqual(r.report.platform, 'elementor');
    const all = JSON.stringify(r.definition.pages);
    assert.ok(all.includes('Slow bread, made by hand every morning') && all.includes('1,200+') && all.includes('Hazel started baking'));
    assert.ok(!/10% off|What we bake:|Next slide/.test(all));
});

(async () => {
    for (const t of queue) await t();
    console.log(`\n${passed}/${total} passed`);
})();
