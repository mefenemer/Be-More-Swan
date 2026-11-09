// tests/site-platform-carrd.test.ts
// The Website import on Carrd one-page sites (src/utils/site-builders/carrd.ts). Synthetic pages only,
// no network, no model: tests/fixtures/site-platforms/carrd/. Report: docs/site-import-platforms/carrd.md
//
// Run:  npx tsx tests/site-platform-carrd.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
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
const root = join(__dirname, '..');
const fixture = (f: string) => readFileSync(join(root, `tests/fixtures/site-platforms/carrd/${f}.html`), 'utf8');
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const CLASSIC = { html: fixture('classic-home'), url: 'https://fernleaf.carrd.co/' };
const COMPONENT = { html: fixture('component-home'), url: 'https://mossandkettle.example/' };
const texts = (p: ReturnType<typeof readImportPage>) => p.blocks.map((b) => ('text' in b ? b.text : ''));
const current = () => starterSite({ name: 'Fernleaf Flowers', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
const deps = (html: string, url: string): ImportDeps => ({
    async fetchHtml(u) { return u === url ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
    async plan() { return null; },
    async savePicture() { return null; },
});

async function main() {
    console.log('Detection');
    await check('a free carrd.co site and a Pro site on its own domain (no credit) are both Carrd', () => {
        assert.strictEqual(found(CLASSIC.html), 'carrd');
        assert.strictEqual(found(COMPONENT.html), 'carrd');
    });
    await check('a page that merely links to carrd.co is not Carrd', () => {
        assert.strictEqual(found('<html><body><main><p>I built my first site with <a href="https://carrd.co">Carrd</a>.</p></main></body></html>'), null);
        assert.strictEqual(found('<html><head><meta property="og:image" content="https://x.example/assets/images/card.jpg"></head><body><main><p>Hand-made</p></main></body></html>'), null);
    });

    console.log('\nReading the one page');
    const classic = readImportPage(CLASSIC.html, CLASSIC.url);
    const component = readImportPage(COMPONENT.html, COMPONENT.url);

    await check('every section is read, including the ones Carrd hides until their link is clicked', () => {
        const t = texts(classic);
        for (const h of ['Fernleaf Flowers', 'About us', 'Weddings', 'Contact']) assert.ok(t.includes(h), h);
        assert.ok(t.some((x) => x.startsWith('From a single buttonhole')));
        assert.ok(texts(component).includes('What we do') && texts(component).includes('Say hello'));
    });

    await check('Carrd buttons are read as buttons with their links, not as list items', () => {
        const btn = (p: typeof classic, text: string) => p.blocks.find((b) => b.kind === 'button' && b.text === text) as { href: string | null } | undefined;
        assert.strictEqual(btn(classic, 'Visit our shop')?.href, 'https://shop.fernleaf.example/');
        assert.strictEqual(btn(component, 'Book a free call')?.href, 'https://calendar.mossandkettle.example/book');
        // A button to a section keeps its label and points at the one page (the new home page).
        assert.strictEqual(btn(classic, 'Order a bouquet')?.href, 'https://fernleaf.carrd.co/#contact');
        assert.ok(!classic.blocks.some((b) => b.kind === 'item' && /Order a bouquet|Visit our shop/.test(b.text)));
    });

    await check('icon rows: social links and email are kept, their labels and section arrows are not content', () => {
        for (const p of [classic, component]) assert.ok(!texts(p).some((x) => /^(Instagram|LinkedIn|Email|Home|Forward|Rewind)$/.test(x)), texts(p).join(' | '));
        assert.deepStrictEqual(classic.socialLinks, ['https://www.instagram.com/fernleaf.example']);
        assert.deepStrictEqual(component.socialLinks, ['https://www.linkedin.com/company/mossandkettle-example']);
    });

    await check('encoded email addresses are read: Carrd\'s percent-encoding and Cloudflare\'s protection', () => {
        assert.deepStrictEqual(classic.contact.emails, ['hello@fernleaf.example']);
        assert.deepStrictEqual(component.contact.emails, ['hello@mossandkettle.example']);
    });

    await check('the footer the owner placed is read; "Made with Carrd" is not', () => {
        assert.ok(texts(classic).includes('Studio 2, Kirkgate Yard, Ripon HG4 0XX'));
        assert.ok(!JSON.stringify(classic.blocks).includes('Made with Carrd'));
    });

    await check('deferred pictures are read at their real address, never the placeholder', () => {
        const srcs = classic.blocks.filter((b) => b.kind === 'image').map((b) => (b as { src: string }).src);
        assert.ok(srcs.includes('https://fernleaf.carrd.co/assets/images/image01.jpg?v=1a2b3c4d'));
        assert.ok(srcs.includes('https://fernleaf.carrd.co/assets/images/gallery01/4e5f6a7b.jpg?v=1a2b3c4d'));
        assert.ok(!srcs.some((s) => s.startsWith('data:')));
        assert.strictEqual(classic.logo?.alt, 'Fernleaf Flowers logo');
    });

    await check('the one-page menu of #anchors is never taken for pages to fetch', () => {
        assert.deepStrictEqual(classic.navLinks, []);
        assert.deepStrictEqual(component.navLinks, []);
    });

    console.log('\nThe whole import (no network, no model)');
    await check('both sites import as one home page with their words; nothing else is fetched', async () => {
        for (const s of [CLASSIC, COMPONENT]) {
            const r = await runImport({ url: s.url, pictures: 'skip', current: current(), maxPages: 5 }, deps(s.html, s.url));
            assert.ok(r.ok, r.ok ? '' : r.message);
            if (!r.ok) continue;
            assert.strictEqual(r.report.pages.length, 1);
            assert.strictEqual(r.report.platform, 'carrd');
            const all = JSON.stringify(r.definition.pages);
            assert.ok(all.includes(s === CLASSIC ? 'No floral foam' : 'shoeboxed receipts'));
            assert.ok(!all.includes('£450'), 'prices stay out');
        }
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
