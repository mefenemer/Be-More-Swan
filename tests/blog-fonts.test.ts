// tests/blog-fonts.test.ts
// Blog Studio ▸ Font family. Locks the one property that makes this feature real: a chosen font is
// also a FETCHED font. The picker shipped with three options and no webfont loading at all, so
// "System", "Serif" and "Inter" rendered identically on any machine without Inter installed —
// a setting that appeared to work and did nothing.
//
// Three surfaces read the stored theme and must agree on the exact strings: widget.js (the embed),
// blog-seo.ts (the server-rendered permalink), and the generated window.BlogFonts (the picker).
// save-widget-config validates against this same catalogue, so a drift here is a 400 on save.
//
// Run:  npx tsx tests/blog-fonts.test.ts

import assert from 'node:assert';
import {
    BLOG_FONTS, BLOG_FONT_CATEGORIES, DEFAULT_FONT_STACK,
    findBlogFont, googleFontUrl, fontUrlForStack, isAllowedFontUrl,
} from '../src/config/blog-fonts';
import { renderBlogPage } from '../src/utils/blog-seo';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const page = (theme: { fontFamily?: string | null } | null) => renderBlogPage({
    title: 'T', description: 'D', pageUrl: 'https://x/p', canonicalUrl: 'https://x/p',
    robots: 'index,follow', imageUrl: null, imageAlt: null, tags: [],
    publishedAt: null, modifiedAt: null, authorName: null,
    publisher: { name: 'Pub', logoUrl: null }, siteName: 'Site',
    bodyHtml: '<p>body</p>', aiAssisted: false, badgeEnabled: false, theme,
} as Parameters<typeof renderBlogPage>[0]);

console.log('\ncatalogue');

check('every font is uniquely identified by its stack — the stack IS the stored value', () => {
    const seen = new Set<string>();
    for (const f of BLOG_FONTS) {
        assert.ok(!seen.has(f.stack), `duplicate stack: ${f.stack}`);
        seen.add(f.stack);
    }
});

// A font-family that does not end in a generic family has no fallback at all: if the stylesheet is
// blocked (a customer CSP) or 404s, the reader gets the browser's default with no say from us.
check('every stack ends in a generic family, so a blocked stylesheet still degrades', () => {
    const generics = ['sans-serif', 'serif', 'monospace', 'cursive'];
    for (const f of BLOG_FONTS) {
        assert.ok(generics.some((g) => f.stack.trim().endsWith(g)), `no generic fallback: ${f.stack}`);
    }
});

check('every category is populated, so the picker renders no empty optgroup', () => {
    for (const c of BLOG_FONT_CATEGORIES) {
        assert.ok(BLOG_FONTS.some((f) => f.category === c), `empty category: ${c}`);
    }
    for (const f of BLOG_FONTS) {
        assert.ok(BLOG_FONT_CATEGORIES.includes(f.category), `stray category: ${f.category}`);
    }
});

// ⚠️ These exact strings are already stored in live widget_configs rows. Changing one silently
// orphans every blog that picked it: findBlogFont returns undefined, the validator rejects the save,
// and the picker selects nothing.
check('the three original options keep their historic stack strings verbatim', () => {
    for (const stack of ['system-ui, sans-serif', 'Georgia, serif', "'Inter', sans-serif"]) {
        assert.ok(findBlogFont(stack), `historic stack no longer resolves: ${stack}`);
    }
});

check('the default needs no download — a first paint must never wait on a network font', () => {
    assert.strictEqual(DEFAULT_FONT_STACK, BLOG_FONTS[0].stack);
    assert.strictEqual(fontUrlForStack(DEFAULT_FONT_STACK), null);
});

console.log('\nstylesheet URLs');

check('a Google family resolves to a css2 URL with display=swap', () => {
    const url = fontUrlForStack("'Inter', sans-serif");
    assert.strictEqual(url, 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');
});

check('multi-word families are +-encoded', () => {
    assert.ok(fontUrlForStack("'Playfair Display', serif")!.includes('family=Playfair+Display:'));
});

// Without 700 the browser synthesises bold by smearing the regular face — the tell-tale look of a
// half-configured webfont. Single-weight display faces are the deliberate exception: asking css2
// for a weight a family does not ship is a 400, and the stylesheet then never loads at all.
check('every multi-weight family requests 700, and single-weight faces request only 400', () => {
    for (const f of BLOG_FONTS) {
        const url = googleFontUrl(f);
        if (!url) continue;
        if (f.weights === '400') assert.ok(url.includes('wght@400&'), f.label);
        else assert.ok(url.includes('wght@400;700&'), `no bold weight: ${f.label}`);
    }
});

check('a system font resolves to no URL at all', () => {
    assert.strictEqual(fontUrlForStack('Georgia, serif'), null);
    assert.strictEqual(fontUrlForStack('system-ui, sans-serif'), null);
});

check('an unknown stack resolves to null rather than a guessed URL', () => {
    assert.strictEqual(fontUrlForStack('Comic Sans MS, cursive'), null);
    assert.strictEqual(findBlogFont('Comic Sans MS, cursive'), undefined);
    assert.strictEqual(findBlogFont(null), undefined);
});

console.log('\nisAllowedFontUrl — this value becomes a <link href> on a customer page');

check('absent is allowed; it simply means no download', () => {
    assert.strictEqual(isAllowedFontUrl(null), true);
    assert.strictEqual(isAllowedFontUrl(''), true);
});

check('every URL the catalogue can produce is allowed', () => {
    for (const f of BLOG_FONTS) {
        const url = googleFontUrl(f);
        if (url) assert.strictEqual(isAllowedFontUrl(url), true, f.label);
    }
});

// Exact-match, not a pattern. A regex over "fonts.googleapis.com" still admits an arbitrary query
// string, and an open redirect or a tracking parameter on a third-party page is not ours to ship.
check('a plausible-but-unlisted Google URL is rejected', () => {
    assert.strictEqual(
        isAllowedFontUrl('https://fonts.googleapis.com/css2?family=Evil:wght@400&display=swap'), false);
});

check('a non-Google URL is rejected outright', () => {
    assert.strictEqual(isAllowedFontUrl('https://evil.example/css2?family=Inter'), false);
    assert.strictEqual(isAllowedFontUrl('javascript:alert(1)'), false);
    assert.strictEqual(isAllowedFontUrl('//fonts.googleapis.com/css2?family=Inter'), false);
});

console.log('\nthe permalink honours the font (it previously ignored the theme entirely)');

check('a themed page links the stylesheet and uses the stack', () => {
    const html = page({ fontFamily: "'Lora', serif" });
    assert.ok(html.includes('href="https://fonts.googleapis.com/css2?family=Lora:wght@400;700&amp;display=swap"'), html.slice(0, 600));
    assert.ok(/font-family: 'Lora', serif;/.test(html), 'stack not applied');
    assert.ok(html.includes('rel="preconnect" href="https://fonts.gstatic.com" crossorigin'), 'no preconnect');
});

check('no theme falls back to the system stack and links nothing', () => {
    const html = page(null);
    assert.ok(!html.includes('fonts.googleapis.com'), 'linked a font it was never given');
    assert.ok(html.includes('-apple-system, BlinkMacSystemFont'), 'lost the default stack');
});

// The renderer re-validates instead of interpolating what it was handed: this string lands inside a
// <style> body, where an unescaped `}` closes the rule and opens a new one.
check('an unrecognised stored stack is ignored, not interpolated into the <style>', () => {
    const html = page({ fontFamily: 'x; } body { display: none } .z {' });
    assert.ok(!html.includes('display: none'), 'injected CSS reached the page');
    assert.ok(html.includes('-apple-system, BlinkMacSystemFont'), 'did not fall back');
});

console.log(`\n${passed} checks passed.\n`);
