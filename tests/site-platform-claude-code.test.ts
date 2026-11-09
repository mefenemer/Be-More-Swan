// tests/site-platform-claude-code.test.ts
// Website import of sites a business built themselves with Claude Code (adapter key `claude-code`).
// Claude Code is a coding tool, not a host: its sites carry no trace of it, so `detect` stays false
// and these tests pin what TODAY's generic import makes of the shapes such sites take — a static
// Tailwind CDN site with drop-downs and data-cms-* attributes, a page filled from /content/*.json by
// its own script, a Decap (Netlify) CMS site, and Eleventy / Astro builds. All fixtures are synthetic.
// No network, no model (plan → null). Findings: docs/site-import-platforms/claude-code.md
//
// Run:  npx tsx tests/site-platform-claude-code.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { readImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { adapter } from '../src/utils/site-builders/claude-code';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const dir = join(__dirname, 'fixtures/site-platforms/claude-code');
const fx = (f: string) => readFileSync(join(dir, f), 'utf8');
const current = () => starterSite({ name: 'Harbour Lane Mediation', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

const HL = 'https://harbourlane.example';
const TAILWIND: Record<string, string> = {
    [`${HL}/`]: 'tailwind-static/index.html',
    [`${HL}/about.html`]: 'tailwind-static/about.html',
    [`${HL}/services/mediation.html`]: 'tailwind-static/services/mediation.html',
    [`${HL}/contact.html`]: 'tailwind-static/contact.html',
    [`${HL}/blog.html`]: 'tailwind-static/blog.html',
};

function deps(files: Record<string, string>, extra: Partial<ImportDeps> = {}): ImportDeps & { pictures: string[] } {
    const pictures: string[] = [];
    return {
        pictures,
        async fetchHtml(url) {
            const f = files[url];
            return f ? { ok: true, html: fx(f), finalUrl: url } : { ok: false, message: 'That link returned an error (404).' };
        },
        async plan() { return null; },
        async savePicture(src) { pictures.push(src); return 500 + pictures.length; },
        ...extra,
    };
}

/** What a browser shows once the page's own script has filled it from its JSON (stands in for headless Chrome). */
function filledFromJson(shell: string, json: Record<string, unknown>): string {
    const $ = cheerio.load(shell);
    const at = (path: string) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), json);
    $('[data-cms-field]').each((_, el) => { const v = at($(el).attr('data-cms-field')!); if (typeof v === 'string') $(el).text(v); });
    $('[data-cms-href]').each((_, el) => { const v = at($(el).attr('data-cms-href')!); if (typeof v === 'string') $(el).attr('href', v); });
    for (const f of (json.features as Array<Record<string, string>>) ?? []) $('[data-cms-list="features"]').append(`<div><img src="${f.image}" alt="${f.alt}"><h3>${f.title}</h3><p>${f.body}</p></div>`);
    for (const n of (json.nav as Array<Record<string, string>>) ?? []) $('#nav').append(`<a href="${n.href}">${n.label}</a>`);
    $('.loading').remove();
    $('script').remove();
    return $.html();
}

async function main() {
    console.log('\nDetection');

    await check('no fixture is claimed as Claude Code: it leaves no reliable trace, so detect stays false', () => {
        for (const f of ['tailwind-static/index.html', 'json-filled/index.html', 'decap/index.html', 'eleventy/index.html', 'astro/index.html']) {
            const html = fx(f);
            assert.strictEqual(adapter.detect(html, '', cheerio.load(html)), false, f);
            assert.notStrictEqual(readImportPage(html, 'https://x.example/').platform, 'claude-code', f);
        }
    });

    console.log('\nA static Tailwind CDN site (Restorative Futures\' shape)');

    await check('home page: hero, cards, quote in order; Tailwind bg-[url()] and style backgrounds read as pictures', () => {
        const p = readImportPage(fx('tailwind-static/index.html'), `${HL}/`);
        assert.strictEqual(p.platform, null);
        assert.strictEqual(p.builder, 'other');
        assert.strictEqual(p.words, 106);
        assert.deepStrictEqual(p.blocks.slice(0, 5).map((b) => b.kind), ['image', 'heading', 'text', 'button', 'button']);
        assert.ok(p.blocks[0].kind === 'image' && p.blocks[0].src === `${HL}/images/hero-harbour.jpg`);
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('still speaking to each other')));
        // Card links drawn as plain <a> with utility classes are buttons.
        assert.strictEqual(p.blocks.filter((b) => b.kind === 'button' && b.text === 'Read more →').length, 2);
        assert.strictEqual(p.logo?.src, `${HL}/images/logo.png`);
        assert.deepStrictEqual(p.contact.emails, ['hello@harbourlane.example']);
        assert.strictEqual(p.socialLinks?.length, 2);
    });

    await check('LOST today: a background picture that comes before its card\'s heading is described by the PREVIOUS card', () => {
        const p = readImportPage(fx('tailwind-static/index.html'), `${HL}/`);
        const pic = p.blocks.find((b) => b.kind === 'image' && b.src.endsWith('/neighbours.jpg'));
        assert.ok(pic && pic.kind === 'image' && pic.alt === 'Workplace mediation' && !pic.altFromSite);
    });

    await check('menu: the classed drop-down keeps its group; an Alpine-style one (button + unnamed box) loses it', () => {
        const p = readImportPage(fx('tailwind-static/index.html'), `${HL}/`);
        assert.deepStrictEqual(p.navLinks.map((l) => [l.text, l.group ?? null]), [
            ['Home', null], ['Our Story', 'About Us'], ['Family Mediation', null], ['Workplace Mediation', null], ['Blogs', null], ['Get in touch', null],
        ]);
    });

    await check('LOST today: no site name (no og:site_name or JSON-LD; the title suffix is not read) and the footer blurb', () => {
        const p = readImportPage(fx('tailwind-static/index.html'), `${HL}/`);
        assert.strictEqual(p.siteName, null);
        assert.ok(!p.blocks.some((b) => b.kind !== 'image' && b.text.includes('Calm, practical help')));
    });

    await check('a <details> FAQ reads as plain text lines (question then answer), not as questions', () => {
        const p = readImportPage(fx('tailwind-static/services/mediation.html'), `${HL}/services/mediation.html`);
        const i = p.blocks.findIndex((b) => b.kind === 'text' && b.text === 'Is mediation confidential?');
        assert.ok(i > 0 && p.blocks[i + 1].kind === 'text');
    });

    await check('a Netlify form: its questions are kept, the honeypot left out; the address is read', () => {
        const p = readImportPage(fx('tailwind-static/contact.html'), `${HL}/contact.html`);
        assert.ok(p.hasForm);
        assert.deepStrictEqual(p.formFields, ['Your name', 'Email', 'How can we help?']);
        assert.strictEqual(p.contact.address, '3 Harbour Lane, Westport, Westshire, WS1 2AB');
    });

    await check('the whole import: pages read, blog widget page switched to /blog, the look from tailwind.config', async () => {
        const r = await runImport({ url: `${HL}/`, pictures: 'skip', current: current(), maxPages: 20 }, deps(TAILWIND));
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.deepStrictEqual(r.report.pages.map((p) => [p.title, p.read]), [
            ['Home', true], ['Our Story', true], ['Family Mediation', true], ['Workplace Mediation', false], ['Blogs', true], ['Get in touch', true],
        ]);
        assert.strictEqual(r.report.wordsRead, 325);
        assert.deepStrictEqual(r.definition.settings.blog, { enabled: true, menuLabel: 'Blogs' });
        assert.strictEqual(r.report.look?.secondaryColor, '#1f6f68');
        assert.strictEqual(r.report.look?.backgroundColor, '#fbf8f2');
        assert.strictEqual(r.report.look?.headingFont, 'Fraunces');
        // LOST today: no main colour picked from the inline palette (the primary falls back to the starter's).
        assert.strictEqual(r.report.look?.primaryColor, null);
    });

    await check('"about.html" becomes the address /about (file extensions are dropped, shared fix 2026-11-09)', async () => {
        const r = await runImport({ url: `${HL}/`, pictures: 'skip', current: current(), maxPages: 20 }, deps(TAILWIND));
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.deepStrictEqual(r.definition.pages.map((p) => p.slug), ['', 'about', 'mediation', 'contact']);
        // The old address (about.html) is the same page once .html is read off, so no redirect is needed.
        assert.ok(!r.definition.redirects?.some((x) => x.to === '/about-html'));
    });

    console.log('\nA page filled from /content/*.json by its own script');

    await check('plain read: only "Loading…" — too thin, and the import says so without charging', async () => {
        const p = readImportPage(fx('json-filled/index.html'), 'https://oakember.example/');
        assert.strictEqual(p.words, 1);
        assert.deepStrictEqual(p.navLinks, []);
        const r = await runImport({ url: 'https://oakember.example/', pictures: 'skip', current: current(), maxPages: 20 }, deps({ 'https://oakember.example/': 'json-filled/index.html' }));
        assert.ok(!r.ok && /draws its words with JavaScript/.test(r.message) && /Nothing was charged/.test(r.message));
    });

    await check('with the headless browser (renderHtml) the filled page imports: words, cards and the script-drawn menu', async () => {
        const json = JSON.parse(fx('json-filled/content/home.json'));
        const rendered = filledFromJson(fx('json-filled/index.html'), json);
        const r = await runImport({ url: 'https://oakember.example/', pictures: 'skip', current: current(), maxPages: 1 }, deps({ 'https://oakember.example/': 'json-filled/index.html' }, {
            async renderHtml(url) { return { ok: true, html: rendered, finalUrl: url }; },
        }));
        assert.ok(r.ok);
        if (!r.ok) return;
        assert.ok(r.report.wordsRead > 80);
        const p = readImportPage(rendered, 'https://oakember.example/');
        // LOST today: the header's site-name link (to /) comes first, so Home's own menu word is dropped.
        assert.deepStrictEqual(p.navLinks.map((l) => l.text), ['Oak & Ember Pottery', 'Classes', 'Shop', 'Visit us']);
        assert.ok(p.blocks.some((b) => b.kind === 'heading' && b.text === 'Weekend taster classes'));
        // The site name sits in the header link, which the read drops.
        assert.strictEqual(p.siteName, null);
    });

    console.log('\nA Decap (Netlify) CMS site');

    await check('plain read: the CMS-filled hero and hours are empty shells; only the fixed heading and button remain', () => {
        const p = readImportPage(fx('decap/index.html'), 'https://bramblestreet.example/');
        assert.strictEqual(p.words, 5);
        assert.deepStrictEqual(p.blocks.map((b) => b.kind), ['heading', 'button']);
        assert.deepStrictEqual(p.navLinks.map((l) => l.text), ['Home', 'About', 'Order']);
        // The words are in /content/pages/home.json, mapped by /admin/config.yml — neither is read today.
        assert.ok(fx('decap/admin/config.yml').includes('file: "content/pages/home.json"'));
        assert.ok(JSON.parse(fx('decap/content/pages/home.json')).intro.length > 100);
    });

    console.log('\nStatic builds (Eleventy, Astro)');

    await check('Eleventy: everything read; the largest <picture> source; the site title takes Home\'s menu place', () => {
        const p = readImportPage(fx('eleventy/index.html'), 'https://fernside.example/');
        assert.strictEqual(p.words, 109);
        assert.ok(p.blocks.some((b) => b.kind === 'image' && b.src === 'https://fernside.example/img/Xy12ab-1600.jpeg' && b.altFromSite));
        assert.deepStrictEqual(p.navLinks.map((l) => [l.text, l.group ?? null]), [
            ['Fernside Garden Design', null], ['Projects', null], ['Courtyards', 'Projects'], ['Family gardens', 'Projects'], ['About', null], ['Contact', null],
        ]);
        assert.ok(!p.blocks.some((b) => b.kind !== 'image' && /skip to content/i.test(b.text)));
    });

    await check('Astro: server-rendered islands are read (the reviews quote), scoped data-astro-cid attributes are harmless', () => {
        const p = readImportPage(fx('astro/index.html'), 'https://northlight.example/');
        assert.strictEqual(p.words, 50);
        assert.ok(p.blocks.some((b) => b.kind === 'quote' && b.text.includes('calf tear')));
        assert.ok(p.blocks.some((b) => b.kind === 'button' && b.text === 'Book an assessment'));
        assert.deepStrictEqual(p.contact.phones, ['01632960999']);
    });

    console.log(`\n${passed}/${total} passed`);
}
main();
