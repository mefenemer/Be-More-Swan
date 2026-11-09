// tests/site-platform-wordpress.test.ts
// The Website import on WordPress sites (src/utils/site-builders/wordpress.ts): which pages it
// claims, and what "Import my current site" now reads from a block theme, a classic theme and a
// theme from before <main>. Fixtures are synthetic pages modelled on WordPress's own markup.
//
// Run:  npx tsx tests/site-platform-wordpress.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, looksLikeWordPress, readWordPressLook, wordpressFullSizeImage } from '../src/utils/site-builders/wordpress';
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
const fixture = (name: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/wordpress', `${name}.html`), 'utf8');
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => ('text' in b ? b.text : ''));
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b] : []));
const all = (p: ImportPage) => texts(p).join('\n');

const HOLLY = 'https://hollybrook.example';
const MARSH = 'https://marshlane.example';
const block = () => readImportPage(fixture('block-home'), `${HOLLY}/`);
const classic = () => readImportPage(fixture('classic-home'), `${MARSH}/`);
const contact = () => readImportPage(fixture('classic-contact'), `${MARSH}/contact/`);
const old = () => readImportPage(fixture('old-theme-about'), `${MARSH}/about/`);

async function main() {
    console.log('\nDetection');

    await check('block, classic and old themes are WordPress, with or without the generator tag', () => {
        for (const f of ['block-home', 'classic-home', 'classic-contact', 'old-theme-about']) assert.strictEqual(found(fixture(f)), 'wordpress', f);
        assert.ok(!fixture('old-theme-about').includes('name="generator"'), 'the old theme fixture has no generator tag');
        // The Mystery Shopper's saved WordPress page is built with Elementor: WordPress underneath, Elementor's adapter first.
        const strong = readFileSync(join(root, 'tests/fixtures/site-pages/wordpress-strong.html'), 'utf8');
        assert.ok(adapter.detect(strong, '', cheerio.load(strong)));
        assert.strictEqual(found(strong), 'elementor');
    });

    await check('other platforms\' saved pages are not claimed', () => {
        const dirs = ['tests/fixtures/site-import', 'tests/fixtures/site-pages'];
        for (const d of dirs) for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.html') && !x.startsWith('wordpress'))) {
            assert.notStrictEqual(found(readFileSync(join(root, d, f), 'utf8')), 'wordpress', `${d}/${f}`);
        }
        // Other platforms' fixtures, when their sessions have added them.
        const platforms = join(root, 'tests/fixtures/site-platforms');
        for (const p of readdirSync(platforms).filter((x) => !['wordpress', 'elementor', 'woocommerce'].includes(x))) {
            for (const f of readdirSync(join(platforms, p)).filter((x) => x.endsWith('.html'))) {
                assert.ok(!adapter.detect(readFileSync(join(platforms, p, f), 'utf8'), '', cheerio.load('')), `site-platforms/${p}/${f}`);
            }
        }
    });

    await check('one hot-linked WordPress picture or a link to wordpress.org is not enough', () => {
        assert.ok(!looksLikeWordPress('<html><body><main><img src="https://cms.example/wp-content/uploads/2024/01/a-300x200.jpg"><a href="https://wordpress.org/">WordPress</a></main></body></html>', ''));
        assert.ok(!looksLikeWordPress('<html><head><meta name="generator" content="Ghost 5.80"></head><body class="home-template"><main><p>Ghost</p></main></body></html>', 'ghost 5.80'));
        assert.ok(!looksLikeWordPress('<html><head><meta name="generator" content="Drupal 10"></head><body class="page-node-4"><main>x</main></body></html>', 'drupal 10'));
        // Headless WordPress behind a JavaScript front end: pictures from the CMS, nothing else.
        assert.ok(!looksLikeWordPress('<html><body><div id="__next"><img src="https://cms.example/wp-content/uploads/hero.jpg"></div><script src="/_next/static/chunks/main.js"></script></body></html>', ''));
        // Two signals without the generator tag are enough.
        assert.ok(looksLikeWordPress('<html><head><link rel="stylesheet" href="/wp-includes/css/dist/block-library/style.min.css"></head><body class="page-template-default page-id-7"></body></html>', ''));
    });

    await check('Elementor and WooCommerce sites still go to their own adapters', () => {
        assert.strictEqual(found(fixture('block-home').replace('<body class="', '<body class="elementor-kit-5 ')), 'elementor');
        assert.strictEqual(found(fixture('classic-home').replace('<body class="', '<body class="woocommerce-page ')), 'woocommerce');
        assert.strictEqual(adapter.rendersWithJs, false);
    });

    console.log('\nA block theme (Gutenberg)');

    await check('the words, headings and buttons come out in order; WordPress\'s furniture does not', () => {
        const p = block();
        assert.strictEqual(p.platform, 'wordpress');
        assert.deepStrictEqual(p.blocks.slice(1, 5).map((b) => b.kind), ['heading', 'text', 'button', 'button']);
        assert.ok(p.blocks.some((b) => b.kind === 'heading' && b.level === 1 && b.text === 'Garden rooms, built to last a lifetime'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Book a design visit' && b.href === `${HOLLY}/contact/`));
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('tidier than they found it')));
        const words = all(p);
        for (const gone of ['2 October 2024', 'News', 'Read more about Do you', 'Next Page', 'Instagram', 'Designed with', 'Skip to content']) assert.ok(!words.includes(gone), gone);
        assert.ok(words.includes('Do you need planning permission for a garden room? Most garden rooms are permitted development.'));
    });

    await check('links inside sentences are kept', () => {
        const t = block().blocks.find((b) => b.kind === 'text' && b.text.startsWith('We use'));
        assert.ok(t && t.kind === 'text');
        assert.deepStrictEqual(t.links, [{ text: 'FSC-certified Siberian larch', href: `${HOLLY}/about/#timber` }, { text: 'about page', href: `${HOLLY}/about/` }]);
    });

    await check('the menu: no site-title link, no pagination, the drop-down under the right entry', () => {
        assert.deepStrictEqual(block().navLinks.map((l) => (l.group ? `${l.group} › ${l.text}` : l.text)), ['Home', 'Garden rooms', 'Garden rooms › Studios', 'Garden rooms › Offices', 'About us', 'Contact']);
    });

    await check('pictures: the original for small resized copies, the largest from srcset, big copies kept', () => {
        const srcs = images(block()).map((i) => i.src);
        assert.ok(srcs.includes(`${HOLLY}/wp-content/uploads/2024/03/cedar-room-dusk-1536x1024.jpg`), 'largest from srcset');
        assert.ok(srcs.includes(`${HOLLY}/wp-content/uploads/2024/03/studio-interior.jpg`), '-300x200 → original');
        assert.ok(srcs.includes(`${HOLLY}/wp-content/uploads/2023/11/workshop-team-scaled.jpg`), 'WordPress\'s -scaled full size kept');
        assert.ok(srcs.includes(`${HOLLY}/wp-content/uploads/2024/01/gallery-oak-1024x683.jpg`), 'a 1024 copy is big enough');
        assert.ok(!srcs.some((s) => /-300x200/.test(s)));
        assert.strictEqual(block().logo?.src, `${HOLLY}/wp-content/uploads/2024/03/hollybrook-logo.png`);
    });

    await check('an embedded YouTube video becomes its picture and a button; social links are still found', () => {
        const p = block();
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.href === 'https://www.youtube.com/watch?v=AbCdEf12345'));
        assert.strictEqual(p.socialLinks?.length, 2);
        assert.strictEqual(p.siteName, 'Hollybrook Garden Rooms');
    });

    console.log('\nA classic theme');

    await check('lazy-loaded, Jetpack-CDN and emoji pictures are read properly', () => {
        const p = classic();
        const srcs = images(p).map((i) => i.src);
        assert.ok(srcs.includes(`${MARSH}/wp-content/uploads/2022/05/treatment-room-1024x683.jpg`), 'WP Rocket data-lazy-src');
        assert.ok(srcs.includes(`${MARSH}/wp-content/uploads/2022/06/sarah-portrait.jpg`), 'Jetpack data-orig-file');
        assert.ok(!srcs.some((s) => s.includes('s.w.org') || s.startsWith('data:')), 'no emoji or placeholder pictures');
        assert.ok(all(p).includes('a plan you can follow at home 🙂'));
    });

    await check('the site header <div> is the header: logo found, site title and tagline not content', () => {
        const p = classic();
        assert.strictEqual(p.logo?.src, `${MARSH}/wp-content/uploads/2022/05/marsh-lane-logo.png`);
        assert.ok(!all(p).includes('Helping Norwich move better'));
        assert.deepStrictEqual(p.navLinks.map((l) => l.text), ['Home', 'Treatments', 'Sports massage', 'Back pain', 'Contact']);
    });

    await check('sharing buttons, related posts, the edit link and sidebar widgets are left out', () => {
        const words = all(classic());
        for (const gone of ['Share this:', 'Facebook', 'Related', 'Edit', 'Recent Posts', 'Log in', 'Proudly powered']) assert.ok(!words.includes(gone), gone);
    });

    await check('a lazy-loaded YouTube player (WP Rocket) becomes the video\'s button', () => {
        assert.ok(classic().blocks.some((b) => b.kind === 'button' && b.href === 'https://www.youtube.com/watch?v=Zx9Yw8Vu7Ts'));
    });

    await check('contact page: the form\'s questions, the map in a paragraph, no comment box', () => {
        const p = contact();
        assert.deepStrictEqual(p.formFields, ['Your name', 'Your email', 'What would you like help with?']);
        assert.ok(p.hasForm);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'See us on the map'), 'map button');
        assert.ok(!all(p).includes('Leave a Reply') && !all(p).includes('logged in'));
        assert.deepStrictEqual(p.contact.phones, ['01603000000']);
        assert.strictEqual(p.siteName, 'Marsh Lane Physiotherapy', 'from the theme\'s site title');
    });

    console.log('\nA theme from before <main> (role="main")');

    await check('only the content area is read: no site title, post meta, comments note or sidebar', () => {
        const p = old();
        assert.deepStrictEqual(texts(p), [
            'About the clinic',
            'Marsh Lane opened in 2009 in a converted bakery. We still have the old bread oven in the waiting room.',
            'Our three physiotherapists are all chartered and registered with the Health and Care Professions Council.',
        ]);
        assert.strictEqual(p.hasForm, false, 'a search box is not an enquiry form');
    });

    await check('a picture linked to its own file is read at that size; a file name is not a description', () => {
        const [img] = images(old());
        assert.strictEqual(img.src, `${MARSH}/wp-content/uploads/2015/03/bakery-front.jpg`);
        assert.strictEqual(img.altFromSite, false);
        assert.strictEqual(img.alt, 'About the clinic');
    });

    console.log('\nPicture addresses');

    await check('resized WordPress pictures point at the original; others are left alone', () => {
        const f = wordpressFullSizeImage;
        assert.strictEqual(f('https://a.example/wp-content/uploads/2024/01/photo-300x200.jpg'), 'https://a.example/wp-content/uploads/2024/01/photo.jpg');
        assert.strictEqual(f('https://a.example/wp-content/uploads/2024/01/banner-1200x600-768x384.png'), 'https://a.example/wp-content/uploads/2024/01/banner-1200x600.png');
        assert.strictEqual(f('https://a.example/wp-content/uploads/2024/01/photo-1536x1024.jpg'), 'https://a.example/wp-content/uploads/2024/01/photo-1536x1024.jpg');
        assert.strictEqual(f('https://i0.wp.com/a.example/wp-content/uploads/2024/01/photo.jpg?resize=300%2C200&ssl=1'), 'https://i0.wp.com/a.example/wp-content/uploads/2024/01/photo.jpg?ssl=1');
        assert.strictEqual(f('https://shopname.files.wordpress.com/2020/05/cake.jpg?w=300&h=200'), 'https://shopname.files.wordpress.com/2020/05/cake.jpg');
        assert.strictEqual(f('https://a.example/images/photo-300x200.jpg'), null);
        assert.strictEqual(f('not a url'), null);
    });

    console.log('\nThe look (not wired in yet: readImportedLook is shared)');

    await check('the theme\'s own colours and fonts, never WordPress\'s default swatches', () => {
        assert.deepStrictEqual(readWordPressLook(fixture('block-home')), {
            primaryColor: '#2f6b4f', secondaryColor: '#c9a46a', textColor: '#1f2a24', backgroundColor: '#f7f4ee', headingFont: 'Fraunces', bodyFont: 'Inter',
        });
        assert.deepStrictEqual(readWordPressLook(fixture('classic-home')), {
            primaryColor: '#1d5c8c', secondaryColor: null, textColor: '#22303a', backgroundColor: '#fbfbf9', headingFont: 'Playfair Display', bodyFont: 'Lato',
        });
        const core = readWordPressLook('<style>:root{--wp--preset--color--black: #000000;--wp--preset--color--vivid-red: #cf2e2e;--wp--preset--color--white: #ffffff;}</style>');
        assert.deepStrictEqual([core.primaryColor, core.textColor, core.backgroundColor], [null, null, null]);
    });

    console.log('\nThe whole import (no network, no model)');

    await check('a classic WordPress site imports: home and contact — words in, furniture out', async () => {
        const pages: Record<string, string> = {
            [`${MARSH}/`]: fixture('classic-home'),
            [`${MARSH}/contact/`]: fixture('classic-contact'),
        };
        const saved: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 900 + saved.length; },
        };
        const current = starterSite({ name: 'Marsh Lane Physiotherapy', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${MARSH}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'wordpress');
        assert.deepStrictEqual(r.report.pages.filter((p) => p.read).map((p) => p.title), ['Home', 'Contact']);
        const json = JSON.stringify(r.definition.pages);
        assert.ok(json.includes('Physiotherapy that gets you moving again') && json.includes('Finding us'));
        for (const gone of ['Share this', 'Leave a Reply', 'Proudly powered', 'Recent Posts']) assert.ok(!json.includes(gone), gone);
        assert.strictEqual(r.report.contact.phone, '01603000000');
        assert.ok(r.report.hadForm);
        assert.ok(saved.includes(`${MARSH}/wp-content/uploads/2022/05/marsh-lane-logo.png`), 'the logo is copied');
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
