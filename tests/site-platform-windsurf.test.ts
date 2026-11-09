// tests/site-platform-windsurf.test.ts
// Website import of sites made with Windsurf (AI code editor; App Deploys → Netlify, <name>.windsurf.build).
// Fixtures are SYNTHETIC (tests/fixtures/site-platforms/windsurf/README.md). No network, no model.
//
// Run:  npx tsx tests/site-platform-windsurf.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapter } from '../src/utils/site-builders/windsurf';
import { adapterFor } from '../src/utils/site-builders';
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
const fixture = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/windsurf', `${f}.html`), 'utf8');
const detects = (html: string) => adapter.detect(html, '', cheerio.load(html));
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const SITE = 'https://pebble-fern.windsurf.build';

(async () => {
    await check('detects a page whose own address or files are on *.windsurf.build', () => {
        for (const f of ['vite-shell', 'vite-rendered', 'next-export', 'static-html']) assert.ok(detects(fixture(f)), f);
        assert.strictEqual(found(fixture('next-export')), 'windsurf');
        assert.strictEqual(found(fixture('static-html')), 'windsurf');
    });

    await check('a page that talks about Windsurf or links to a *.windsurf.build demo is not a Windsurf site', () => {
        assert.ok(!detects(fixture('mentions-windsurf')));
        assert.notStrictEqual(found(fixture('mentions-windsurf')), 'windsurf');
        assert.ok(!detects('<html><body><p>Built with Windsurf by Codeium</p><a href="https://demo.windsurf.build/">demo</a></body></html>'));
        assert.ok(!detects('<html><head><link rel="canonical" href="https://windsurf.build.evil.example/"></head><body></body></html>'));
    });

    await check('the plain Vite shell names no host, so it cannot be told apart (known gap: detect never sees the address)', () => {
        assert.ok(!detects(fixture('vite-shell-bare')));
    });

    await check('Next.js /_next/image pictures are read at their original address, not the resized copy', () => {
        const page = readImportPage(fixture('next-export'), 'https://northgate-bikes.windsurf.build/');
        assert.strictEqual(page.platform, 'windsurf');
        const imgs = page.blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);
        assert.deepStrictEqual(imgs, ['https://northgate-bikes.windsurf.build/images/workshop.jpg', 'https://cdn.northgate-bikes.example/rack.jpg']);
        assert.strictEqual(adapter.fullSizeImage!('https://x.windsurf.build/_next/image?url=javascript%3Aalert(1)&w=64'), null);
        assert.strictEqual(adapter.fullSizeImage!('https://x.windsurf.build/images/a.jpg'), null);
    });

    await check('Next.js export: words, list, button and menu are read from the plain HTML', () => {
        const page = readImportPage(fixture('next-export'), 'https://northgate-bikes.windsurf.build/');
        assert.ok(page.words >= 40);
        assert.deepStrictEqual(page.navLinks.map((l) => l.text), ['Home', 'Services', 'Contact']);
        assert.ok(page.blocks.some((b) => b.kind === 'button' && b.text === 'Book a service'));
        assert.strictEqual(page.blocks.filter((b) => b.kind === 'item').length, 3);
        assert.deepStrictEqual(page.contact.phones, ['+441234000000']);
    });

    await check('one-page HTML: sections, list and Tailwind-classed button are read; #anchor menu adds no pages', () => {
        const page = readImportPage(fixture('static-html'), 'https://willow-lane.windsurf.build/');
        assert.ok(page.words >= 60);
        assert.deepStrictEqual(page.navLinks, []);
        assert.ok(page.blocks.some((b) => b.kind === 'heading' && b.text === 'Happy dogs, tired legs'));
        assert.ok(page.blocks.some((b) => b.kind === 'image' && b.src === 'https://willow-lane.windsurf.build/images/walk.jpg'));
    });

    await check('Vite shell reads as empty; the rendered page keeps words, hidden-by-animation heading, bg-[url()] hero and quote', () => {
        assert.strictEqual(readImportPage(fixture('vite-shell'), `${SITE}/`).words, 0);
        const page = readImportPage(fixture('vite-rendered'), `${SITE}/`);
        assert.strictEqual(page.platform, 'windsurf');
        assert.ok(page.blocks.some((b) => b.kind === 'heading' && b.text === 'What we teach'));
        assert.ok(page.blocks.some((b) => b.kind === 'image' && b.src === `${SITE}/images/studio-hero.jpg`));
        assert.ok(page.blocks.some((b) => b.kind === 'quote'));
        assert.strictEqual(page.logo?.src, `${SITE}/logo.png`);
        assert.deepStrictEqual(page.contact.emails, ['hello@pebble-fern.example']);
        assert.ok(adapter.rendersWithJs);
    });

    await check('runImport: an SPA on *.windsurf.build is drawn in the browser and imported (fake deps, no plan)', async () => {
        const rendered: string[] = [];
        const deps: ImportDeps = {
            fetchHtml: async (u) => ({ ok: true, html: fixture('vite-shell'), finalUrl: u }),
            renderHtml: async (u) => { rendered.push(u); return { ok: true, html: fixture('vite-rendered'), finalUrl: u }; },
            plan: async () => null,
            savePicture: async () => null,
        };
        const current = starterSite({ name: 'Pebble & Fern', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        assert.strictEqual(r.report.platform, 'windsurf');
        assert.ok(rendered.includes(`${SITE}/`) && rendered.includes(`${SITE}/classes`));
        assert.ok(r.report.wordsRead >= 100);
    });

    console.log(`\n${passed}/${total} passed`);
})();
