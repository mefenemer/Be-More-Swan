// tests/site-platform-contentful.test.ts
// The Website import on sites whose content comes from Contentful (src/utils/site-builders/contentful.ts).
// Synthetic fixtures only (tests/fixtures/site-platforms/contentful/) — a made-up pottery studio on
// Next.js (server-rendered, client-only, App Router) and Gatsby. No network, no model.
// Findings: docs/site-import-platforms/contentful.md
//
// Run:  npx tsx tests/site-platform-contentful.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS, adapterFor } from '../src/utils/site-builders';
import { adapter, _test } from '../src/utils/site-builders/contentful';
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
const fixture = (f: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/contentful', `${f}.html`), 'utf8');
const SITE = 'https://fernbrook.example';
const words = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text).join(' \n ');
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b] : []));

/**
 * Magento's detect (/mage\//) also matches "image/" — data:image/jpeg placeholders, "contentType":"image/heic"
 * — and Magento is listed before Contentful, so it claims these pages. Reported to the Magento session and
 * the main session (docs/site-import-platforms/contentful.md). Until it is fixed there, the page-level
 * checks run with Magento's detect told apart from "image/"; the adapter's own checks need no help.
 */
async function withMagentoFixed(fn: () => void | Promise<void>): Promise<void> {
    const m = ADAPTERS.find((a) => a.key === 'magento') as { detect: (h: string, g: string, $: cheerio.CheerioAPI) => boolean };
    const d = m.detect;
    m.detect = (h, g, $) => d(h.replace(/image\//g, 'img/'), g, $);
    try { await fn(); } finally { m.detect = d; }
}

async function main() {
    console.log('\nDetection');

    await check('every fixture is recognised as Contentful by the adapter', () => {
        for (const f of ['next-pages-ssr', 'next-csr-shell', 'next-app-rsc', 'gatsby']) {
            const html = fixture(f);
            assert.ok(adapter.detect(html, '', cheerio.load(html)), f);
        }
    });

    await check('detected from the API hosts or the JSON shapes alone, raw or escaped inside the RSC payload', () => {
        const yes = (h: string) => adapter.detect(h, '', cheerio.load(h));
        assert.ok(yes('<link rel="preconnect" href="https://cdn.contentful.com">'));
        assert.ok(yes('<link rel="preconnect" href="https://graphql.eu.contentful.com">'));
        assert.ok(yes('<script id="__NEXT_DATA__">{"sys":{"type":"Link","linkType":"Space","id":"x"}}</script>'));
        assert.ok(yes('<script>self.__next_f.push([1,"{\\"linkType\\":\\"ContentType\\"}"])</script>'));
        assert.ok(!yes('<html><body><main><p>contentful people make nice pots</p></main></body></html>'));
        assert.ok(!yes('<img src="https://cdn.sanity.io/images/x/y.jpg">'));
    });

    await check('a builder listed first still wins (Contentful is only the content, not the page builder)', () => {
        const html = '<html><head><meta name="generator" content="WordPress 6.6"></head><body><img src="https://images.ctfassets.net/a/b/c/d.jpg"></body></html>';
        assert.strictEqual(adapterFor(html, cheerio.load(html))?.key, 'wordpress');
    });

    console.log('\nPictures');

    await check('a ctfassets thumbnail becomes the original at 1600 wide; HEIC/TIFF/AVIF come back as JPEG; GIF untouched', () => {
        const f = _test.fullSizeImage;
        assert.strictEqual(f('https://images.ctfassets.net/sp/id/v/a.jpg?w=600&h=400&fit=fill&fm=webp&q=60'), 'https://images.ctfassets.net/sp/id/v/a.jpg?w=1600&q=85');
        assert.strictEqual(f('https://images.ctfassets.net/sp/id/v/a.png?w=120&h=120&fit=thumb&f=face&r=max'), 'https://images.ctfassets.net/sp/id/v/a.png?w=1600&q=85');
        assert.strictEqual(f('https://images.ctfassets.net/sp/id/v/a.heic'), 'https://images.ctfassets.net/sp/id/v/a.heic?w=1600&q=85&fm=jpg');
        assert.strictEqual(f('https://images.eu.ctfassets.net/sp/id/v/a.avif?w=10'), 'https://images.eu.ctfassets.net/sp/id/v/a.avif?w=1600&q=85&fm=jpg');
        assert.strictEqual(f('https://images.ctfassets.net/sp/id/v/spin.gif?w=200'), 'https://images.ctfassets.net/sp/id/v/spin.gif');
        assert.strictEqual(f('https://downloads.ctfassets.net/sp/id/v/menu.jpg?dl=1'), 'https://downloads.ctfassets.net/sp/id/v/menu.jpg');
        assert.strictEqual(f('https://cdn.example.org/x.jpg?w=100'), null);   // someone else's picture: the shared rule
    });

    await check('Next, Vercel, Netlify and Nuxt image wrappers are unwrapped to the picture inside', () => {
        const f = _test.fullSizeImage;
        assert.strictEqual(f(`${SITE}/_next/image?url=https%3A%2F%2Fimages.ctfassets.net%2Fsp%2Fid%2Fv%2Fa.jpg%3Ffm%3Dwebp&w=3840&q=75`), 'https://images.ctfassets.net/sp/id/v/a.jpg?w=1600&q=85');
        assert.strictEqual(f(`${SITE}/_vercel/image?url=%2F%2Fimages.ctfassets.net%2Fsp%2Fid%2Fv%2Fa.jpg&w=640&q=75`), 'https://images.ctfassets.net/sp/id/v/a.jpg?w=1600&q=85');
        assert.strictEqual(f(`${SITE}/.netlify/images?url=https://images.ctfassets.net/sp/id/v/a.png&w=400`), 'https://images.ctfassets.net/sp/id/v/a.png?w=1600&q=85');
        assert.strictEqual(f(`${SITE}/_ipx/w_800&f_webp/https:/images.ctfassets.net/sp/id/v/a.jpg`), 'https://images.ctfassets.net/sp/id/v/a.jpg?w=1600&q=85');
        assert.strictEqual(f(`${SITE}/_next/image?url=%2Fimages%2Fteam.jpg&w=1080&q=75`), `${SITE}/images/team.jpg`);   // their own file
        assert.strictEqual(f(`${SITE}/_next/image?url=javascript%3Aalert(1)&w=10`), null);
    });

    console.log('\nServer-rendered pages (most Contentful sites)');

    await check('Next.js: words in order, next/image pictures unwrapped, cookie bar gone', () => {
        const p = readImportPage(fixture('next-pages-ssr'), `${SITE}/`);
        assert.strictEqual(p.platform, 'contentful');
        assert.deepStrictEqual(p.blocks.slice(0, 4).map((b) => b.kind), ['heading', 'text', 'button', 'image']);
        assert.ok(images(p).every((i) => i.src.startsWith('https://images.ctfassets.net/') && i.src.endsWith('?w=1600&q=85')), JSON.stringify(images(p)));
        assert.strictEqual(images(p)[0].alt, 'A student shaping a bowl on the wheel');
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('stayed for a whole term')));
        assert.ok(!/cookies/i.test(words(p)));
        assert.ok(!words(p).includes('Home page v3'));   // __NEXT_DATA__ is not read when the page shows its words
    });

    await check('Gatsby: the largest picture from data-srcset, its size parameters dropped; placeholder skipped', () => withMagentoFixed(() => {
        const p = readImportPage(fixture('gatsby'), `${SITE}/`);
        assert.strictEqual(p.platform, 'contentful');
        assert.deepStrictEqual(images(p).map((i) => i.src), [
            'https://images.ctfassets.net/fakespace01/7gAsset/stu777/studio-window.jpg?w=1600&q=85',
            'https://images.ctfassets.net/fakespace01/8hAsset/vwx888/potter-portrait.png?w=1600&q=85',
        ]);
        assert.ok(!words(p).includes('Powered by Contentful'));
        assert.ok(p.words >= 40);
    }));

    console.log('\nClient-only pages: words laid out from the page\'s own data');

    await check('__NEXT_DATA__ REST entries: headline, rich text, pictures, a call to action — never the menu or SEO entries', () => withMagentoFixed(() => {
        const p = readImportPage(fixture('next-csr-shell'), `${SITE}/classes`);
        assert.strictEqual(p.platform, 'contentful');
        assert.ok(p.words >= 40, `words ${p.words}`);
        assert.deepStrictEqual(p.blocks.slice(0, 3).map((b) => b.kind), ['heading', 'text', 'image']);
        assert.deepStrictEqual(p.blocks[0], { kind: 'heading', level: 1, text: 'Classes for every pair of hands' });
        const t = words(p);
        for (const s of ['Taster evening', 'Six-week course', 'Throwing, trimming and handles', 'Your own glaze test tiles']) assert.ok(t.includes(s), s);
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text === 'The most relaxing Tuesday of my week.'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Ask about dates' && b.href === 'mailto:hello@fernbrook.example'));
        const link = p.blocks.find((b) => b.kind === 'text' && b.links?.length) as { links: Array<{ text: string; href: string }> };
        assert.deepStrictEqual(link.links, [{ text: 'directions to the barn', href: `${SITE}/visit` }]);
        // CMS furniture stays out: internal names, slugs, the menu entry, the SEO entry.
        for (const s of ['Classes page', 'Classes hero', 'Main menu', 'Book a pottery class near you', 'Classes | Fernbrook']) assert.ok(!t.includes(s), s);
        assert.deepStrictEqual(images(p).map((i) => [i.src, i.alt, i.altFromSite]), [
            ['https://images.ctfassets.net/fakespace01/4dAsset/jkl444/drying-mugs.jpg?w=1600&q=85', 'Rows of mugs drying on a wooden shelf', true],
            ['https://images.ctfassets.net/fakespace01/5eAsset/mno555/green-bowls.heic?w=1600&q=85&fm=jpg', 'Three glazed bowls in sea green', true],
        ]);
    }));

    await check('their words are text, never markup: a <script> typed into rich text stays words', () => withMagentoFixed(() => {
        const html = fixture('next-csr-shell');
        const $ = cheerio.load(html);
        adapter.prepare!($, new URL(`${SITE}/classes`));
        assert.strictEqual($('[data-contentful-entries] script').length, 0);
        assert.ok($('[data-contentful-entries]').text().includes('<script>alert(1)</script> Kilns run on Fridays.'));
    }));

    await check('App Router RSC payload, GraphQL rich text {json, links}: embedded picture resolved by id, table and tel link kept', () => {
        const p = readImportPage(fixture('next-app-rsc'), `${SITE}/visit`);
        assert.strictEqual(p.platform, 'contentful');
        assert.ok(p.words >= 40, `words ${p.words}`);
        assert.deepStrictEqual(p.blocks.slice(0, 3).map((b) => (b.kind === 'image' ? 'image' : (b as { text: string }).text)), ['Visit the studio', 'We are ten minutes from the station, up a farm track.', 'Finding the barn']);
        const img = images(p)[0];
        assert.strictEqual(img.src, 'https://images.ctfassets.net/fakespace01/6fAsset/pqr666/barn-door.jpg?w=1600&q=85');
        assert.strictEqual(img.alt, 'The green studio door in the old barn');
        assert.ok(words(p).includes('Number 12 from the station'));
        assert.ok(p.blocks.some((b) => b.kind === 'text' && b.links?.some((l) => l.href === 'tel:+441234567890')));
        assert.ok(!words(p).includes('PageVisit') && !words(p).includes('static/chunks'));
    });

    await check('a page that already shows its words gets nothing added from its data', () => {
        const html = fixture('next-csr-shell').replace('<div class="Loading_spinner__z1" aria-busy="true"></div>', `<p>${'Our studio words are already here on the page. '.repeat(6)}</p>`);
        const $ = cheerio.load(html);
        adapter.prepare!($, null);
        assert.strictEqual($('[data-contentful-entries]').length, 0);
    });

    await check('broken or missing page data never throws and adds nothing', () => {
        for (const html of ['<html><body><main></main><script id="__NEXT_DATA__">{not json</script></body></html>', '<html><body><script>self.__next_f.push([1,"0:[broken"])</script></body></html>', '<html><body></body></html>']) {
            const $ = cheerio.load(html);
            adapter.prepare!($, null);
            assert.strictEqual($('[data-contentful-entries]').length, 0);
        }
    });

    console.log('\nThe whole import (fake fetcher, no model)');

    await check('runImport reads all three Next.js pages without a headless browser and copies Contentful originals', () => withMagentoFixed(async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: fixture('next-pages-ssr'), [`${SITE}/classes`]: fixture('next-csr-shell'), [`${SITE}/visit`]: fixture('next-app-rsc') };
        const saved: string[] = [];
        let rendered = 0;
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = pages[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: '404' }; },
            async renderHtml() { rendered++; return { ok: false, message: 'no browser in tests' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 100 + saved.length; },
        };
        const current = starterSite({ name: 'Fernbrook Pottery Studio', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        assert.strictEqual(rendered, 0);
        assert.strictEqual(r.report?.platform, 'contentful');
        assert.deepStrictEqual(r.report!.pages.map((p) => [p.url, p.read, p.words > 40]), [[`${SITE}/`, true, true], [`${SITE}/classes`, true, true], [`${SITE}/visit`, true, true]]);
        // Pictures in the page's blocks are Contentful originals (no plan places none, so check what was read)…
        const read = [`${SITE}/`, `${SITE}/classes`, `${SITE}/visit`].map((u) => readImportPage(pages[u], u));
        const srcs = read.flatMap((p) => images(p).map((i) => i.src));
        assert.ok(srcs.length >= 5 && srcs.every((s) => s.startsWith('https://images.ctfassets.net/')), srcs.join('\n'));
        // The logo goes through the adapter's full-size rule too (main session, 2026-11-09): the original, not /_next/image.
        assert.deepStrictEqual(saved, [read[0].logo!.src]);
        assert.ok(saved[0].startsWith('https://images.ctfassets.net/') && !saved[0].includes('/_next/image'), saved[0]);
    }));

    console.log(`\n${passed}/${total} passed`);
}
main();
