// tests/site-platform-sitecore.test.ts
// The Website import on Sitecore sites (src/utils/site-builders/sitecore.ts): XP/XM with SXA MVC
// renderings, XM Cloud / JSS Next.js (server-rendered and shell-only) and a client-rendered JSS app.
// SYNTHETIC fixtures only (tests/fixtures/site-platforms/sitecore/) — no network, no model.
//
// Run:  npx tsx tests/site-platform-sitecore.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { adapter } from '../src/utils/site-builders/sitecore';
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

const dir = join(__dirname, 'fixtures/site-platforms/sitecore');
const fixture = (f: string) => readFileSync(join(dir, `${f}.html`), 'utf8');
const SITE = 'https://www.fernandfield.example';
const read = (f: string, path = '/') => readImportPage(fixture(f), `${SITE}${path}`);
const texts = (p: ImportPage) => p.blocks.filter((b) => b.kind !== 'image').map((b) => ('text' in b ? b.text : ''));
const images = (p: ImportPage) => p.blocks.flatMap((b) => (b.kind === 'image' ? [b.src] : []));
const detect = (html: string) => adapter.detect(html, (cheerio.load(html)('meta[name="generator"]').attr('content') ?? '').toLowerCase(), cheerio.load(html));
const RESIZED = /[?&](h|w|mh|hash|iar|sc|as)=/;

async function main() {
    console.log('\nDetection');

    await check('every Sitecore shape is recognised: SXA, XM Cloud Next.js (full and shell), JSS client app', () => {
        for (const f of ['xp-sxa-home', 'xp-sxa-about', 'xmcloud-nextjs-home', 'xmcloud-nextjs-shell', 'jss-react-client']) {
            assert.ok(detect(fixture(f)), f);
            assert.strictEqual(adapterFor(fixture(f), cheerio.load(fixture(f)))?.key, 'sitecore', `${f} through the adapter list`);
        }
    });

    await check('a page that only mentions Sitecore, or links to another site\'s /-/media/ file, is not Sitecore', () => {
        assert.ok(!detect(fixture('not-sitecore')));
        assert.ok(!detect('<html><body><p>We are Sitecore partners.</p><div class="component">x</div></body></html>'));
    });

    await check('single strong signals each suffice', () => {
        for (const html of [
            '<html><head><meta name="generator" content="Sitecore XP 10.3"></head><body></body></html>',
            '<img src="/-/media/x.jpg?h=1&amp;w=2">',
            '<img src="/~/media/Images/x.ashx">',
            '<div style="background-image:url(\'/-/media/hero.jpg\')"></div>',
            '<img src="https://edge.sitecorecloud.io/tenant-1/media/Project/a.jpg">',
            '<form data-sc-fxb="x"></form>',
        ]) assert.ok(detect(html), html);
    });

    console.log('\nPictures');

    await check('media library resizes become one sensible full-size address', () => {
        const f = adapter.fullSizeImage!;
        assert.strictEqual(f(`${SITE}/-/media/project/a/hero.jpg?h=900&w=1920&mw=1920&la=en&hash=AB12`), `${SITE}/-/media/project/a/hero.jpg?la=en&mw=1600`);
        assert.strictEqual(f(`${SITE}/~/media/Images/a.ashx?h=200&w=300&as=1&sc=1`), `${SITE}/~/media/Images/a.ashx?mw=1600`);
        assert.strictEqual(f(`${SITE}/-/jssmedia/Project/a.jpg?h=4&iar=0&w=6&hash=00`), `${SITE}/-/jssmedia/Project/a.jpg?mw=1600`);
        assert.strictEqual(f('https://edge.sitecorecloud.io/t-1/media/Project/a.jpg?h=60&iar=0&w=180'), 'https://edge.sitecorecloud.io/t-1/media/Project/a.jpg?mw=1600');
        const wrapped = `${SITE}/_next/image?url=${encodeURIComponent('https://edge.sitecorecloud.io/t-1/media/a.jpg?h=1&w=2')}&w=1920&q=75`;
        assert.strictEqual(f(wrapped), 'https://edge.sitecorecloud.io/t-1/media/a.jpg?mw=1600');
        assert.strictEqual(f(`${SITE}/_next/image?url=%2Fimages%2Fa.jpg&w=640&q=75`), `${SITE}/images/a.jpg`);
        assert.strictEqual(f(`${SITE}/images/a.jpg?w=300`), null);
    });

    await check('every picture on an SXA page and an XM Cloud page arrives full size — logo included', () => {
        for (const f of ['xp-sxa-home', 'xmcloud-nextjs-home']) {
            const p = read(f);
            assert.ok(images(p).length >= 4, f);
            for (const src of images(p)) assert.ok(!RESIZED.test(src) && !src.includes('/_next/image'), src);
            assert.ok(p.logo && !RESIZED.test(p.logo.src) && !p.logo.src.includes('/_next/image'), p.logo?.src);
        }
    });

    console.log('\nXP / SXA');

    await check('the SXA menu keeps its drop-down: "Services" is top level, its pages under it', () => {
        const nav = read('xp-sxa-home').navLinks;
        assert.deepStrictEqual(nav.map((l) => [l.text, l.group ?? null]), [
            ['Home', null], ['Services', null], ['Garden design', 'Services'], ['Planting plans', 'Services'], ['About us', null], ['Contact', null],
        ]);
    });

    await check('the words come in order; breadcrumb, share buttons, back-to-top and the privacy warning are not content', () => {
        const p = read('xp-sxa-home');
        const t = texts(p);
        assert.deepStrictEqual(t.slice(0, 4), ['Gardens that grow with you', 'We design calm, wildlife-friendly gardens for homes across Wharfedale.', 'Book a garden visit', 'A garden plan made for your plot']);
        const all = t.join(' | ');
        for (const noise of ['Facebook', 'Share on X', 'Back to top', 'analytics', 'Got it', '© 2026']) assert.ok(!all.includes(noise), noise);
        assert.ok(p.blocks.some((b) => b.kind === 'text' && b.links?.[0]?.href === `${SITE}/services/planting-plans`));
        assert.deepStrictEqual(p.formFields, ['Your name', 'Email address', 'Tell us about your garden']);
        assert.deepStrictEqual(p.socialLinks, ['https://www.instagram.com/fernandfield.example']);
    });

    await check('an inner SXA page: title, page content and picture', () => {
        const p = read('xp-sxa-about', '/about-us');
        assert.strictEqual(p.blocks[0].kind === 'heading' && p.blocks[0].text, 'About Fern & Field');
        assert.ok(p.words >= 40);
    });

    console.log('\nHeadless (XM Cloud / JSS)');

    const ssr = read('xmcloud-nextjs-home');
    await check('a server-rendered XM Cloud page is read from its HTML, the layout JSON left alone (nothing twice)', () => {
        assert.ok(!fixture('xmcloud-nextjs-home').includes('data-sc-layout'));
        const t = texts(ssr);
        assert.strictEqual(new Set(t).size, t.length);
        assert.ok(t.includes('They turned a muddy slope into the place we eat every summer evening.'));
    });

    for (const f of ['xmcloud-nextjs-shell', 'jss-react-client']) {
        await check(`${f}: an empty shell is read from the layout JSON — the same words, menu, logo and pictures as the full page`, () => {
            const p = read(f);
            assert.deepStrictEqual([...texts(p)].sort(), [...texts(ssr)].sort());
            assert.strictEqual(p.words, ssr.words);
            assert.deepStrictEqual(p.navLinks, ssr.navLinks);
            assert.strictEqual(p.logo?.src, ssr.logo?.src);
            assert.deepStrictEqual([...images(p)].sort(), [...images(ssr)].sort());
            assert.strictEqual(p.blocks[0].kind === 'heading' && p.blocks[0].level, 1);
            assert.ok(p.contact.emails.includes('hello@fernandfield.example') && p.socialLinks?.length === 1);
        });
    }

    await check('the layout JSON gives no settings, metadata, dates, ratings or dictionary words', () => {
        const all = texts(read('jss-react-client')).join(' | ');
        for (const not of ['Garden design and planting plans in Wharfedale.', 'Read more', 'Search', '2026-04-01', 'site-logo', 'basis-1-2', 'fern-and-field']) assert.ok(!all.includes(not), not);
        assert.ok(!texts(read('jss-react-client')).includes('5'));
    });

    console.log('\nThe whole import (fake fetch, no model)');

    const PAGES: Record<string, string> = { [`${SITE}/`]: fixture('xp-sxa-home'), [`${SITE}/about-us`]: fixture('xp-sxa-about') };
    const pictures: string[] = [];
    const deps: ImportDeps = {
        async fetchHtml(url) { const html = PAGES[url]; return html ? { ok: true, html, finalUrl: url } : { ok: false, message: 'That link returned an error (404).' }; },
        async plan() { return null; },
        async savePicture(src) { pictures.push(src); return 700 + pictures.length; },
    };
    const current = () => starterSite({ name: 'Fern & Field', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

    await check('an SXA site imports unplanned: the report names Sitecore, the words land, pictures are copied full size', async () => {
        const r = await runImport({ url: `${SITE}/`, pictures: 'copy', current: current(), maxPages: 6 }, deps);
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'sitecore');
        assert.ok(r.report.pages.find((p) => p.url === `${SITE}/about-us`)?.read, JSON.stringify(r.report.pages.map((p) => [p.url, p.read])));
        const all = JSON.stringify(r.definition.pages);
        for (const w of ['Gardens that grow with you', 'Every garden starts with a walk round together.', 'About Fern & Field']) assert.ok(all.includes(w), w);
        assert.ok(pictures.length > 0);
        for (const src of pictures) assert.ok(!RESIZED.test(src), src);
        assert.ok(!all.includes('Share on X') && !all.includes('analytics'));
    });

    await check('a JSS shell imports without the headless browser (its words come from the page itself)', async () => {
        const d: ImportDeps = { ...deps, async fetchHtml(url) { return url === `${SITE}/` ? { ok: true, html: fixture('jss-react-client'), finalUrl: url } : { ok: false, message: '404' }; }, async renderHtml() { throw new Error('should not be needed'); } };
        const r = await runImport({ url: `${SITE}/`, pictures: 'skip', current: current(), maxPages: 1 }, d);
        assert.ok(r.ok && r.report.wordsRead >= 100 && JSON.stringify(r.definition.pages).includes('Wildlife gardens'));
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
