// tests/site-platform-v0.test.ts
// Website import of sites built with v0 (Vercel's AI builder): src/utils/site-builders/v0.ts.
// Synthetic fixtures modelled on v0's Next.js App Router markup: tests/fixtures/site-platforms/v0/
// (a fictional bakery — no real business's words or pictures). No network, no model.
//
// Run:  npx tsx tests/site-platform-v0.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter, readFlight, unwrapNextImage } from '../src/utils/site-builders/v0';
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
const fx = (f: string) => readFileSync(join(__dirname, 'fixtures/site-platforms/v0', `${f}.html`), 'utf8');
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ReturnType<typeof readImportPage>) => p.blocks.map((b) => ('text' in b ? b.text : b.src));
const HOME = 'https://hearthandcrumb.example/';

(async () => {
    console.log('Detection');

    await check('v0\'s generator tag (v0.app, and the older v0.dev) says v0', () => {
        assert.strictEqual(found(fx('home')), 'v0');
        assert.strictEqual(found('<html><head><meta name="generator" content="v0.dev"/></head><body><main>x</main></body></html>'), 'v0');
    });

    await check('without the tag, a Next.js page with v0\'s own fingerprints is still v0', () => {
        assert.strictEqual(found(fx('shell')), 'v0');   // v0-*.vercel.app address
        const next = '<script src="/_next/static/chunks/main-app-1.js"></script>';
        assert.strictEqual(found(`<html><head>${next}</head><body><main><img src="/placeholder.svg?height=400&width=600"></main></body></html>`), 'v0');
        assert.strictEqual(found(`<html><head>${next}</head><body><main>x</main><a href="https://v0.app/chat/api/open/built-with-v0/b_1">Built with v0</a></body></html>`), 'v0');
    });

    await check('a plain Next.js site, or any page that only links to v0.app, is not v0', () => {
        assert.strictEqual(found(fx('nextjs-plain')), null);
        assert.strictEqual(found('<html><body><main><p>We love <a href="https://v0.app">v0.app</a> and v0.dev.</p></main></body></html>'), null);
        // v0's fingerprints without Next.js markup (a blog post quoting them) are not enough either
        assert.strictEqual(found('<html><body><main><p>v0 uses /placeholder.svg?height=400 and v0-demo.vercel.app</p></main></body></html>'), null);
    });

    console.log('\nReading a v0 page');
    const home = readImportPage(fx('home'), HOME);
    const words = texts(home);

    await check('the page is read by the v0 adapter, server-rendered words in order', () => {
        assert.strictEqual(home.platform, 'v0');
        assert.strictEqual(home.blocks[0].kind, 'heading');
        assert.ok(words.includes('We are a family bakery on Fossgate, baking slow-proved sourdough, pastries and celebration cakes since 2009.'));
        assert.deepStrictEqual(home.navLinks.map((l) => l.text), ['Hearth & Crumb', 'About', 'Contact']);
        assert.ok(home.hasForm && home.formFields?.includes('Email'));
        assert.deepStrictEqual(home.contact.emails, ['hello@hearthandcrumb.example']);
    });

    await check('closed accordion answers come back from the RSC payload, under their questions', () => {
        const q = words.indexOf('Do you bake gluten-free bread?');
        assert.ok(q >= 0);
        assert.strictEqual(words[q + 1], 'Yes. Our gluten-free loaves are baked first thing on Tuesdays and Fridays in a separate oven.');
        assert.ok(words.includes('We need five days\' notice for celebration cakes. Pop in or send us a message with the date and the flavour you would like.'));
    });

    await check('an inactive tab\'s words come back too (the active one is not doubled)', () => {
        assert.ok(words.includes('Butter croissants, cardamom buns and seasonal fruit danishes from seven each morning.'));
        assert.strictEqual(words.filter((w) => w.startsWith('Sourdough, seeded rye')).length, 1);
    });

    await check('streamed (Suspense) content is read where it belongs, and its "Loading…" stand-in is not', () => {
        const at = words.indexOf('Kind words');
        assert.deepStrictEqual(home.blocks.slice(at + 1, at + 3).map((b) => b.kind), ['quote', 'quote']);
        assert.ok(!words.some((w) => /loading/i.test(w)));
    });

    await check('next/image pictures are read as the picture itself; v0\'s placeholders are left out', () => {
        const pics = home.blocks.filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? b.src : ''));
        assert.deepStrictEqual(pics, [
            'https://hearthandcrumb.example/images/bakery-window.jpg',
            'https://synthstore01.public.blob.vercel-storage.com/sourdough-Xy12ab.jpg',
        ]);
        assert.strictEqual(home.logo?.src, 'https://hearthandcrumb.example/logo.png');
    });

    await check('v0\'s badge and the router\'s 404 page never become words', () => {
        const all = words.join(' ');
        assert.ok(!/built with v0|could not be found|404/i.test(all));
    });

    await check('a page whose HTML is only a loading shell is read from its RSC payload', () => {
        const p = readImportPage(fx('shell'), 'https://v0-example-bakery.vercel.app/about');
        const t = texts(p);
        assert.ok(p.words >= 80, `read ${p.words} words`);
        assert.strictEqual(t[0], 'Our story');
        assert.ok(t.includes('Hearth & Crumb began in 2009 when two sisters swapped their office jobs for a second-hand oven and a lease on Fossgate.'));
        assert.ok(t.some((x) => x.startsWith('Today we are a team of nine.')), 'long text row (T…) read');
        assert.ok(t.includes('Flour from mills within sixty miles of the shop.'));
        assert.ok(t.includes('$-signs are kept as written: the $$ in this line is the owner\'s.'), '"$$" unescaped once');
        assert.ok(t.includes('https://synthstore01.public.blob.vercel-storage.com/sisters-at-oven-Ab34cd.jpg'));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Visit the shop' && b.href === 'https://v0-example-bakery.vercel.app/contact'));
        assert.ok(!t.some((x) => /loading|could not be found|^404$|not words|^icon$/i.test(x)));
    });

    console.log('\nPieces');

    await check('unwrapNextImage: relative and absolute inner addresses, and anything else left alone', () => {
        assert.strictEqual(unwrapNextImage('https://a.example/_next/image?url=%2Fx.jpg&w=640&q=75'), 'https://a.example/x.jpg');
        assert.strictEqual(unwrapNextImage('/_next/image?url=https%3A%2F%2Fcdn.example%2Fy.webp&w=1920&q=75', new URL('https://a.example/p')), 'https://cdn.example/y.webp');
        assert.strictEqual(unwrapNextImage('https://a.example/images/x.jpg'), null);
        assert.strictEqual(unwrapNextImage('https://a.example/_next/image?url=javascript%3Aalert(1)'), null);
        assert.strictEqual(adapter.fullSizeImage!('https://a.example/photo.jpg'), null);
    });

    await check('readFlight: rows from several pushes, length-prefixed text in UTF-8 bytes, junk skipped', () => {
        const text = 'Crème brûlée — every Friday';
        const n = Buffer.byteLength(text, 'utf8').toString(16);
        const p = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
        const rows = readFlight(p('1:I[1,[],""]\n0:["$","p",nu') + p(`ll,{"children":"$2"}]\n2:T${n},${text}3:"after"\n`) + p('not a row\n'))!;
        assert.deepStrictEqual(rows.get('0'), ['$', 'p', null, { children: '$2' }]);
        assert.strictEqual(rows.get('2'), text);
        assert.strictEqual(rows.get('3'), 'after');
        assert.strictEqual(readFlight('<html><body>no payload</body></html>'), null);
    });

    await check('a broken payload never stops the plain read', () => {
        const html = fx('home').replace(/self\.__next_f\.push\(\[1,"/g, 'self.__next_f.push([1,"\\u0000{{{');
        const p = readImportPage(html, HOME);
        assert.strictEqual(p.platform, 'v0');
        assert.ok(texts(p).includes('Questions we are often asked'));
    });

    console.log('\nThe whole import (no network, no model)');

    await check('runImport: the v0 home and an RSC-only page both land, pictures unwrapped, platform reported', async () => {
        const pages: Record<string, string> = { [HOME]: fx('home'), [`${HOME}about`]: fx('shell') };
        const saved: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(u) { const h = pages[u]; return h ? { ok: true, html: h, finalUrl: u } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; },
            async savePicture(src) { saved.push(src); return 700 + saved.length; },
        };
        const current = starterSite({ name: 'Hearth & Crumb', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));
        const r = await runImport({ url: HOME, pictures: 'copy', current, maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'v0');
        assert.deepStrictEqual(r.report.pages.map((p) => [p.title, p.read]), [['Hearth & Crumb', true], ['About', true], ['Contact', false]]);
        assert.ok(r.report.pages[1].words >= 80);
        assert.ok(!saved.some((s) => s.includes('/_next/image') || /placeholder/.test(s)), saved.join(', '));
        const all = JSON.stringify(r.definition.pages);
        assert.ok(all.includes('separate oven') && all.includes('cardamom buns are the best') && all.includes('Our story'));
    });

    console.log(`\n${passed}/${total} passed`);
})();
