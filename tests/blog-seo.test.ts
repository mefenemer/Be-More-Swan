// tests/blog-seo.test.ts
// Locks the pure crawler-facing metadata helpers (US 1.3): canonical resolution (incl. the
// blog-collapse guard), and the head-tag / JSON-LD builder's escaping + shape. No network or DB.
// Run:  npx tsx tests/blog-seo.test.ts

import assert from 'node:assert';
import { resolveCanonical, buildHeadTags, renderBlogPage, escHtml } from '../src/utils/blog-seo';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── resolveCanonical ────────────────────────────────────────────────────────
check('customer site: joins base + path with the slug', () => {
    assert.equal(
        resolveCanonical({ slug: 'my-post', siteBaseUrl: 'https://acme.com', sitePostPath: '/blog/{slug}' }),
        'https://acme.com/blog/my-post',
    );
});

check('customer site: strips trailing slashes on the base', () => {
    assert.equal(
        resolveCanonical({ slug: 'x', siteBaseUrl: 'https://acme.com//', sitePostPath: '/b/{slug}' }),
        'https://acme.com/b/x',
    );
});

check('COLLAPSE GUARD: a path without {slug} never canonicalises to the customer', () => {
    // Every widget post shares one hash-routed URL; canonicalising all posts to a slug-less path
    // would declare the whole blog duplicates of one page. Must fall back to the self-permalink.
    assert.equal(
        resolveCanonical({ slug: 'my-post', siteBaseUrl: 'https://acme.com', sitePostPath: '/blog', publicKey: 'wgt_k', baseUrl: 'https://app.test' }),
        'https://app.test/b/wgt_k/my-post',
    );
});

check('self-permalink fallback when the customer site is not configured', () => {
    assert.equal(
        resolveCanonical({ slug: 'my-post', publicKey: 'wgt_k', baseUrl: 'https://app.test/' }),
        'https://app.test/b/wgt_k/my-post',
    );
});

check('null when neither a customer site nor a base+key is available', () => {
    assert.equal(resolveCanonical({ slug: 'my-post' }), null);
});

check('null when there is no slug', () => {
    assert.equal(resolveCanonical({ slug: null, publicKey: 'wgt_k', baseUrl: 'https://app.test' }), null);
});

check('slug is URL-encoded in both branches', () => {
    assert.equal(
        resolveCanonical({ slug: 'a b', siteBaseUrl: 'https://acme.com', sitePostPath: '/p/{slug}' }),
        'https://acme.com/p/a%20b',
    );
    assert.equal(
        resolveCanonical({ slug: 'a b', publicKey: 'wgt_k', baseUrl: 'https://app.test' }),
        'https://app.test/b/wgt_k/a%20b',
    );
});

// ── escHtml ─────────────────────────────────────────────────────────────────
check('escHtml neutralises all five HTML-significant characters', () => {
    assert.equal(escHtml(`<a href="x" class='y'>&`), '&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;');
});

// ── buildHeadTags ───────────────────────────────────────────────────────────
const head = buildHeadTags({
    title: 'Hello <World>',
    description: 'A "great" post',
    pageUrl: 'https://app.test/b/wgt_k/hello',
    canonicalUrl: 'https://acme.com/blog/hello',
    robots: 'index,follow',
    imageUrl: 'https://cdn.test/img.png',
    imageAlt: 'Alt text',
    tags: ['ai', 'seo'],
    publishedAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    authorName: 'Jane',
    publisher: { name: 'Acme', logoUrl: null },
    siteName: 'Acme Blog',
});

check('emits the core SEO tags with the canonical link', () => {
    assert.ok(head.includes('<title>Hello &lt;World&gt;</title>'), 'escaped <title>');
    assert.ok(head.includes('<meta name="description" content="A &quot;great&quot; post">'));
    assert.ok(head.includes('<meta name="robots" content="index,follow">'));
    assert.ok(head.includes('<link rel="canonical" href="https://acme.com/blog/hello">'));
});

check('emits Open Graph + Twitter Card (large image when an image is present)', () => {
    assert.ok(head.includes('<meta property="og:type" content="article">'));
    assert.ok(head.includes('<meta property="og:image" content="https://cdn.test/img.png">'));
    assert.ok(head.includes('<meta property="og:url" content="https://app.test/b/wgt_k/hello">'));
    assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image">'));
});

check('twitter:card downgrades to summary with no image', () => {
    const noImg = buildHeadTags({
        title: 'T', description: 'D', pageUrl: 'https://app.test/b/k/s', canonicalUrl: null,
        robots: 'index,follow', imageUrl: null, imageAlt: null, tags: [], publishedAt: null,
        modifiedAt: null, authorName: null, publisher: { name: 'P', logoUrl: null }, siteName: 'S',
    });
    assert.ok(noImg.includes('<meta name="twitter:card" content="summary">'));
    assert.ok(!noImg.includes('rel="canonical"'), 'no canonical link when null');
    assert.ok(!noImg.includes('og:image'), 'no og:image when null');
});

check('emits a JSON-LD BlogPosting with author, publisher and dates', () => {
    const m = head.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(m, 'has a JSON-LD block');
    const ld = JSON.parse(m![1]);
    assert.equal(ld['@type'], 'BlogPosting');
    assert.equal(ld.author.name, 'Jane');
    assert.equal(ld.publisher.name, 'Acme');
    assert.equal(ld.datePublished, '2026-01-01T00:00:00.000Z');
    assert.equal(ld.dateModified, '2026-01-02T00:00:00.000Z');
    assert.equal(ld.mainEntityOfPage['@id'], 'https://acme.com/blog/hello');
});

check('JSON-LD cannot break out of its <script> element', () => {
    // A hostile value containing </script> must be neutralised (< → <) so it cannot close
    // the block early and inject markup.
    const evil = buildHeadTags({
        title: 'x</script><script>alert(1)</script>', description: 'd',
        pageUrl: 'https://app.test/b/k/s', canonicalUrl: null, robots: 'index,follow',
        imageUrl: null, imageAlt: null, tags: [], publishedAt: null, modifiedAt: null,
        authorName: null, publisher: { name: 'P', logoUrl: null }, siteName: 'S',
    });
    const block = evil.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(block, 'still exactly one ld+json block');
    assert.ok(!block![1].includes('</script>'), 'no raw </script> inside the JSON-LD');
    assert.ok(block![1].includes('\\u003c/script'), 'the < was escaped to \\u003c');
});

// ── renderBlogPage ──────────────────────────────────────────────────────────
check('renderBlogPage keeps the sanitised body as markup and shows the AI badge', () => {
    const html = renderBlogPage({
        title: 'Post', description: 'D', pageUrl: 'https://app.test/b/k/s', canonicalUrl: null,
        robots: 'index,follow', imageUrl: null, imageAlt: null, tags: ['ai'], publishedAt: null,
        modifiedAt: null, authorName: 'Jane', publisher: { name: 'P', logoUrl: null }, siteName: 'S',
        bodyHtml: '<p>Real <strong>markup</strong></p>', aiAssisted: true, badgeEnabled: true,
    });
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<article><p>Real <strong>markup</strong></p></article>'), 'body kept as markup');
    assert.ok(html.includes('AI assistance'), 'AI transparency badge shown');
});

check('renderBlogPage hides the AI badge when the widget badge is off', () => {
    const html = renderBlogPage({
        title: 'Post', description: 'D', pageUrl: 'https://app.test/b/k/s', canonicalUrl: null,
        robots: 'index,follow', imageUrl: null, imageAlt: null, tags: [], publishedAt: null,
        modifiedAt: null, authorName: null, publisher: { name: 'P', logoUrl: null }, siteName: 'S',
        bodyHtml: '<p>x</p>', aiAssisted: true, badgeEnabled: false,
    });
    assert.ok(!html.includes('AI assistance'));
});

console.log(`\n${passed} checks passed.`);
