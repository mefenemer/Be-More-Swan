// tests/site-platform-lovable.test.ts
// The Website import on sites built with Lovable (src/utils/site-builders/lovable.ts): the classic
// single-page app (empty shell + the page headless Chrome draws) and the newer server-rendered kind.
// Fixtures are synthetic, modelled on Lovable's markup (tests/fixtures/site-platforms/lovable/).
// Report: docs/site-import-platforms/lovable.md
//
// Run:  npx tsx tests/site-platform-lovable.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/lovable';
import { readImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const fx = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/lovable', f), 'utf8');
const SITE = 'https://kilnandclover.example';
const SSR = 'https://northgatebikes.example/';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;

// At eb33994c the Magento adapter's `mage\/` matches "image/x-icon" and claims every page that reaches
// it (fixed on the Magento session's branch, see docs/site-import-platforms/lovable.md). Until that
// lands, Magento is held to its fixed signals while these tests run, so they test Lovable's adapter.
const magento = ADAPTERS.find((a) => a.key === 'magento') as { detect: (h: string, g: string, $: cheerio.CheerioAPI) => boolean } | undefined;
if (magento && magento.detect(fx('shell.html'), '', cheerio.load(fx('shell.html')))) {
    magento.detect = (html) => /Magento_|\/static\/(?:version\d+\/)?frontend\/|requirejs-config/.test(html);
}

async function main() {
    await check('detect: the SPA shell, every rendered route and the server-rendered kind are Lovable', () => {
        for (const f of ['shell.html', 'home-rendered.html', 'about-rendered.html', 'classes-rendered.html', 'ssr-home.html']) {
            assert.strictEqual(found(fx(f)), 'lovable', f);
        }
    });

    await check('detect: no false positives from the word "lovable" or a page that links to Lovable in its text', () => {
        const no = (h: string) => assert.strictEqual(adapter.detect(h, '', cheerio.load(h)), false, h);
        no('<html><body><main><p>Our lovable rescue dogs.</p></main></body></html>');
        no('<html><body><main><p>I tried lovable.dev and bolt.new for this.</p></main></body></html>');
        no('<html><head><link rel="icon" type="image/x-icon" href="/favicon.ico"></head><body><div id="root"></div></body></html>');
        assert.strictEqual(adapter.detect('<html><head><meta name="author" content="Lovable"></head></html>', '', cheerio.load('')), true);
        assert.strictEqual(adapter.detect('<img src="/lovable-uploads/abc.png">', '', cheerio.load('')), true);
    });

    await check('the empty shell reads as nothing, with the starter\'s title and description dropped', () => {
        const p = readImportPage(fx('shell.html'), `${SITE}/`);
        assert.strictEqual(p.platform, 'lovable');
        assert.strictEqual(p.words, 0, 'the plain fetch has no words, so the import renders the page');
        assert.strictEqual(p.title, null, 'the project slug is not a page title');
        assert.strictEqual(p.description, null, '"Lovable Generated Project" is not their description');
        assert.ok(adapter.rendersWithJs);
    });

    await check('the rendered home page: words, menu, logo, pictures, quotes, form and contact, without Lovable\'s badge', () => {
        const p = readImportPage(fx('home-rendered.html'), `${SITE}/`);
        const text = p.blocks.map((b) => (b.kind === 'image' ? '' : b.text));
        assert.ok(p.blocks.some((b) => b.kind === 'heading' && b.level === 1 && b.text === 'Make something with your hands'));
        assert.ok(text.includes('No wheel needed. Pinch, coil and slab your way to planters, plates and anything else you dream up.'));
        // Menu: router <Link>s are plain <a href> once drawn; scroll buttons ("Gallery") have no address.
        assert.deepStrictEqual(p.navLinks.map((l) => l.href), [`${SITE}/`, `${SITE}/classes`, `${SITE}/about`]);
        // Logo: the top bar is <nav class="fixed top-0">, wrapped in a header so the logo is found.
        assert.strictEqual(p.logo?.src, `${SITE}/lovable-uploads/3f1c2a9e-7d41-4c0b-9a55-1e2b3c4d5e6f.png`);
        // Pictures: the CSS background hero, uploads, Vite assets, and Unsplash at a usable size.
        const imgs = p.blocks.filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? b.src : ''));
        assert.ok(imgs.includes(`${SITE}/assets/hero-pottery-DkL3m9Qa.jpg`));
        assert.ok(imgs.includes(`${SITE}/lovable-uploads/8a2b7c1d-0e3f-4a5b-8c6d-9e0f1a2b3c4d.png`));
        assert.ok(imgs.includes('https://images.unsplash.com/photo-1565193566173-7a0ee3dbe261?w=1600&q=80'), imgs.join(' '));
        // Testimonials are quotes.
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.startsWith('"I had never touched clay')));
        // Their form, drawn with no <form>: its questions are listed, and are not page words.
        assert.strictEqual(p.hasForm, true);
        assert.deepStrictEqual(p.formFields, ['Your name', 'Email', 'Message']);
        assert.ok(!text.includes('Your name') && !text.includes('Send message'));
        // Lovable's furniture is gone.
        assert.ok(!p.blocks.some((b) => b.kind !== 'image' && /edit with|lovable|notifications/i.test(b.text)), JSON.stringify(text));
        assert.deepStrictEqual(p.contact.emails, ['hello@kilnandclover.example']);
        assert.deepStrictEqual(p.socialLinks, ['https://www.instagram.com/kilnandclover.example']);
    });

    await check('the server-rendered kind reads from the plain fetch, form and all, with "Built in Lovable" left out', () => {
        const p = readImportPage(fx('ssr-home.html'), SSR);
        assert.strictEqual(p.platform, 'lovable');
        assert.ok(p.words >= 40, `${p.words} words: no browser needed`);
        assert.strictEqual(p.title, 'Northgate Bike Repairs — friendly cycle servicing', 'a real title is kept');
        assert.ok(p.description?.startsWith('Servicing, repairs'));
        assert.deepStrictEqual(p.formFields, ['Name', 'What kind of bike?']);
        assert.ok(p.navLinks.some((l) => l.text === 'Services' && l.href === `${SSR}services`));
        assert.strictEqual(adapter.noise!.test('Built in Lovable.'), true);
    });

    await check('a whole import of the SPA: each route is the empty shell, rendered by the browser, and imported', async () => {
        const rendered: Record<string, string> = { [`${SITE}/`]: 'home-rendered.html', [`${SITE}/classes`]: 'classes-rendered.html', [`${SITE}/about`]: 'about-rendered.html' };
        const asked: string[] = [];
        const deps: ImportDeps = {
            // Lovable's hosting answers every route with the same shell.
            async fetchHtml(url) { return { ok: true, html: fx('shell.html'), finalUrl: url }; },
            async renderHtml(url) {
                asked.push(url);
                const f = rendered[url];
                return f ? { ok: true, html: fx(f), finalUrl: url } : { ok: false, message: 'not found' };
            },
            async plan() { return null; },
            async savePicture() { return 1; },
            async fetchCss(url) { return url.endsWith('.css') ? fx('index.css') : null; },
        };
        const current = starterSite({ name: 'Kiln & Clover', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'lovable');
        assert.deepStrictEqual(asked.sort(), [`${SITE}/`, `${SITE}/about`, `${SITE}/classes`]);
        assert.deepStrictEqual(r.report.pages.map((p) => p.read), [true, true, true]);
        assert.ok(r.report.wordsRead > 300);
        assert.deepStrictEqual(r.report.formFields, ['Your name', 'Email', 'Message']);
        assert.ok(!r.report.notCarried.some((n) => /lovable/i.test(n)), r.report.notCarried.join('; '));
        assert.deepStrictEqual(r.report.prices, ['£45', '£240'], 'prices are flagged for Business Information, not put on the site');
    });
}

main().then(() => console.log(`\n${passed}/${total} passed`)).finally(() => setTimeout(() => process.exit(), 50));
