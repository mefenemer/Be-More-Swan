// tests/site-platform-joomla.test.ts
// The Website import on Joomla sites (src/utils/site-builders/joomla.ts): Cassiopeia (Joomla 4/5's
// default template), Helix Ultimate and YOOtheme Pro. Saved SYNTHETIC pages only — no network, no model:
// tests/fixtures/site-platforms/joomla/. Report: docs/site-import-platforms/joomla.md
//
// Run:  npx tsx tests/site-platform-joomla.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { adapter as joomla } from '../src/utils/site-builders/joomla';
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
const fixture = (f: string) => readFileSync(join(root, `tests/fixtures/site-platforms/joomla/${f}.html`), 'utf8');
const BAKERY = 'https://dale-end.example';
const PAGES = {
    home: [fixture('cassiopeia-home'), `${BAKERY}/`],
    article: [fixture('cassiopeia-article'), `${BAKERY}/index.php/about-us`],
    helix: [fixture('helix-home'), 'https://riverside-joinery.example/'],
    yoo: [fixture('yootheme-home'), 'https://hartley-physio.example/'],
} as const;

// An adapter listed before Joomla that claims a Joomla page is a bug in THAT adapter (found: Magento's
// `mage\/` matches "image/webp", 2026-11-08). Reported, then set aside here so this file tests Joomla's reading.
const joomlaAt = ADAPTERS.findIndex((a) => a.key === 'joomla');
const claimants = (html: string) => ADAPTERS.slice(0, joomlaAt).filter((a) => { try { return a.detect(html, (cheerio.load(html)('meta[name="generator"]').attr('content') ?? '').toLowerCase(), cheerio.load(html)); } catch { return false; } });
function asJoomla<T>(html: string, fn: () => T): T {
    const wrong = claimants(html) as Array<{ detect: unknown }>;
    const saved = wrong.map((a) => a.detect);
    wrong.forEach((a) => { a.detect = () => false; });
    try { return fn(); } finally { wrong.forEach((a, i) => { a.detect = saved[i]; }); }
}
const read = (key: keyof typeof PAGES): ImportPage => { const [html, url] = PAGES[key]; return asJoomla(html, () => readImportPage(html, url)); };
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (p: ImportPage) => p.blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);
const all = (p: ImportPage) => texts(p).join('\n');

async function main() {
    console.log('\nDetection');

    await check('Joomla pages are recognised: generator tag, and without it by Joomla\'s own script and media paths', () => {
        const gen = (h: string) => (cheerio.load(h)('meta[name="generator"]').attr('content') ?? '').toLowerCase();
        for (const key of Object.keys(PAGES) as Array<keyof typeof PAGES>) {
            const html = PAGES[key][0];
            assert.ok(joomla.detect(html, gen(html), cheerio.load(html)), key);
        }
        assert.ok(!PAGES.yoo[0].includes('name="generator"'), 'the YOOtheme page has no generator tag');
        assert.ok(!joomla.detect('<html><body><main><img src="/images/a.jpg"><p>Hand-made page</p></main></body></html>', '', cheerio.load('')));
        assert.strictEqual(adapterFor(PAGES.home[0], cheerio.load(PAGES.home[0]))?.key, 'joomla');
        assert.strictEqual(adapterFor(PAGES.helix[0], cheerio.load(PAGES.helix[0]))?.key, 'joomla');
    });

    await check('(known clash, reported) any adapter before Joomla that claims a Joomla page is listed here', () => {
        const wrong = (Object.keys(PAGES) as Array<keyof typeof PAGES>).flatMap((k) => claimants(PAGES[k][0]).map((a) => `${k}→${a.key}`));
        if (wrong.length) console.log(`    note: claimed by an earlier adapter: ${wrong.join(', ')} (see docs/site-import-platforms/joomla.md, Detection)`);
        assert.ok(wrong.every((w) => w.endsWith('→magento')), `an unexpected adapter claims a Joomla page: ${wrong.join(', ')}`);
    });

    console.log('\nCassiopeia (Joomla 4/5)');

    await check('the home page\'s module positions outside <main> are read: banner, top-a, sidebar, bottom-a, in page order', () => {
        const p = read('home');
        const t = texts(p);
        const at = (s: string) => t.findIndex((x) => x.includes(s));
        for (const s of ['Bread worth getting up early for', 'Why people come back', 'Every loaf is proved', 'Our story', 'Opening hours', 'Tuesday to Saturday', 'Find the shop'])
            assert.ok(at(s) >= 0, s);
        assert.ok(at('Bread worth') < at('Why people') && at('Why people') < at('Our story') && at('Our story') < at('Opening hours') && at('Opening hours') < at('Find the shop'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Order a cake'));
    });

    await check('Joomla\'s own lines are never read as the owner\'s words: article details, login, latest articles, search, footer licence', () => {
        const words = all(read('home')) + all(read('article'));
        for (const bad of ['Written by', 'Super User', 'Category:', 'Published:', 'Hits:', 'Details', 'Last Updated', 'Parent Category', 'Latest Articles', 'Most Read', 'Login Form', 'Forgot your', 'Username', 'You are here', 'Prev', 'Previous article', 'Free Software', 'Back to Top', 'Bread\n'])
            assert.ok(!words.includes(bad), bad);
        assert.ok(!texts(read('article')).includes('Bread'), 'the article\'s tag');
    });

    await check('"Read more: Our story" and "Read more …" become one plain "Read more" button to the article', () => {
        const buttons = read('home').blocks.filter((b) => b.kind === 'button') as Array<{ text: string; href: string | null }>;
        const more = buttons.filter((b) => /read more/i.test(b.text));
        assert.deepStrictEqual(more.map((b) => [b.text, b.href]), [['Read more', `${BAKERY}/index.php/about-us`], ['Read more', `${BAKERY}/index.php/cakes`]]);
    });

    await check('pictures: the media field\'s #joomlaImage note is dropped, a relative editor picture is found under the site root, the banner background is read', () => {
        const home = images(read('home'));
        assert.deepStrictEqual(home, [`${BAKERY}/images/headers/oven-door.jpg`, `${BAKERY}/images/articles/first-loaf.jpg`, `${BAKERY}/images/shop/blue-door.jpg`]);
        const art = images(read('article'));
        assert.deepStrictEqual(art, [`${BAKERY}/images/articles/two-bakers.jpg`, `${BAKERY}/images/articles/sourdough-starter.jpg`]);
        assert.ok(!art.some((s) => s.includes('/index.php/')));
        assert.strictEqual(joomla.fullSizeImage!(`${BAKERY}/images/a.jpg#joomlaImage://local-images/a.jpg?width=10&height=10`), `${BAKERY}/images/a.jpg`);
        assert.strictEqual(joomla.fullSizeImage!(`${BAKERY}/images/a.jpg`), null);
    });

    await check('a cloaked e-mail (Joomla 4/5 <joomla-hidden-mail>) becomes the address, in the words and the site\'s details', () => {
        const p = read('article');
        assert.deepStrictEqual(p.contact.emails, ['hello@dale-end.example']);
        assert.ok(all(p).includes('Contact us by email: hello@dale-end.example'));
        assert.ok(!all(p).includes('spambots'));
        const block = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Contact us by email')) as { links?: Array<{ href: string }> };
        assert.strictEqual(block.links?.[0].href, 'mailto:hello@dale-end.example');
    });

    await check('the menu: mod_menu items in order, the sub-menu under its parent, the logo\'s link not a menu entry, logo kept', () => {
        const p = read('home');
        assert.deepStrictEqual(p.navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['About us', null], ['Our bakers', 'About us'], ['Celebration cakes', null], ['Contact', null]]);
        assert.strictEqual(p.logo?.src, `${BAKERY}/images/branding/dale-end-logo.png`);
        assert.deepStrictEqual(read('article').navLinks.map((l) => l.text), ['Home', 'About us', 'Our bakers', 'Contact']);
        assert.deepStrictEqual(read('home').socialLinks, ['https://www.instagram.com/dale.end.bakery.example']);
    });

    console.log('\nHelix Ultimate');

    await check('the hero section and bottom module outside <main> are read; sidebar search and popular posts are not', () => {
        const p = read('helix');
        const t = all(p);
        for (const s of ['Kitchens and staircases, made by hand by the river', 'Three joiners', 'Every kitchen we build', 'Visit the workshop', 'Unit 4, Mill Lane'])
            assert.ok(t.includes(s), s);
        for (const bad of ['Popular Posts', 'Search', 'Admin', '12 May 2023', 'Mon - Fri', 'Close', 'Scroll Up', 'Designed by'])
            assert.ok(!t.includes(bad), bad);
        assert.deepStrictEqual(images(p), ['https://riverside-joinery.example/images/hero/workshop.jpg', 'https://riverside-joinery.example/images/work/oak-kitchen.jpg']);
    });

    await check('a Joomla 3 cloaked e-mail (script) is decoded; the top bar\'s phone and social icons still reach the site\'s details', () => {
        const p = read('helix');
        assert.deepStrictEqual(p.contact.emails, ['workshop@riverside-joinery.example']);
        assert.ok(all(p).includes('or write to workshop@riverside-joinery.example.'));
        assert.deepStrictEqual(p.contact.phones, ['01632960123']);
        assert.deepStrictEqual(p.socialLinks, ['https://www.facebook.com/riverside.joinery.example']);
    });

    await check('Helix\'s drop-down box (sp-dropdown) is read as a sub-menu of its parent', () => {
        assert.deepStrictEqual(read('helix').navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Our work', null], ['Kitchens', 'Our work'], ['Staircases', 'Our work'], ['Contact us', null]]);
    });

    console.log('\nYOOtheme Pro');

    await check('builder sections are read, and the lazy section background (data-src + uk-img) becomes a picture', () => {
        const p = read('yoo');
        assert.strictEqual(p.platform, 'joomla');
        assert.ok(all(p).includes('Back to doing what you love') && all(p).includes('Running injuries'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Book an assessment'));
        assert.deepStrictEqual(images(p), ['https://hartley-physio.example/images/clinic/treatment-room.jpg', 'https://hartley-physio.example/templates/yootheme/cache/9e/clinician-9e8d7c6b.jpeg']);
    });

    await check('UIkit\'s navbar drop-down is a sub-menu in menu order (the mobile off-canvas copy is dropped); "Back to home" (the logo) is not a menu entry', () => {
        assert.deepStrictEqual(read('yoo').navLinks.map((l) => [l.text, l.group ?? null]), [['Home', null], ['Treatments', null], ['Sports massage', 'Treatments'], ['Contact', null]]);
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport on the Cassiopeia site: every page read, every owner word lands, no Joomla furniture, pictures copied from the right addresses', async () => {
        const pages: Record<string, string> = {
            [`${BAKERY}/`]: PAGES.home[0],
            [`${BAKERY}/index.php/about-us`]: PAGES.article[0],
        };
        const saved: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 700 + saved.length; },
        };
        const current = starterSite({ name: 'Dale End Bakery', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await asJoomla(PAGES.home[0], () => runImport({ url: `${BAKERY}/`, pictures: 'copy', current, maxPages: 5 }, deps));
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        const out = JSON.stringify(r.definition.pages);
        for (const s of ['Bread worth getting up early for', 'Every loaf is proved for at least eighteen hours.', 'Tuesday to Saturday, 7am until we sell out.', 'We are the blue door opposite the market cross.', 'Dale End Bakery opened in 1998'])
            assert.ok(out.includes(s), s);
        for (const bad of ['Written by', 'Hits:', 'Latest Articles', 'Login Form', 'spambots', 'joomlaImage'])
            assert.ok(!out.includes(bad), bad);
        assert.ok(r.report.pages.filter((p) => p.read).length >= 2);
        assert.strictEqual(r.definition.settings.email, 'hello@dale-end.example');
        assert.ok(saved.every((s) => !s.includes('#') && !s.includes('/index.php/images/')), saved.join(' '));
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
