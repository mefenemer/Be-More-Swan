// tests/site-import-theme.test.ts
// A Website import brings their old site's look (owner, 2026-11-08: "it also needs to bring in the
// original site's CSS — this looks black and white"). site-import-theme.ts reads colours, lettering
// and corners into the hosted theme's closed set of tokens; nothing of their stylesheet is copied.
//
// Run:  npx tsx tests/site-import-theme.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fontKeyFor, lookFound, readImportedLook, readTailwindConfig, themeWithLook } from '../src/utils/site-import-theme';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';
import { FONT_PAIRS, themeCss } from '../src/utils/site-render';
import { normaliseSiteDefinition } from '../src/utils/site-definition';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

// The shape of restorativefutures.co.uk: Tailwind from its CDN, the palette in an inline config.
const TAILWIND = `<!doctype html><html><head><title>Restorative Example</title>
<meta name="theme-color" content="#1d5b5a">
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>
<script>
  tailwind.config = { theme: { extend: {
    fontFamily: { display: ['Fraunces', 'Georgia', 'serif'], sans: ['Inter', 'system-ui', 'sans-serif'] },
    colors: {
      brand: { 50: '#f0f9f8', 100: '#e8f4f2', 500: '#2f8d89', 700: '#1d5b5a', 900: '#183d3c' },
      clay: { 500: '#d0653b' },
      sand: { 50: '#fbf9f5', 100: '#f5f1e8' }
    } } } };
</script></head>
<body class="bg-sand-50 font-sans text-brand-900 antialiased">
<header><nav><a class="nav-link rounded-lg px-3 py-2" href="/">Home</a><a class="nav-link rounded-lg px-3 py-2" href="/about">About</a><a class="nav-link rounded-lg px-3 py-2" href="/faqs">FAQs</a></nav></header>
<main><h1 class="font-display">Restorative practice training</h1><p>Practical courses for schools and services across the region, run by people who do the work.</p>
<a class="inline-flex rounded-full bg-brand-700 px-7 py-3.5 text-white" href="/courses">Discover Our Courses</a>
<a class="inline-flex rounded-full border px-7 py-3.5" href="/contact">Get in Touch</a></main></body></html>`;

// A plain site: colours in a stylesheet, a Google font.
const PLAIN = `<!doctype html><html><head><title>Plain</title><link rel="stylesheet" href="/style.css"></head>
<body><main><h1>Hello</h1><p>Words.</p><a class="btn" href="/contact">Contact</a></main></body></html>`;
const PLAIN_CSS = `:root{--brand-primary:#7a2e8f}body{background:#ffffff;color:#222222;font-family:'Lora',Georgia,serif}
h1{font-family:'Playfair Display',serif}.btn{background:var(--brand-primary);border-radius:4px;padding:10px 18px}`;

async function main() {
    console.log('Reading their look');

    await check('Tailwind: the palette and fonts come from the inline config — read as text, never run', () => {
        const tw = readTailwindConfig(TAILWIND)!;
        assert.strictEqual(tw.colours.get('brand-700'), '#1d5b5a');
        assert.strictEqual(tw.colours.get('sand-50'), '#fbf9f5');
        assert.deepStrictEqual(tw.fonts, { display: 'Fraunces', sans: 'Inter' });
        assert.strictEqual(readTailwindConfig(PLAIN), null);
    });

    await check('Restorative-shaped site: teal main colour, sand page, dark-teal words, Fraunces & Inter, round buttons', () => {
        assert.deepStrictEqual(readImportedLook(TAILWIND, 'https://restorative.example/'), {
            primaryColor: '#1d5b5a', textColor: '#183d3c', backgroundColor: '#fbf9f5', secondaryColor: null,
            headingFont: 'Fraunces', font: 'editorial', radius: 'large',
        });
    });

    await check('corners follow their buttons, not their menu links (menu links are padded too)', () => {
        const menuHeavy = TAILWIND.replace('</nav>', '<a class="rounded-lg px-3" href="/a">A</a><a class="rounded-lg px-3" href="/b">B</a></nav>');
        assert.strictEqual(readImportedLook(menuHeavy, 'https://restorative.example/').radius, 'large');
    });

    await check('a plain site: colours and lettering from its stylesheet, button corners from its button rule', () => {
        const l = readImportedLook(PLAIN, 'https://plain.example/', PLAIN_CSS);
        assert.strictEqual(l.primaryColor, '#7a2e8f');
        assert.strictEqual(l.font, 'classic', 'Playfair Display headings → our Playfair & Lora pairing');
        assert.strictEqual(l.radius, 'small');
    });

    await check('a font we do not host becomes serif or sans by its kind; nothing known keeps theirs', () => {
        assert.strictEqual(fontKeyFor('Merriweather'), 'serif');
        assert.strictEqual(fontKeyFor('Montserrat'), 'sans');
        assert.strictEqual(fontKeyFor('Zapfino Extra', 'Roboto'), 'sans');
        assert.strictEqual(fontKeyFor(null, null), null);
        assert.strictEqual(fontKeyFor('Fraunces', 'Inter'), 'editorial');
    });

    await check('every pairing we map to exists in the renderer, under the heading face we matched', () => {
        for (const [name, key] of [['Fraunces', 'editorial'], ['Playfair Display', 'classic'], ['Cormorant Garamond', 'elegant'], ['Manrope', 'modern'], ['Oswald', 'bold'], ['Nunito', 'friendly'], ['Space Grotesk', 'tech'], ['DM Serif Display', 'warm']] as const) {
            assert.strictEqual(fontKeyFor(name), key);
            assert.ok(FONT_PAIRS[key].heading.startsWith(`"${name}"`), `${key} heading is ${FONT_PAIRS[key].heading}`);
        }
    });

    console.log('\nThe draft takes it');

    const current = () => starterSite({ name: 'Restorative Example', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));

    await check('themeWithLook: colours, a tint of the main colour, lettering and corners — logo and header kept', () => {
        const base = { ...current().theme, logoUrl: 'https://cdn.example/logo.png', header: 'centered' as const };
        const t = themeWithLook(base, readImportedLook(TAILWIND, 'https://restorative.example/'));
        assert.deepStrictEqual([t.primaryColor, t.backgroundColor, t.textColor, t.accentColor, t.font, t.radius], ['#1d5b5a', '#fbf9f5', '#183d3c', '#1d5b5a', 'editorial', 'large']);
        assert.strictEqual(t.logoUrl, 'https://cdn.example/logo.png');
        assert.strictEqual(t.header, 'centered');
        const css = themeCss(normaliseSiteDefinition({ ...current(), theme: t }).definition.theme);
        assert.ok(css.includes('#1d5b5a') && css.includes('Fraunces'), 'the page is drawn in their colours and fonts');
    });

    await check('nothing read → nothing changed (their current design is kept)', () => {
        const empty = { primaryColor: null, textColor: null, backgroundColor: null, headingFont: null, font: null, radius: null };
        assert.strictEqual(lookFound(empty), false);
        assert.deepStrictEqual(themeWithLook(current().theme, empty), current().theme);
    });

    await check('the whole import: their look lands on the imported draft and in the report; stylesheets go through fetchCss', async () => {
        const fetched: string[] = [];
        const deps: ImportDeps = {
            async fetchHtml(url) { return url.startsWith('https://plain.example') ? { ok: true, html: PLAIN.replace('<p>Words.</p>', `<p>${'Words of the business about what it does and who it helps. '.repeat(20)}</p>`), finalUrl: 'https://plain.example/' } : { ok: false, message: '404' }; },
            async plan() { return null; },
            async savePicture() { return null; },
            async fetchCss(url) { fetched.push(url); return PLAIN_CSS; },
        };
        const r = await runImport({ url: 'https://plain.example/', pictures: 'skip', current: current(), maxPages: 5 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        assert.deepStrictEqual(fetched, ['https://plain.example/style.css']);
        assert.strictEqual(r.ok && r.report.look?.primaryColor, '#7a2e8f');
        assert.strictEqual(r.ok && r.definition.theme.primaryColor, '#7a2e8f');
        assert.strictEqual(r.ok && r.definition.theme.font, 'classic');
    });

    console.log('\nWiring');

    await check('live: stylesheets through robots + the SSRF fence; "Use this as my draft" takes the look the import read', () => {
        const store = read('src/utils/site-import-store.ts');
        assert.ok(store.includes('fetchSiteCss(url, CRAWLERS.siteImport'));
        assert.ok(store.includes('const theme = look ? themeWithLook(current.theme, look) : current.theme;'));
        assert.ok(read('src/utils/site-fetch.ts').includes('export async function fetchSiteCss'));
    });

    await check('the owner sees it before choosing: swatches and lettering on the review card; the chat is told too', () => {
        const js = read('src/components/assistant-site-editor.js');
        assert.ok(js.includes('${importLookLine(r.look)}'));
        assert.ok(js.includes("your current design is kept — change it in Design"));
        assert.ok(read('src/utils/site-import-store.ts').includes("their old site's look ${r?.look ?"));
    });

    console.log(`\n${passed}/${total} passed`);
}
void main();
