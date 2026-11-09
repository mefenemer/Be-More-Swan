// tests/site-import-look-hook.test.ts
// The look hook (owner, 2026-11-09, the platform reports' biggest shared fix): builders keep the owner's
// theme in their own variables, or ship their own interface colours that the shared reader mistook for
// the brand's (Hostinger's purple, Wix's blue). Each adapter can now:
//   lookStylesheets — fetch its theme file too; lookCss — take its own CSS out; look — read its theme.
// Plus: shadcn / Tailwind v4 colour tokens, and the look read from the page as the browser drew it.
//
// Run:  npx tsx tests/site-import-look-hook.test.ts

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { ADAPTERS } from '../src/utils/site-builders';
import { designTokens, readImportedLook, tokenColour } from '../src/utils/site-import-theme';
import { runImport, withOwnLook, type ImportDeps } from '../src/utils/site-import';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const adapter = (k: string) => ADAPTERS.find((a) => a.key === k)!;
const own = (k: string, html: string, css = '') => adapter(k).look!({ html, css, $: cheerio.load(html), url: new URL('https://x.example/') });
const fixture = (k: string) => {
    const dir = join(root, 'tests/fixtures/site-platforms', k);
    const files = readdirSync(dir);
    return {
        html: files.filter((f) => f.endsWith('.html')).map((f) => readFileSync(join(dir, f), 'utf8')).find((h) => /<style|stylesheet/i.test(h)) ?? '',
        css: files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n'),
    };
};
const current = () => starterSite({ name: 'Look Co', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@account.example' }, themeFromBrandKit(null));
const words = `<p>${'The business has a lot to say about what it does and who it helps every week. '.repeat(14)}</p>`;

async function main() {
    console.log('Design tokens');

    await check('shadcn HSL triples, hsl(), oklch(), rgb() and hex all become hex; the light-mode value wins', () => {
        assert.strictEqual(tokenColour('222.2 47.4% 11.2%'), '#0f172a');
        assert.strictEqual(tokenColour('hsl(142 76% 36%)'), '#16a249');
        assert.strictEqual(tokenColour('oklch(62.8% 0.2577 29.23)'), '#ff0000');
        assert.strictEqual(tokenColour('rgb(18, 18, 18)'), '#121212');
        assert.strictEqual(tokenColour('var(--x)'), null);
        assert.deepStrictEqual(designTokens(':root{--background: 0 0% 100%;--foreground: 222.2 84% 4.9%;--primary: 142.1 76.2% 36.3%}.dark{--primary: 0 0% 98%}'),
            { primary: '#16a34a', background: '#ffffff', foreground: '#020817' });
    });

    await check('an AI-built (shadcn) site gets its colours; before, the harvest read none of them', () => {
        const l = readImportedLook('<html><head><style>:root{--background:0 0% 100%;--foreground:222.2 84% 4.9%;--primary:24 95% 53%}</style></head><body><main><h1>Hi</h1></main></body></html>', 'https://x.example/');
        assert.deepStrictEqual([l.primaryColor, l.backgroundColor, l.textColor], ['#f97015', '#ffffff', '#020817']);
    });

    console.log('\nThe hook');

    await check('the adapter\'s own reading wins field by field; a named heading font finds its pairing', () => {
        const shared = readImportedLook('<html><body></body></html>', 'https://x.example/');
        const merged = withOwnLook({ ...shared, primaryColor: '#116dff', textColor: '#222222' }, { primaryColor: '#2e6b4a', textColor: null, headingFont: 'Playfair Display' });
        assert.deepStrictEqual([merged.primaryColor, merged.textColor, merged.font], ['#2e6b4a', '#222222', 'classic']);
    });

    await check('Wix: the owner\'s palette, not Wix\'s own blue banner', () => {
        const { html, css } = fixture('wix');
        assert.strictEqual(readImportedLook(html, 'https://x.example/', css).primaryColor, '#116dff', 'the shared reading alone takes Wix\'s blue');
        const fin = withOwnLook(readImportedLook(html, 'https://x.example/', css), own('wix', html, css)!);
        assert.notStrictEqual(fin.primaryColor, '#116dff');
    });

    await check('WordPress, Elementor, Squarespace, Shopify, GoDaddy: each reads its theme (main colour and lettering)', () => {
        for (const k of ['wordpress', 'elementor', 'squarespace', 'shopify', 'godaddy']) {
            const { html, css } = fixture(k);
            const fin = withOwnLook(readImportedLook(html, 'https://x.example/', css), own(k, html, css) ?? {});
            assert.ok(fin.primaryColor, `${k}: a main colour`);
            assert.ok(fin.font, `${k}: a lettering pairing`);
        }
    });

    await check('Hostinger: its own interface purple is taken out before the look is read', () => {
        const html = `<html><head><style>:root{--color-meteorite:#2f1c6a;--color-primary:#673de6;--color-primary-dark:#5025d1}</style><style>:root{--site-accent:#c0392b}.btn{background:#c0392b}a{color:#c0392b}</style></head><body><main><h1>Studio</h1><a class="btn" href="/x">Book</a></main></body></html>`;
        assert.strictEqual(readImportedLook(html, 'https://x.example/').primaryColor, '#673de6', 'before: the builder\'s purple');
        const sh = adapter('hostinger').lookCss!({ html, css: '' });
        assert.notStrictEqual(readImportedLook(sh.html, 'https://x.example/', sh.css).primaryColor, '#673de6');
    });

    await check('Webflow: its base stylesheet and default button blue are not the owner\'s look', () => {
        const css = '.w-button{background-color:#3898ec;color:#fff}.w-nav{background:#ddd}.btn-main{background-color:#8a4b2a}a{color:#8a4b2a}';
        assert.strictEqual(adapter('webflow').lookCss!({ html: '', css }).css, '.btn-main{background-color:#8a4b2a}a{color:#8a4b2a}');
    });

    await check('Ghost, Shopify and Joomla read their standard theme variables', () => {
        assert.deepStrictEqual(own('ghost', '<style>:root{--ghost-accent-color:#ff5a1f;--gh-font-heading:"Playfair Display",serif}</style>'), { primaryColor: '#ff5a1f', headingFont: 'Playfair Display' });
        const s = own('shopify', '<style>:root{--color-base-accent-1: 18, 52, 86;--color-base-text: 18, 18, 18;--color-base-background-1: 255, 255, 255;--font-heading-family: "Fraunces", serif;}</style>')!;
        assert.deepStrictEqual([s.primaryColor, s.textColor, s.backgroundColor, s.headingFont], ['#123456', '#121212', '#ffffff', 'Fraunces']);
        assert.deepStrictEqual(own('joomla', '<style>:root{--cassiopeia-color-primary:hsl(240, 68%, 20%);--cassiopeia-color-link:#224faa}</style>'), { primaryColor: '#224faa', headerColor: '#101056' });
    });

    console.log('\nThe whole import');

    await check('runImport uses the adapter that read the home page; Elementor\'s kit stylesheet is fetched first', async () => {
        const fetched: string[] = [];
        const html = `<!doctype html><html><head><meta name="generator" content="WordPress 6.6"><link rel="stylesheet" href="/wp-content/themes/hello/style.css"><link rel="stylesheet" id="elementor-post-7-css" href="/wp-content/uploads/elementor/css/post-7.css?ver=1712"></head>
<body class="elementor-kit-7"><main><h1>Fern & Co</h1>${words}</main></body></html>`;
        const deps: ImportDeps = {
            async fetchHtml(url) { return url === 'https://fern.example/' ? { ok: true, html, finalUrl: url } : { ok: false, message: '404' }; },
            async plan() { return null; }, async savePicture() { return null; },
            async fetchCss(url) { fetched.push(url); return url.includes('post-7.css') ? '.elementor-kit-7{--e-global-color-primary:#2d5f3f;--e-global-color-text:#222222;--e-global-typography-primary-font-family:"Playfair Display"}' : 'body{color:#333}'; },
        };
        const r = await runImport({ url: 'https://fern.example/', pictures: 'skip', current: current(), maxPages: 5 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'elementor');
        assert.ok(fetched[0]?.includes('/wp-content/uploads/elementor/css/post-7.css'), fetched.join(' '));
        assert.strictEqual(r.report.look?.primaryColor, '#2d5f3f');
        assert.strictEqual(r.definition.theme.font, 'classic');
    });

    await check('a JavaScript site\'s look is read from the page the browser drew', async () => {
        const shell = '<!doctype html><html><head></head><body><div id="root"></div><script src="/assets/index.js"></script></body></html>';
        const drawn = `<!doctype html><html><head><style>:root{--background:0 0% 100%;--foreground:20 14% 4%;--primary:262 83% 58%}</style></head><body><div id="root"><main><h1>Glow Studio</h1>${words}</main></div></body></html>`;
        const deps: ImportDeps = {
            async fetchHtml(url) { return { ok: true, html: shell, finalUrl: url }; },
            async renderHtml(url) { return { ok: true, html: drawn, finalUrl: url }; },
            async plan() { return null; }, async savePicture() { return null; },
        };
        const r = await runImport({ url: 'https://glow.example/', pictures: 'skip', current: current(), maxPages: 1 }, deps);
        assert.ok(r.ok, !r.ok ? r.message : '');
        assert.strictEqual(r.ok && r.report.look?.primaryColor, '#7c3bed');
    });

    console.log(`\n${passed}/${total} passed`);
}
void main();
