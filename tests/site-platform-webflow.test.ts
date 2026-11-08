// tests/site-platform-webflow.test.ts
// Website import of a Webflow site (src/utils/site-builders/webflow.ts). Synthetic pages modelled on
// Webflow's published markup — a made-up bakery, no real business's words or pictures:
// tests/fixtures/site-platforms/webflow/. No network, no model.
//
// Run:  npx tsx tests/site-platform-webflow.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/webflow';
import { readImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { readImportedLook } from '../src/utils/site-import-theme';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const dir = join(__dirname, 'fixtures/site-platforms/webflow');
const file = (f: string) => readFileSync(join(dir, f), 'utf8');
const SITE = 'https://www.hazelrye.example';
const PAGES: Record<string, string> = { [`${SITE}/`]: file('home.html'), [`${SITE}/about`]: file('about.html'), [`${SITE}/contact`]: file('contact.html') };
const CSS = file('hazel-rye.webflow.css');
const page = (path: string) => readImportPage(PAGES[`${SITE}${path}`], `${SITE}${path}`);
const texts = (p: ReturnType<typeof page>) => p.blocks.map((b) => (b.kind === 'image' ? `[img] ${b.src}` : b.text));

async function main() {
    console.log('Recognising Webflow');

    await check('the generator tag, or Webflow\'s page attributes and file names without one', () => {
        for (const html of Object.values(PAGES)) assert.strictEqual(adapterFor(html, cheerio.load(html))?.key, 'webflow');
        const noGen = '<html data-wf-page="1" data-wf-site="2"><body><main><p>x</p></main></body></html>';
        assert.strictEqual(adapterFor(noGen, cheerio.load(noGen))?.key, 'webflow');
        const css = '<html><head><link href="https://cdn.prod.website-files.com/1/css/shop.webflow.shared.abc.min.css" rel="stylesheet"></head><body></body></html>';
        assert.strictEqual(adapterFor(css, cheerio.load(css))?.key, 'webflow');
        const plain = '<html><body><main><p>A hand-made page that mentions Webflow in a sentence.</p></main></body></html>';
        assert.strictEqual(adapterFor(plain, cheerio.load(plain)), null);
    });

    console.log('\nThe home page');

    await check('words, headings and buttons in order; faded-in (opacity:0) words are still read', () => {
        const p = page('/');
        assert.strictEqual(p.platform, 'webflow');
        const t = texts(p);
        assert.strictEqual(t[0], 'Bread worth getting up for');
        assert.ok(t.includes('We bake slow-fermented sourdough and seasonal cakes every morning, a short walk from the village green.'));
        assert.deepStrictEqual(p.blocks.filter((b) => b.kind === 'button').slice(0, 2).map((b) => b.kind === 'button' && [b.text, b.href]), [['Order for collection', `${SITE}/contact`], ['Meet the bakers', `${SITE}/about`]]);
    });

    await check('the menu: in order, with the drop-down\'s pages under its label', () => {
        assert.deepStrictEqual(page('/').navLinks, [
            { text: 'Home', href: `${SITE}/` },
            { text: 'Bread', href: `${SITE}/bakes/bread`, group: 'Our bakes' },
            { text: 'Cakes', href: `${SITE}/bakes/cakes`, group: 'Our bakes' },
            { text: 'About', href: `${SITE}/about` },
            { text: 'Visit us', href: `${SITE}/contact` },
        ]);
    });

    await check('the logo comes from the menu\'s brand link (Webflow draws no <header>)', () => {
        assert.deepStrictEqual(page('/').logo, { src: 'https://cdn.prod.website-files.com/64aa00000000000000000001/64aa0000000000000000b001_hazel-rye-mark.png', alt: 'Hazel & Rye' });
    });

    await check('CMS list items are read; words hidden on the live site are not', () => {
        const t = texts(page('/'));
        for (const w of ['Country white', 'Our everyday loaf: a crackling crust and an open, chewy crumb.', 'Seeded rye']) assert.ok(t.includes(w), w);
        // One "Sold out today" is shown (Seeded rye); Country white's is hidden by a CMS condition.
        assert.strictEqual(t.filter((x) => x === 'Sold out today').length, 1);
        assert.strictEqual(t.indexOf('Sold out today'), t.indexOf('Seeded rye') - 1);
        assert.ok(!t.includes('No items found.'));
    });

    await check('pictures at full size, from srcset', () => {
        const imgs = page('/').blocks.filter((b) => b.kind === 'image').map((b) => b.kind === 'image' && b.src);
        assert.ok(imgs.includes('https://cdn.prod.website-files.com/64aa00000000000000000001/64aa0000000000000000c001_country-white.jpg'));
        assert.ok(!imgs.some((s) => /-p-\d+/.test(String(s))));
    });

    await check('tabs: each label stands as a heading above its own words', () => {
        const t = texts(page('/'));
        const wd = t.indexOf('Weekdays'), we = t.indexOf('Weekends');
        assert.ok(wd >= 0 && we > wd);
        assert.strictEqual(t[wd + 1], 'Tuesday to Friday, 7.30am until the bread runs out.');
        assert.strictEqual(t[we + 1], 'Saturday 8am to 2pm. Closed on Sundays and Mondays.');
        assert.ok(page('/').blocks.some((b) => b.kind === 'heading' && b.text === 'Weekdays'));
        assert.ok(!page('/').blocks.some((b) => b.kind === 'button' && /w-tabs/.test(b.href ?? '')));
    });

    await check('a Webflow video (embedly iframe) becomes its thumbnail and a "Watch the video" button', () => {
        const b = page('/').blocks;
        assert.ok(b.some((x) => x.kind === 'button' && x.href === 'https://www.youtube.com/watch?v=AbCdEfGh123'));
        assert.ok(b.some((x) => x.kind === 'image' && x.src === 'https://i.ytimg.com/vi/AbCdEfGh123/hqdefault.jpg'));
    });

    await check('the form\'s thank-you/error messages, the footer and the "Made in Webflow" badge stay out', () => {
        const t = texts(page('/')).join('\n');
        for (const w of ['Thank you!', 'Oops!', 'Privacy policy', '3 Mill Lane, Little Fenwick', 'hazel-rye-footer', 'Made in Webflow', 'Hazel & Rye Bakery']) assert.ok(!t.includes(w), w);
        assert.strictEqual(texts(page('/')).at(-1), 'Hear about new bakes');
    });

    await check('the footer\'s contact details and social links are still found', () => {
        const p = page('/');
        assert.deepStrictEqual(p.contact.emails, ['hello@hazelrye.example']);
        assert.deepStrictEqual(p.contact.phones, ['01632960123']);
        assert.deepStrictEqual(p.socialLinks, ['https://www.instagram.com/hazelrye.example']);
        assert.deepStrictEqual(p.formFields, ['Your email']);
    });

    console.log('\nOther pages');

    await check('rich text: headings, list, figure and a link inside a sentence', () => {
        const p = page('/about');
        const first = p.blocks.find((b) => b.kind === 'text');
        assert.ok(first && first.kind === 'text' && first.links?.[0]?.text === 'how Gerald came to live with us' && first.links[0].href === `${SITE}/blog/gerald`);
        assert.deepStrictEqual(p.blocks.filter((b) => b.kind === 'item').map((b) => b.kind === 'item' && b.text), ['Long, slow fermentation for flavour and digestion.', 'Flour milled within forty miles of the bakery.', 'No additives, ever.']);
        assert.ok(texts(p).includes('The bakehouse just before opening.'));
    });

    await check('a lightbox gives its full picture; a resized "-p-1080" copy is put back to the original', () => {
        const imgs = page('/about').blocks.filter((b) => b.kind === 'image').map((b) => b.kind === 'image' && b.src);
        assert.ok(imgs.includes('https://cdn.prod.website-files.com/64aa00000000000000000001/64aa0000000000000000c020_shaping.jpg'));
        assert.ok(imgs.includes('https://cdn.prod.website-files.com/64aa00000000000000000001/64aa0000000000000000c021_flour.webp'));
    });

    await check('the phone layout\'s copy (w-hidden-main) is not read twice', () => {
        assert.ok(!texts(page('/about')).includes('Hazel and Rye started in a garage in 2019 with one sourdough starter called Gerald.'));
    });

    await check('a Webflow map widget becomes "See us on the map"; the contact form\'s questions are listed', () => {
        const p = page('/contact');
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'See us on the map' && b.href === 'https://www.google.com/maps?q=52.2000,0.1200'));
        assert.deepStrictEqual(p.formFields, ['Your name', 'Email address', 'What would you like to order?']);
        assert.ok(!texts(p).some((t) => /Thanks! We'll get back/.test(t)));
    });

    console.log('\nThe adapter\'s parts');

    await check('fullSizeImage: only Webflow hosts, only "-p-NNN" copies', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f('https://uploads-ssl.webflow.com/5f/5f1_photo-p-500.jpeg'), 'https://uploads-ssl.webflow.com/5f/5f1_photo.jpeg');
        assert.strictEqual(f('https://assets.website-files.com/5f/5f1_photo-p-1600.png'), 'https://assets.website-files.com/5f/5f1_photo.png');
        assert.strictEqual(f('https://cdn.prod.website-files.com/5f/5f1_photo.jpg'), null);
        assert.strictEqual(f('https://example.com/a-p-500.jpg'), null);
        assert.strictEqual(f('not a url'), null);
    });

    await check('the look: their own brand colour and fonts from the Webflow stylesheet', () => {
        const look = readImportedLook(PAGES[`${SITE}/`], `${SITE}/`, CSS);
        assert.strictEqual(look.primaryColor, '#8a4b2a');
        assert.strictEqual(look.headingFont, 'Fraunces');
        assert.strictEqual(look.font, 'editorial');
        assert.notStrictEqual(look.primaryColor, '#3898ec');   // Webflow's own default button blue
    });

    console.log('\nThe whole import');

    await check('runImport with no model: three pages read, logo copied, drop-down kept, no Webflow furniture', async () => {
        const saved: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = PAGES[url] ?? PAGES[url.replace(/\/$/, '')]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 700 + saved.length; },
            async fetchCss() { return CSS; },
        };
        const current = starterSite({ name: 'Hazel & Rye', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'webflow');
        assert.ok(r.report.pages.filter((p) => p.read).length >= 3);
        assert.ok(saved.some((s) => s.endsWith('_hazel-rye-mark.png')));
        assert.strictEqual(r.report.look?.primaryColor, '#8a4b2a');
        const all = JSON.stringify(r.definition.pages);
        for (const w of ['Bread worth getting up for', 'Two bakers and a very old oven', 'Come and say hello']) assert.ok(all.includes(w), w);
        for (const w of ['No items found', 'Thank you! Your submission', 'Oops!', 'Made in Webflow', 'embedly']) assert.ok(!all.includes(w), w);
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
