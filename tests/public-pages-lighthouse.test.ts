// tests/public-pages-lighthouse.test.ts
// What the Netlify Lighthouse run on the home page failed (2026-11-22), pinned so it stays fixed:
//   • PWA: public pages pointed at favicon/manifest.json — icons only, six of them missing from the
//     repo, no colours, no maskable icon — and set no theme-color.
//   • CLS 0.133: #nav-placeholder was 0px until the nav was fetched, so the page dropped 64px.
//   • Render-blocking: style.css @imports the Google font, so the font CSS waited for style.css.
//   • SEO: a link whose whole text was "more"; footer links 18px tall on phones.

import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pages = readdirSync(root).filter((f) => f.endsWith('.html'));

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('public pages use the public manifest, the workspace the app one, and all set a theme colour', () => {
    const withManifest = pages.filter((f) => /rel="manifest"/.test(read(f)));
    assert.ok(withManifest.length >= 40, `expected the public pages, found ${withManifest.length}`);
    for (const f of withManifest) {
        const html = read(f);
        const want = f === 'workspace.html' ? /rel="manifest" href="\/manifest\.webmanifest"/ : /rel="manifest" href="\/public\.webmanifest"/;
        assert.match(html, want, `${f} links the wrong manifest`);
        assert.match(html, /<meta name="theme-color" content="#[0-9a-fA-F]{6}">/, `${f} has no theme-color`);
    }
    assert.ok(!existsSync(join(root, 'favicon/manifest.json')), 'the icon-only manifest is back');
});

for (const file of ['manifest.webmanifest', 'public.webmanifest']) check(`${file} has what a splash screen and a maskable icon need`, () => {
    const m = JSON.parse(read(file));
    for (const icon of m.icons) assert.ok(existsSync(join(root, icon.src.replace(/^\//, ''))), `${icon.src} is missing`);
    assert.ok(m.theme_color && m.background_color);
    const has = (purpose: string, size: string) =>
        m.icons.some((i: { purpose?: string; sizes: string }) => (i.purpose || 'any') === purpose && i.sizes === size);
    assert.ok(has('any', '512x512'), 'no 512px icon');
    assert.ok(has('maskable', '512x512'), 'no 512px maskable icon');
    // android-chrome-512 runs to the edges — a launcher's circle mask cuts the swan's head off.
    assert.ok(!m.icons.some((i: { src: string; purpose?: string }) => i.purpose === 'maskable' && /android-chrome/.test(i.src)),
        'the edge-to-edge android-chrome icon is not safe to mask');
});

check('the public manifest cannot be installed', () => {
    // Owner, 2026-11-22: a logged-out visitor must not be offered "Install app" on the marketing
    // site — the installed icon would open a login screen. Chrome only offers install for
    // standalone / fullscreen / minimal-ui; "browser" opts out. The app manifest stays installable.
    assert.equal(JSON.parse(read('public.webmanifest')).display, 'browser');
    assert.equal(JSON.parse(read('manifest.webmanifest')).display, 'standalone');
});

check('the empty nav placeholder holds the nav\'s height until the nav arrives', () => {
    for (const css of ['input.css', 'style.css']) {
        assert.match(read(css), /#nav-placeholder:empty\s*\{\s*min-height:\s*4rem;\s*\}/, `${css} lost the reserve`);
    }
    assert.match(read('components/nav.html'), /flex justify-between h-16 items-center/,
        'the nav is no longer h-16 (4rem) — change the reserve in input.css + style.css to match');
});

check('pages preload the font style.css @imports', () => {
    assert.match(read('input.css'), /@import url\('https:\/\/fonts\.googleapis\.com\/css2\?family=Plus\+Jakarta\+Sans/,
        'the @import moved — the preloads below now fetch a font nothing uses');
    const html = read('index.html');
    const preload = html.indexOf('rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans');
    const sheet = html.indexOf('href="./style.css"');
    assert.ok(preload !== -1 && sheet !== -1 && preload < sheet, 'index.html must preload the font before style.css');
});

check('footer links are 48px rows on phones, and the home page has no bare "more" link', () => {
    const footer = read('components/footer.html');
    assert.match(footer, /\.bms-footer-links a \{[^}]*min-height: 48px/);
    assert.equal((footer.match(/class="bms-footer-links /g) || []).length, 2, 'both footer link lists');
    assert.ok(!/>\s*more\s*<\/a>/i.test(read('index.html')));
});

console.log(`\n${passed} passed`);
