// tests/blog-hosted-index.test.ts
// Locks the hosted blog INDEX at /b/:key — the full-page list a Wix site's "Blog" menu item can link
// to, instead of squeezing the widget into Wix's fixed-size Embed HTML box.
//
// Covers the pure route parser (and that it cannot collide with the post permalink), the netlify.toml
// rule ordering, the rendered document (head tags, links, paging, escaping), the post page's new
// "All posts" link, and the Blog Studio copy that hands the URL to the site owner.
//
// No network, no DB. Run:  npx tsx tests/blog-hosted-index.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlogIndexRoute, parseBlogRoute } from '../src/utils/blog-route';
import { renderBlogIndexPage, renderBlogPage, BlogIndexPageData } from '../src/utils/blog-seo';
import { BLOG_FONTS, googleFontUrl } from '../src/config/blog-fonts';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const root = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

// ── the route ───────────────────────────────────────────────────────────────
console.log('\nThe route\n');

check('/b/:key resolves to the index, with or without a trailing slash', () => {
    assert.deepEqual(parseBlogIndexRoute('/b/wgt_abc123'), { publicKey: 'wgt_abc123', pathname: '/b/wgt_abc123' });
    assert.deepEqual(parseBlogIndexRoute('/b/wgt_abc123/'), { publicKey: 'wgt_abc123', pathname: '/b/wgt_abc123' });
});

check('the index and the post permalink never both match one path', () => {
    for (const p of ['/b/wgt_k', '/b/wgt_k/', '/b/wgt_k/a-post', '/b/wgt_k/a-post/deeper', '/b/', '/b']) {
        const both = !!parseBlogIndexRoute(p) && !!parseBlogRoute(p);
        assert.ok(!both, `${p} matched both routes`);
    }
    assert.equal(parseBlogIndexRoute('/b/wgt_k/a-post'), null);
    assert.equal(parseBlogRoute('/b/wgt_k'), null);
    assert.equal(parseBlogRoute('/b/wgt_k/'), null, 'a trailing slash is the index, not a post with an empty slug');
});

check('no key, a malformed key, or a non-/b path is not an index', () => {
    assert.equal(parseBlogIndexRoute('/b/'), null);
    assert.equal(parseBlogIndexRoute('/b'), null);
    assert.doesNotThrow(() => parseBlogIndexRoute('/b/%E0%A4%A'));
    assert.equal(parseBlogIndexRoute('/b/%E0%A4%A'), null);
    assert.equal(parseBlogIndexRoute('/blog'), null);
    assert.equal(parseBlogIndexRoute('/x/b/wgt_k'), null, 'anchored at the start of the path');
});

// ── netlify.toml ────────────────────────────────────────────────────────────
console.log('\nnetlify.toml\n');

check('/b/:key reaches blog-page through the /b/* rule, AFTER the sitemap rule', () => {
    const toml = read('netlify.toml');
    const froms = [...toml.matchAll(/^\s*from\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
    const sitemap = froms.indexOf('/b/:key/sitemap.xml');
    const splat = froms.indexOf('/b/*');
    assert.notEqual(sitemap, -1, 'the sitemap rule is missing');
    assert.notEqual(splat, -1, 'the /b/* rule is missing');
    assert.ok(sitemap < splat, 'first match wins — the sitemap must precede the catch-all');
    const i = toml.indexOf('from = "/b/*"');
    assert.match(toml.slice(i, i + 120), /to = "\/\.netlify\/functions\/blog-page"/);
});

check('blog-page tries the index before the permalink, and 404s unknown keys', () => {
    const fn = read('netlify/functions/blog-page.ts');
    const idx = fn.indexOf('parseBlogIndexRoute(path)');
    const post = fn.indexOf('parseBlogRoute(path)');
    assert.notEqual(idx, -1);
    assert.notEqual(post, -1);
    assert.ok(idx < post);
    const render = fn.slice(fn.indexOf('async function renderIndex('), fn.indexOf('export default'));
    assert.match(render, /if \(!cfg \|\| cfg\.status !== 'active'\) return notFound\('blog'\)/);
    assert.match(render, /if \(cursorId && !posts\.length\) return notFound\('blog'\)/);
    assert.match(render, /robots: cursorId \|\| isFiltered\(filter\) \? 'noindex,follow' : 'index,follow'/);
});

// ── the document ────────────────────────────────────────────────────────────
console.log('\nThe rendered index\n');

function data(over: Partial<BlogIndexPageData> = {}): BlogIndexPageData {
    return {
        siteName: 'Acme Bakery',
        pageUrl: 'https://app.example/b/wgt_k',
        canonicalUrl: 'https://app.example/b/wgt_k',
        robots: 'index,follow',
        posts: [
            { title: 'Sourdough 101', slug: 'sourdough-101', excerpt: 'Start here.', publishedAt: '2026-10-01T09:00:00.000Z', imageUrl: 'https://cdn.example/a.jpg', imageAlt: 'A loaf' },
            { title: 'Rye, explained', slug: 'rye explained', excerpt: '', publishedAt: null, imageUrl: null, imageAlt: null },
        ],
        postHref: (s) => `/b/wgt_k/${encodeURIComponent(s)}`,
        olderHref: '/b/wgt_k?cursor=42',
        firstHref: null,
        homeUrl: 'https://acme.example',
        ...over,
    };
}

check('head carries title, description, robots, canonical and og:url', () => {
    const html = renderBlogIndexPage(data());
    assert.match(html, /<title>Blog \| Acme Bakery<\/title>/);
    assert.match(html, /<meta name="description" content="The latest posts from Acme Bakery\.">/);
    assert.match(html, /<meta name="robots" content="index,follow">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/app\.example\/b\/wgt_k">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/app\.example\/b\/wgt_k">/);
    assert.match(html, /<meta property="og:type" content="website">/);
    assert.match(html, /"@type":"Blog"/);
});

check('a later page carries what the caller decided: noindex,follow and its own URL', () => {
    const html = renderBlogIndexPage(data({
        pageUrl: 'https://app.example/b/wgt_k?cursor=42',
        canonicalUrl: 'https://app.example/b/wgt_k?cursor=42',
        robots: 'noindex,follow',
        firstHref: '/b/wgt_k',
        olderHref: null,
    }));
    assert.match(html, /<meta name="robots" content="noindex,follow">/);
    assert.match(html, /<link rel="canonical" href="https:\/\/app\.example\/b\/wgt_k\?cursor=42">/);
    assert.match(html, /<a href="\/b\/wgt_k">← Latest posts<\/a>/);
    assert.ok(!html.includes('Older posts'), 'the last page has no "older" link');
});

check('every card is a real, crawlable link to the permalink', () => {
    const html = renderBlogIndexPage(data());
    assert.match(html, /<h2><a href="\/b\/wgt_k\/sourdough-101">Sourdough 101<\/a><\/h2>/);
    assert.match(html, /<a href="\/b\/wgt_k\/rye%20explained">Rye, explained<\/a>/, 'slugs are encoded');
    assert.match(html, /<a rel="next" href="\/b\/wgt_k\?cursor=42">Older posts →<\/a>/);
});

check('thumbnail, date and excerpt render when present, and are omitted when not', () => {
    const html = renderBlogIndexPage(data());
    assert.match(html, /<img src="https:\/\/cdn\.example\/a\.jpg" alt="A loaf" loading="lazy">/);
    assert.match(html, /<time datetime="2026-10-01T09:00:00.000Z">1 October 2026<\/time>/);
    assert.match(html, /<p class="excerpt">Start here\.<\/p>/);
    assert.equal((html.match(/<img /g) || []).length, 1, 'the image-less post gets no broken <img>');
    assert.equal((html.match(/class="excerpt"/g) || []).length, 1, 'an empty excerpt renders nothing');
    // ...but a placeholder plate in the same box (owner, 2026-10-20), so the grid keeps one rhythm.
    assert.equal((html.match(/class="thumb__plate bms-plate"/g) || []).length, 1);
});

check('an empty blog says so, with no pager', () => {
    const html = renderBlogIndexPage(data({ posts: [], olderHref: null }));
    assert.match(html, /No posts yet/);
    assert.ok(!html.includes('class="posts"'));
    assert.ok(!html.includes('class="pager"'));
});

check('⚠️ every interpolated value is escaped', () => {
    const html = renderBlogIndexPage(data({
        siteName: '<script>alert(1)</script>',
        posts: [{ title: '"><img onerror=x>', slug: 's', excerpt: '<b>x</b>', publishedAt: null, imageUrl: 'https://cdn.example/a.jpg" onload="x', imageAlt: '"' }],
    }));
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(!html.includes('<img onerror'));
    assert.ok(!html.includes('<b>x</b>'));
    assert.ok(!html.includes('" onload="x'));
});

check('⚠️ only an http(s) site URL becomes the "Back to" link', () => {
    assert.match(renderBlogIndexPage(data()), /<a href="https:\/\/acme\.example\/">← Back to Acme Bakery<\/a>/);
    const js = renderBlogIndexPage(data({ homeUrl: 'javascript:alert(1)' }));
    assert.ok(!js.includes('javascript:'), 'a stored javascript: URL must never reach an href');
    assert.match(js, /<p class="back">Acme Bakery<\/p>/, 'the site name still shows without a link');
    assert.match(renderBlogIndexPage(data({ homeUrl: null })), /<p class="back">Acme Bakery<\/p>/);
});

check('the theme font applies to the index as it does to the permalink', () => {
    const font = BLOG_FONTS.find((f) => googleFontUrl(f));
    assert.ok(font, 'the catalogue has a Google font to test with');
    const html = renderBlogIndexPage(data({ theme: { fontFamily: font!.stack } }));
    assert.ok(html.includes(`font-family: ${font!.stack};`), 'the body uses the chosen stack');
    assert.ok(html.includes('<link rel="stylesheet" href="https://fonts.googleapis.com/'), 'and loads its stylesheet');
    // Only catalogue fonts are honoured — anything else renders exactly as no theme at all.
    const junk = renderBlogIndexPage(data({ theme: { fontFamily: '}</style><script>x</script>' } }));
    assert.equal(junk, renderBlogIndexPage(data()));
});

// ── the post page links back ────────────────────────────────────────────────
console.log('\nThe permalink\n');

const postBase = {
    title: 'T', description: 'D', pageUrl: 'https://app.example/b/wgt_k/t', canonicalUrl: null,
    robots: 'index,follow', imageUrl: null, imageAlt: null, tags: [], publishedAt: null, modifiedAt: null,
    authorName: null, publisher: { name: 'Acme', logoUrl: null }, siteName: 'Acme',
    bodyHtml: '<p>x</p>', aiAssisted: false, badgeEnabled: false,
};

check('a post links back to its index; without indexUrl it renders no link', () => {
    assert.match(renderBlogPage({ ...postBase, indexUrl: '/b/wgt_k' }), /<p class="back"><a href="\/b\/wgt_k">← All posts<\/a><\/p>/);
    assert.ok(!renderBlogPage(postBase).includes('All posts'));
});

check('blog-page sends /blog posts back to /blog and tenant posts to /b/:key', () => {
    const fn = read('netlify/functions/blog-page.ts');
    assert.match(fn, /indexUrl: route\.pathname\.startsWith\('\/blog\/'\) \? '\/blog' : `\/b\/\$\{encodeURIComponent\(publicKey\)\}`/);
});

// ── Blog Studio ─────────────────────────────────────────────────────────────
console.log('\nBlog Studio\n');

check('the widget section offers the index URL as the Blog menu link, with a copy button', () => {
    const js = read('src/components/blog-studio-modal.js');
    assert.ok(js.includes('id="bs-index-url"'), 'the URL box is missing');
    assert.ok(js.includes('id="bs-index-copy"'), 'the copy button is missing');
    assert.ok(js.includes("wireCopy('bs-index-copy', 'bs-index-url')"), 'the copy button is not wired');
    assert.ok(js.includes("el('bs-index-url').textContent = location.origin + '/b/' + cfg.publicKey"));
    assert.match(js, /point your site\\u2019s Blog menu item at this link/);
});

console.log(`\n${passed} checks passed.`);
