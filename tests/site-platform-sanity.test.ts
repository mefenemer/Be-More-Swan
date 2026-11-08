// tests/site-platform-sanity.test.ts
// The Website import on sites whose content comes from Sanity (src/utils/site-builders/sanity.ts).
// Synthetic pages only, modelled on Sanity's Next.js, Astro and Remix front ends — no network, no model:
// tests/fixtures/site-platforms/sanity/. Report: docs/site-import-platforms/sanity.md
//
// Run:  npx tsx tests/site-platform-sanity.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { __test } from '../src/utils/site-builders/sanity';
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
const fixture = (f: string) => readFileSync(join(root, `tests/fixtures/site-platforms/sanity/${f}.html`), 'utf8');
const SITE = 'https://studio.example';
const found = (html: string) => adapterFor(html, cheerio.load(html))?.key ?? null;
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => (b as { text: string }).text);
const images = (p: ImportPage) => p.blocks.filter((b) => b.kind === 'image') as { src: string; alt: string; altFromSite: boolean }[];
const current = () => starterSite({ name: 'Larkspur', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

async function main() {
    console.log('\nDetection');

    await check('Sanity pages are recognised by their pictures, preview markup or Portable Text data', () => {
        for (const f of ['next-ssr-home', 'astro-about', 'next-pages-shell', 'next-app-rsc-shell', 'remix-shell']) assert.strictEqual(found(fixture(f)), 'sanity', f);
        assert.strictEqual(found('<html><body><main><p>Hand-made page</p><img src="https://images.example/a.jpg"></main></body></html>'), null);
        // A blog post that merely mentions Sanity is not a Sanity site.
        assert.strictEqual(found('<html><body><main><p>We moved our CMS to Sanity (sanity.io) last year.</p></main></body></html>'), null);
    });

    console.log('\nA page the server drew (Next.js, Astro)');

    await check('words, list, quote and inline link read in order; stega characters and Portable Text warnings gone', () => {
        const p = readImportPage(fixture('next-ssr-home'), `${SITE}/`);
        const t = texts(p);
        assert.strictEqual(t[0], 'Throw your first pot this spring');
        assert.ok(!t.some((x) => /[​-‍⁠﻿]/.test(x)), 'no invisible characters');
        assert.ok(!t.some((x) => /Unknown block type/.test(x)));
        assert.ok(t.includes('Six people at most') && t.includes('I came for one evening and stayed for the whole term.'));
        const para = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('Each evening')) as { links?: { href: string }[] };
        assert.deepStrictEqual(para.links?.map((l) => l.href), [`${SITE}/first-visit`]);
        assert.strictEqual(p.platform, 'sanity');
    });

    await check('next/image and Astro /_image wrappers lead to the Sanity original: crop kept, sized to 1600 at most', () => {
        const ssr = images(readImportPage(fixture('next-ssr-home'), `${SITE}/`));
        assert.strictEqual(ssr[0].src, 'https://cdn.sanity.io/images/abc123xy/production/2222222222222222222222222222222222222222-4000x2667.jpg?rect=0%2C333%2C4000%2C2000&w=1600&fit=max');
        assert.strictEqual(ssr[0].alt, 'Hands shaping a bowl on the wheel');
        // Already small enough: the original, untouched.
        assert.strictEqual(ssr[1].src, 'https://cdn.sanity.io/images/abc123xy/production/3333333333333333333333333333333333333333-1600x1200.png');
        const astro = images(readImportPage(fixture('astro-about'), `${SITE}/about`));
        assert.strictEqual(astro[0].src, 'https://cdn.sanity.io/images/q9w8e7r6/live/5555555555555555555555555555555555555555-3000x2000.jpg?w=1600&fit=max');
        assert.strictEqual(astro[1].src, 'https://cdn.sanity.io/images/q9w8e7r6/live/6666666666666666666666666666666666666666-1200x900.jpg/workshop-bench.jpg');
    });

    await check('picture addresses: other wrappers (Vercel, Netlify, Cloudflare, IPX), files, and other hosts', () => {
        const inner = 'https://cdn.sanity.io/images/p1/ds/aaaa-800x600.jpg?w=400&fit=crop&auto=format';
        const e = encodeURIComponent(inner);
        const want = 'https://cdn.sanity.io/images/p1/ds/aaaa-800x600.jpg';
        for (const s of [`${SITE}/_vercel/image?url=${e}&w=640&q=75`, `${SITE}/.netlify/images?url=${e}&w=640`, `${SITE}/cdn-cgi/image/width=640,format=auto/${inner}`, `${SITE}/_ipx/w_640/${inner}`]) {
            assert.strictEqual(__test.sanityFullSize(s), want, s);
        }
        assert.strictEqual(__test.sanityFullSize('https://cdn.sanity.io/files/p1/ds/bbbb.pdf'), 'https://cdn.sanity.io/files/p1/ds/bbbb.pdf');
        assert.strictEqual(__test.sanityFullSize('https://images.example/a.jpg?w=300'), null);   // not ours: the shared rule decides
        assert.strictEqual(__test.sanityFullSize(`${SITE}/_next/image?url=%2Flocal.jpg&w=640`), `${SITE}/local.jpg`);   // the site's own original
    });

    await check('stega: long invisible runs go, a single joiner (emoji, Persian) stays', () => {
        const zw = '​‌‍​⁠﻿‌';
        assert.strictEqual(`Book now${zw}`.replace(__test.STEGA, ''), 'Book now');
        assert.strictEqual('👩‍🍳 chef'.replace(__test.STEGA, ''), '👩‍🍳 chef');
        const p = readImportPage(`<html><body><main><h1>Hello</h1><img src="https://cdn.sanity.io/images/p/d/cccc-900x900.jpg" alt="A cake${zw}"><p>Words of the business, quite a few of them.</p></main></body></html>`, `${SITE}/`);
        assert.strictEqual(images(p)[0].alt, 'A cake');
    });

    console.log('\nA page the browser draws (words only in the page data)');

    await check('Next.js Pages Router: Portable Text in __NEXT_DATA__ becomes the page, in order, without SEO or settings words', () => {
        const p = readImportPage(fixture('next-pages-shell'), `${SITE}/`);
        const t = texts(p);
        assert.deepStrictEqual(t.slice(0, 3), ['Gardens that look after themselves', 'Planting plans for small town gardens, drawn up after one visit.', 'Book a garden visit']);
        assert.ok(t.includes('What you get') && t.includes('A planting list with where to buy each plant') && t.includes('Three years on, the garden still looks like the drawing.'));
        assert.ok(t.includes('Visits run from March to October.'));
        assert.ok(!t.some((x) => /SEO words|Footer words|Loading/.test(x)), t.join(' | '));
        assert.ok(!t.includes('Home'), 'the page document title is its menu name, not a heading');
        assert.strictEqual((p.blocks.find((b) => b.kind === 'heading' && b.text === 'What you get') as { level: number }).level, 3);
        const btn = p.blocks.find((b) => b.kind === 'button') as { href: string };
        assert.strictEqual(btn.href, `${SITE}/contact`);
        const para = p.blocks.find((b) => b.kind === 'text' && b.text.startsWith('We walk')) as { links?: { href: string }[] };
        assert.deepStrictEqual(para.links?.map((l) => l.href), [`${SITE}/checklist`]);
        // Pictures from asset references, built from the project and dataset; alt from the owner's field.
        assert.deepStrictEqual(images(p).map((i) => [i.src, i.altFromSite]), [
            ['https://cdn.sanity.io/images/abc123xy/production/4444444444444444444444444444444444444444-2400x1600.jpg?w=1600&fit=max', true],
            ['https://cdn.sanity.io/images/abc123xy/production/5555555555555555555555555555555555555555-1800x1200.png?w=1600&fit=max', true],
        ]);
        assert.ok(p.words >= 40);
    });

    await check('Next.js App Router (RSC payload split over pushes) and Remix (__remixContext) read the same', () => {
        const pages = readImportPage(fixture('next-pages-shell'), `${SITE}/`);
        for (const f of ['next-app-rsc-shell', 'remix-shell']) {
            const p = readImportPage(fixture(f), `${SITE}/`);
            assert.deepStrictEqual(texts(p), texts(pages), f);
            assert.strictEqual(images(p).length, 2, f);
        }
    });

    await check('a page the server drew is never added to from its data (no doubled words)', () => {
        const html = fixture('next-ssr-home').replace('</body>', `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { body: [{ _type: 'block', _key: 'x', style: 'normal', markDefs: [], children: [{ _type: 'span', text: 'Only in data' }] }] } } })}</script></body>`);
        assert.ok(!texts(readImportPage(html, `${SITE}/`)).includes('Only in data'));
    });

    await check('page data is never trusted with javascript: links or HTML', () => {
        const body = [{ _type: 'block', _key: 'a', style: 'normal', markDefs: [{ _key: 'm', _type: 'link', href: 'javascript:alert(1)' }],
            children: [{ _type: 'span', text: '<b>Bold</b> claim and a ', marks: [] }, { _type: 'span', text: 'bad link', marks: ['m'] }] }];
        const html = `<html><body><main></main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { page: { _type: 'page', body } } } })}</script></body></html>`;
        const p = readImportPage(html, `${SITE}/`);
        const b = p.blocks[0] as { text: string; links?: unknown[] };
        assert.strictEqual(b.text, '<b>Bold</b> claim and a bad link');
        assert.ok(!b.links);
    });

    console.log('\nThe whole import (fake fetch, no model)');

    await check('a Sanity site of browser-drawn pages imports without the headless browser', async () => {
        const PAGES: Record<string, string> = { [`${SITE}/`]: fixture('next-pages-shell'), [`${SITE}/about`]: fixture('astro-about'), [`${SITE}/contact`]: fixture('next-ssr-home') };
        const calls = { render: 0, pictures: [] as string[] };
        const deps: ImportDeps = {
            async fetchHtml(url) { const html = PAGES[url] ?? PAGES[url.replace(/\/$/, '')]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: '404' }; },
            async renderHtml() { calls.render++; return { ok: false, message: 'not used' }; },
            async plan() { return null; },
            async savePicture(src) { calls.pictures.push(src); return 700 + calls.pictures.length; },
        };
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 5 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(calls.render, 0);
        assert.deepStrictEqual(r.report.pages.map((p) => [p.title, p.read]), [['Home', true], ['About', true], ['Contact', true]]);
        const words = JSON.stringify(r.definition);
        assert.ok(words.includes('Gardens that look after themselves') && words.includes('About the workshop'));
        assert.ok(!/[​-‍⁠]/.test(words) && !words.includes('Unknown block type') && !words.includes('_next/image'));
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
