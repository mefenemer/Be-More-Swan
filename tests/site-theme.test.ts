// tests/site-theme.test.ts
// Admin ▸ Site Styles (2026-10-06): the admin edits fonts, text, labels, buttons and borders, and
// "Set as Be More Swan standard" restyles every page live. What must hold:
//   · the default theme produces NO CSS — publishing it changes nothing
//   · nothing free-form reaches the stylesheet (every value is a hex, a known font or a listed option)
//   · every full page loads the loader, in <head>, right after style.css (no flash of the old look)
//   · the public endpoint is cheap to poll and never breaks a page
//
// Run:  npx tsx tests/site-theme.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeCss, normalizeTheme, defaults, fontUrl, TOKENS } from '../src/public/site-theme-core.js';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

check('the default theme is a no-op', () => {
    assert.strictEqual(themeCss(defaults()), '');
    assert.strictEqual(themeCss(null), '');
});

check('a change produces exactly its own rule', () => {
    const t = { ...defaults(), headingColor: '#112233', btn_primary_bg: '#0000ff' };
    const css = themeCss(t);
    assert.match(css, /--color-gray-900:#112233/);
    assert.match(css, /@layer bms-site-theme\{.*\.btn-primary\{background-color:#0000ff\}/);
    assert.doesNotMatch(css, /btn-secondary/, 'an untouched button got a rule');
});

check('nothing free-form survives normalisation', () => {
    const evil = normalizeTheme({ headingColor: 'red;}body{display:none', bodyFont: 'x"};', labelSize: '99px;color:red', unknown: 'x' });
    assert.strictEqual(evil.headingColor, defaults().headingColor);
    assert.strictEqual(evil.bodyFont, defaults().bodyFont);
    assert.strictEqual(evil.labelSize, null);
    assert.ok(!('unknown' in evil));
    assert.strictEqual(themeCss({ headingColor: '</style><script>' }), '');
});

check('every token has a default of its own type', () => {
    for (const t of TOKENS) {
        if (t.type === 'color') assert.match(String(t.default), /^#[0-9a-f]{6}$/, t.key);
        if (t.type === 'select') assert.ok(t.options!.some((o) => (o.value === '' ? null : o.value) === t.default), t.key);
    }
});

check('a font change loads its sheet; the system font loads nothing', () => {
    assert.match(String(fontUrl({ ...defaults(), bodyFont: 'Inter' })), /family=Inter/);
    assert.strictEqual(fontUrl({ ...defaults(), bodyFont: 'system', headingFont: 'system' }), null);
});

check('every full page loads the loader in <head>, straight after style.css', () => {
    const pages = readdirSync(root).filter((f) => f.endsWith('.html'));
    let n = 0;
    for (const f of pages) {
        const s = read(f);
        const link = s.match(/<link[^>]*href="[./]*style\.css[^"]*"[^>]*>/);
        if (!link) continue;
        n++;
        const after = s.slice(link.index! + link[0].length, link.index! + link[0].length + 80);
        assert.match(after, /^\s*<script src="\/site-theme\.js"><\/script>/, `${f} does not load site-theme.js after style.css`);
        assert.ok(s.indexOf('/site-theme.js') < s.indexOf('</head>'), `${f}: loader outside <head>`);
    }
    assert.ok(n >= 30, `only ${n} pages checked`);
});

check('the loader paints from cache first, then keeps current without a refresh', () => {
    const js = read('site-theme.js');
    assert.ok(js.indexOf("localStorage.getItem(STORE)") < js.indexOf('function refresh()'), 'cache is not painted first');
    assert.match(js, /new BroadcastChannel\('bms-site-theme'\)/);
    assert.match(js, /setInterval\(function \(\) \{ if \(document\.visibilityState === 'visible'\) refresh\(\); \}, POLL_MS\)/);
    assert.match(js, /addEventListener\('visibilitychange'/);
});

check('the public endpoint is CDN-cached briefly and never breaks a page', () => {
    const fn = read('netlify/functions/site-theme.ts');
    assert.match(fn, /'Netlify-CDN-Cache-Control': 'public, s-maxage=10/);
    assert.match(fn, /serving the default theme/);
    assert.match(fn, /hasPermission\(row\?\.role, 'platform_config'\)/);
    assert.match(fn, /action: 'site_theme_publish'/);
});

check('the admin page publishes through the endpoint and previews only itself', () => {
    const a = read('admin.html');
    assert.match(a, /id="sst-publish" class="btn-golive[^"]*">Set as Be More Swan standard<\/button>/);
    assert.match(a, /JSON\.stringify\(\{ action: 'publish', theme: _sst\.draft \}\)/);
    assert.match(a, /window\.SiteTheme\.preview\(SiteThemeCore\.themeCss\(_sst\.draft\)/);
    assert.match(a, /window\.SiteTheme && window\.SiteTheme\.published\(r\)/);
    assert.match(a, /view: 'site-styles'/);
});

check('a button border colour shows even on buttons with no border width', () => {
    const css = themeCss({ ...defaults(), btn_destructive_border: '#ff007f' });
    assert.match(css, /\.btn-destructive:not\(\.border\):not\(\.border-2\)\{outline:1px solid #ff007f;outline-offset:-1px\}/);
});

check('the link setting reaches styled links, hover included, and leaves .btn-* alone', () => {
    const css = themeCss({ ...defaults(), linkColor: '#0000ff', linkHoverColor: '#000088', linkUnderline: 'hover' });
    assert.match(css, /:is\(a,button\)\[class\*="underline"\]:not\(\[class\*="btn-"\]\)/);
    assert.match(css, /\[class\*="text-sky-"\]\):hover,\.prose a:hover\{color:#000088;text-decoration:underline/);
    assert.doesNotMatch(css, /\]:hover,\[class/, 'a :hover landed inside :is()');
});

check('the white-on-pink CTA is a real button type, used on every pink banner', () => {
    for (const f of ['input.css', 'style.css']) assert.match(read(f), /\.btn-inverse\s+\{ background-color: #ffffff; color: #ff007f;/, f);
    for (const f of ['blog.html', 'faq.html', 'contact.html', 'pricing.html', 'trust.html']) {
        assert.match(read(f), /class="btn-inverse /, `${f} lost its On-colour button`);
        assert.doesNotMatch(read(f), /bg-white text-emerald-700[^"]*hover:bg-emerald-50/, `${f} still hand-colours its banner button`);
    }
    assert.ok(TOKENS.some((t) => t.key === 'btn_inverse_bg'));
});

check('the home page CTAs are Primary, not Go live', () => {
    assert.doesNotMatch(read('index.html'), /class="btn-golive /);
});

console.log(`\n${passed} checks passed`);
