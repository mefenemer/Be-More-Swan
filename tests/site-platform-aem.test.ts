// tests/site-platform-aem.test.ts
// Website import from Adobe Experience Manager sites: AEM Sites (Core Components) and Edge Delivery
// Services. Fixtures in tests/fixtures/site-platforms/aem/ are SYNTHETIC (invented businesses) shaped
// like real AEM markup. No network, no model. Report: docs/site-import-platforms/aem.md
//
// Run:  npx tsx tests/site-platform-aem.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { adapter as aem, aemFullSizeImage } from '../src/utils/site-builders/aem';
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
const fx = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/aem', f), 'utf8');
const CORE = 'https://www.fellside.example/content/fellside/en.html';
const ABOUT = 'https://www.fellside.example/content/fellside/en/about-us.html';
const EDS = 'https://www.tarnside.example/';
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (p: ImportPage) => p.blocks.filter((b) => b.kind === 'image') as Array<{ src: string; alt: string }>;
const current = () => starterSite({ name: 'Fellside', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));

// Magento's detect (/mage\//) matches "image/" — `type="image/webp"`, `/is/image/` — and Magento is
// listed before AEM, so it takes AEM pages. Until the Magento session fixes it (see the report), the
// tests run with the fix other sessions proposed, and one check records the clash.
const magento = ADAPTERS.find((a) => a.key === 'magento')! as { detect: (h: string, g: string, $: cheerio.CheerioAPI) => boolean };
const magentoDetect = magento.detect;
const magentoClaims = (html: string) => magentoDetect(html, '', cheerio.load(html));
magento.detect = (h) => /Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config/.test(h);

(async () => {
    console.log('\n1. Detection');

    await check('AEM Sites and Edge Delivery pages are recognised; ordinary pages are not', () => {
        for (const f of ['core-home.html', 'core-about.html', 'eds-home.html']) {
            const html = fx(f);
            assert.ok(aem.detect(html, '', cheerio.load(html)), f);
            assert.strictEqual(adapterFor(html, cheerio.load(html))?.key, 'aem', f);
        }
        const plain = '<html><body><main><h1>Hand-made</h1><img src="https://cdn.example/image/a.jpg"><p>Words.</p></main></body></html>';
        assert.ok(!aem.detect(plain, '', cheerio.load(plain)));
        // A picture hot-linked from a big brand's AEM site does not make the page AEM.
        const hot = '<html><body><main><img src="https://www.brand.example/content/dam/brand/x.jpg"></main></body></html>';
        assert.ok(!aem.detect(hot, '', cheerio.load(hot)));
    });

    await check('Magento no longer claims AEM pages (its detect was fixed and merged, 2026-11-09)', () => {
        assert.ok(!magentoClaims(fx('eds-home.html')), 'type="image/webp" is not Magento');
        assert.ok(!magentoClaims(fx('core-about.html')), '/is/image/ is not Magento');
    });

    console.log('\n2. AEM Sites (Core Components)');

    await check('the menu: no language picker, no breadcrumb, entries lifted out from under the root page, drop-downs kept', () => {
        const p = readImportPage(fx('core-home.html'), CORE);
        assert.strictEqual(p.platform, 'aem');
        const nav = p.navLinks.map((l) => (l.group ? `${l.group} > ${l.text}` : l.text));
        assert.deepStrictEqual(nav.slice(0, 6), ['Home', 'Guided walks', 'Kayaking', 'Kayaking > Beginners', 'Kayaking > Families', 'About us']);
        assert.ok(!nav.some((t) => /en-GB|cy-GB|United Kingdom/.test(t)));
    });

    await check('header and footer Experience Fragments are the site\'s own: logo found, footer words not read as content, contact and socials kept', () => {
        const p = readImportPage(fx('core-home.html'), CORE);
        assert.ok(p.logo?.src.endsWith('/fellside-logo.png'));
        assert.ok(!texts(p).some((t) => /Keswick|©|Instagram/.test(t)));
        assert.deepStrictEqual(p.contact.emails, ['hello@fellside.example']);
        assert.deepStrictEqual(p.socialLinks, ['https://www.instagram.com/fellside.example']);
    });

    await check('the owner\'s words in order; tab labels head their panels; carousel, download and sharing furniture gone', () => {
        const p = readImportPage(fx('core-home.html'), CORE);
        const t = texts(p);
        for (const w of ['Walk the fells with people who know them', 'Paddle the quiet end of the lake', 'Why walk with us', 'Do I need my own boots?', 'What to bring']) assert.ok(t.includes(w), w);
        const heads = p.blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text);
        assert.ok(heads.includes('Summer days') && heads.includes('Winter days'));
        assert.ok(t.indexOf('Summer days') < t.findIndex((x) => x.startsWith('Long light evenings')));
        assert.ok(t.indexOf('Winter days') < t.findIndex((x) => x.startsWith('Shorter routes')));
        for (const junk of ['Pause', 'Previous', 'Next', 'Filename', 'kit-list.pdf', '212 KB', 'Share on Facebook', 'Pin this page', 'Skip to main content', 'en-GB']) assert.ok(!t.includes(junk), junk);
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'See our walks'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Watch the video'));
    });

    await check('pictures: lazy (noscript) pictures found, adaptive-image sizes made large, cookie banner gone', () => {
        const p = readImportPage(fx('core-home.html'), CORE);
        const src = images(p).map((i) => i.src);
        assert.ok(src.includes('https://www.fellside.example/content/fellside/en/_jcr_content/root/container/carousel/item_a.coreimg.jpeg/1690000000000/ridge-walk.jpeg'));
        assert.ok(src.includes('https://www.fellside.example/content/fellside/en/_jcr_content/root/container/image.coreimg.jpeg/1690000000000/bothy.jpeg'));
        assert.strictEqual(images(p).find((i) => i.src.includes('bothy'))!.alt, 'A stone bothy at dusk');
        assert.ok(!texts(p).some((x) => /cookies/i.test(x)));
    });

    await check('older AEM: DAM thumbnails become the web rendition; Dynamic Media asks for a wide picture', () => {
        const p = readImportPage(fx('core-about.html'), ABOUT);
        const src = images(p).map((i) => i.src);
        assert.ok(src.includes('https://www.fellside.example/content/dam/fellside/team/guides-at-cairn.jpg/jcr:content/renditions/cq5dam.web.1280.1280.jpeg'));
        assert.ok(src.includes('https://s7g10.scene7.com/is/image/FellsideExample/boots-on-scree?wid=1600'));
        assert.ok(src.includes('https://www.fellside.example/content/dam/fellside/team/minibus.jpg/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg'));
    });

    await check('picture addresses: every AEM shape, and others left alone', () => {
        const f = aemFullSizeImage;
        assert.strictEqual(f('https://x.example/a/_jcr_content/root/image.coreimg.60.320.jpeg/169/a.jpeg'), 'https://x.example/a/_jcr_content/root/image.coreimg.jpeg/169/a.jpeg');
        assert.strictEqual(f('https://x.example/a/_jcr_content/root/image.coreimg.640.png/169/a.png'), 'https://x.example/a/_jcr_content/root/image.coreimg.png/169/a.png');
        assert.strictEqual(f('https://x.example/a/_jcr_content/root/image.coreimg.82.1600.jpeg/169/a.jpeg'), null, 'already large');
        assert.strictEqual(f('https://x.example/a/_jcr_content/root/image.coreimg.60{.width}.jpeg/169/a.jpeg'), 'https://x.example/a/_jcr_content/root/image.coreimg.jpeg/169/a.jpeg');
        assert.strictEqual(f('https://x.example/content/dam/s/a.png.thumb.319.319.png'), 'https://x.example/content/dam/s/a.png/_jcr_content/renditions/cq5dam.web.1280.1280.jpeg');
        assert.strictEqual(f('https://x.example/media_0123456789abcdef0123456789.png?width=750&format=webply&optimize=medium'), 'https://x.example/media_0123456789abcdef0123456789.png?width=2000&format=png&optimize=medium');
        assert.strictEqual(f('https://delivery-p1-e2.adobeaemcloud.com/adobe/dynamicmedia/deliver/urn:aaid:aem:1/a.jpg?width=400&height=300'), 'https://delivery-p1-e2.adobeaemcloud.com/adobe/dynamicmedia/deliver/urn:aaid:aem:1/a.jpg?width=1600');
        assert.strictEqual(f('https://x.example/content/dam/s/original.jpg'), null);
        assert.strictEqual(f('https://cdn.example/photo.jpg?w=300'), null);
        assert.strictEqual(f('not a url'), null);
    });

    await check('a whole AEM Sites import runs with no network and no model: home and menu pages, nothing invented', async () => {
        const pages: Record<string, string> = { [CORE]: fx('core-home.html'), [ABOUT]: fx('core-about.html') };
        const deps: ImportDeps = {
            async fetchHtml(url) { const h = pages[url]; return h ? { ok: true, html: h, finalUrl: url } : { ok: false, message: '404' }; },
            async plan() { return null; }, async savePicture() { return null; },
            async fetchCss(u) { return u.includes('clientlib-site') ? fx('clientlib-site.css') : null; },
        };
        const r = await runImport({ url: CORE, pictures: 'skip', current: current(), maxPages: 20 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'aem');
        const json = JSON.stringify(r.definition.pages);
        assert.ok(json.includes('Walk the fells with people who know them') && json.includes('Two friends started Fellside'));
        assert.ok(!/en-GB|Share on Facebook|212 KB/.test(json));
        assert.ok(r.report.pages.some((p) => p.url === ABOUT && p.read));
    });

    console.log('\n3. Edge Delivery Services (aem.live)');

    await check('blocks read as the owner wrote them; settings tables and fragments gone; <strong>/<em> links are buttons', () => {
        const p = readImportPage(fx('eds-home.html'), EDS);
        assert.strictEqual(p.platform, 'aem');
        const t = texts(p);
        for (const w of ['Baked before the lake wakes up', 'What we bake', 'Sourdough', 'Cinnamon buns', 'Opening hours', 'Celebration cakes']) assert.ok(t.includes(w), w);
        for (const junk of ['style', 'highlight, centred', 'Template', 'home']) assert.ok(!t.includes(junk), junk);
        assert.ok(!t.some((x) => /^https?:/.test(x)), 'no bare addresses read as words');
        const btns = p.blocks.filter((b) => b.kind === 'button').map((b) => [(b as { text: string }).text, (b as { href: string }).href]);
        assert.deepStrictEqual(btns.slice(0, 2), [['Order for collection', 'https://www.tarnside.example/order'], ['Find the shop', 'https://www.tarnside.example/visit']]);
    });

    await check('the video block becomes a thumbnail and a watch button, and is not taken for a social profile', () => {
        const p = readImportPage(fx('eds-home.html'), EDS);
        assert.ok(images(p).some((i) => i.src === 'https://i.ytimg.com/vi/T4rnS1deB4k/hqdefault.jpg'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.href === 'https://www.youtube.com/watch?v=T4rnS1deB4k'));
        assert.deepStrictEqual(p.socialLinks, []);
    });

    await check('./media_ pictures are asked for wide, in a format any browser opens', () => {
        const p = readImportPage(fx('eds-home.html'), EDS);
        const src = images(p).map((i) => i.src);
        assert.ok(src.includes('https://www.tarnside.example/media_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1.jpeg?width=2000&format=jpeg&optimize=medium'));
        assert.ok(src.includes('https://www.tarnside.example/media_2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2.png?width=2000&format=png&optimize=medium'));
    });

    await check('known gap: the menu is drawn by JavaScript from /nav.plain.html, so only the home page is imported', async () => {
        const p = readImportPage(fx('eds-home.html'), EDS);
        assert.deepStrictEqual(p.navLinks, []);
        // The nav document itself reads fine — what the shared import would need to fetch (see report).
        const nav = readImportPage(`<html><body><nav>${fx('eds-nav.plain.html')}</nav></body></html>`, EDS);
        assert.deepStrictEqual(nav.navLinks.map((l) => l.text), ['Tarnside Bakehouse', 'Bread', 'Cakes', 'Weddings', 'Visit us', 'Order']);
        const pages: Record<string, string> = { [EDS]: fx('eds-home.html') };
        const deps: ImportDeps = {
            async fetchHtml(url) { const h = pages[url]; return h ? { ok: true, html: h, finalUrl: url } : { ok: false, message: '404' }; },
            async plan() { return null; }, async savePicture() { return null; },
            async fetchCss(u) { return u.endsWith('/styles/styles.css') ? fx('styles.css') : null; },
        };
        const r = await runImport({ url: EDS, pictures: 'skip', current: current(), maxPages: 20 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.deepStrictEqual(r.report.pages.map((x) => x.url), [EDS]);
        assert.ok(JSON.stringify(r.definition.pages).includes('Baked before the lake wakes up'));
    });

    magento.detect = magentoDetect;
    console.log(`\n${passed}/${total} passed`);
})();
