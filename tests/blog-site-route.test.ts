// tests/blog-site-route.test.ts
// Locks the /blog/:slug route on the marketing domain: the pure path parser, the netlify.toml
// redirect ORDERING (first match wins — the trap this file has sprung twice already), the widget
// key drift guard between source and blog.html, the engagement beacon now emitted by the
// server-rendered page, and the widget's opt-in linked-card mode.
//
// Background: prod's widget config sets site_base_url + site_post_path = "/blog/{slug}", so
// resolveCanonical() had every published post declaring a canonical at bemoreswan.com/blog/<slug> —
// a path nothing served. This route is what makes that declaration true.
//
// No network, no DB. Run:  npx tsx tests/blog-site-route.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBlogRoute } from '../src/utils/blog-route';
import { SITE_BLOG_WIDGET_KEY, SITE_BLOG_POST_PATH } from '../src/config/site-blog';
import { renderBlogPage } from '../src/utils/blog-seo';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const root = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

// ── the pure route parser ───────────────────────────────────────────────────
check('/b/:key/:slug still resolves, key from the URL', () => {
    const r = parseBlogRoute('/b/wgt_abc123/my-first-post');
    assert.deepEqual(r, {
        publicKey: 'wgt_abc123',
        slug: 'my-first-post',
        pathname: '/b/wgt_abc123/my-first-post',
    });
});

check('/blog/:slug resolves to OUR widget key, which is not in the URL', () => {
    const r = parseBlogRoute('/blog/my-first-post');
    assert.equal(r?.publicKey, SITE_BLOG_WIDGET_KEY);
    assert.equal(r?.slug, 'my-first-post');
    assert.equal(r?.pathname, '/blog/my-first-post');
});

check('a trailing slash on /blog/:slug is the same post, not a miss', () => {
    assert.equal(parseBlogRoute('/blog/my-post/')?.slug, 'my-post');
});

check('a percent-encoded slug is decoded once, and re-encoded for og:url', () => {
    const r = parseBlogRoute('/blog/caf%C3%A9-culture');
    assert.equal(r?.slug, 'café-culture');
    assert.equal(r?.pathname, '/blog/caf%C3%A9-culture');
});

check('MALFORMED percent-encoding is a miss, not a thrown 500', () => {
    // decodeURIComponent('%E0%A4%A') throws. On a public crawler-facing route that must 404.
    assert.doesNotThrow(() => parseBlogRoute('/blog/%E0%A4%A'));
    assert.equal(parseBlogRoute('/blog/%E0%A4%A'), null);
    assert.equal(parseBlogRoute('/b/wgt_k/%E0%A4%A'), null);
});

check('a DEEPER path under /blog is not silently truncated to its first segment', () => {
    // The splat form would have answered this with the "a" post. It must fall through to a 404.
    assert.equal(parseBlogRoute('/blog/a/b'), null);
});

check('/blog itself is not a post — the index must keep serving', () => {
    assert.equal(parseBlogRoute('/blog'), null);
    assert.equal(parseBlogRoute('/blog/'), null);
});

check('an unrelated path resolves to nothing', () => {
    assert.equal(parseBlogRoute('/blog-studio.html'), null);
    assert.equal(parseBlogRoute('/pricing.html'), null);
    assert.equal(parseBlogRoute('/b/wgt_k'), null, 'a key with no slug is not a post');
});

// ── netlify.toml: first match wins ──────────────────────────────────────────
const toml = read('netlify.toml');

// Netlify matches whole path SEGMENTS: "*" swallows the rest, ":param" matches exactly one segment,
// and a host-absolute `from` only applies to that host.
function ruleMatches(from: string, path: string): boolean {
    if (/^https?:\/\//.test(from)) return false;
    const f = from.split('/').filter(Boolean);
    const p = path.split('/').filter(Boolean);
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '*') return true;
        if (i >= p.length) return false;
        if (f[i].startsWith(':')) continue;
        if (f[i] !== p[i]) return false;
    }
    return f.length === p.length;
}

const froms = [...toml.matchAll(/^\s*from\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
assert.ok(froms.length > 10, `expected to parse many redirect rules, parsed ${froms.length}`);

function firstMatch(path: string): string | undefined {
    return froms.find((f) => ruleMatches(f, path));
}

check('the FIRST rule matching /blog/<slug> is the new route, nothing above shadows it', () => {
    assert.equal(firstMatch('/blog/my-post'), '/blog/:slug');
});

check('"/b/*" does NOT swallow /blog/<slug> — "b" is not the segment "blog"', () => {
    assert.ok(!ruleMatches('/b/*', '/blog/my-post'));
});

check('the new rule does not shadow the /blog index or /blog.html', () => {
    assert.notEqual(firstMatch('/blog'), '/blog:slug');
    assert.equal(firstMatch('/blog'), undefined, '/blog must fall through to blog.html');
    assert.equal(firstMatch('/blog.html'), undefined);
});

check('inserting it did not reorder the two rules that already depended on order', () => {
    assert.equal(firstMatch('/b/wgt_k/sitemap.xml'), '/b/:key/sitemap.xml', 'sitemap must precede /b/*');
    assert.equal(firstMatch('/b/wgt_k/some-post'), '/b/*');
    assert.equal(firstMatch('/api/widget/wgt_k/rss'), '/api/widget/:key/rss', 'rss must precede the widget catch-all');
    assert.equal(firstMatch('/api/widget/wgt_k/posts'), '/api/widget/*');
});

check('the rule is a REWRITE to blog-page, and uses :slug rather than a splat', () => {
    const i = toml.indexOf('from = "/blog/:slug"');
    assert.notEqual(i, -1, 'the /blog/:slug rule is missing from netlify.toml');
    const block = toml.slice(i, i + 200);
    assert.ok(block.includes('to = "/.netlify/functions/blog-page"'), `rule does not target blog-page:\n${block}`);
    assert.ok(/status\s*=\s*200/.test(block), `rule is not a 200 rewrite:\n${block}`);
    assert.ok(!toml.includes('from = "/blog/*"'), 'the splat form would swallow deeper paths');
});

// ── the widget key must not drift between the server and blog.html ──────────
check('blog.html carries exactly the key in src/config/site-blog.ts', () => {
    const html = read('blog.html');
    const m = html.match(/BMS_BLOG_WIDGET_KEY\s*=\s*'([^']+)'/);
    assert.ok(m, 'BMS_BLOG_WIDGET_KEY not found in blog.html — did it get renamed?');
    assert.equal(m![1], SITE_BLOG_WIDGET_KEY,
        'blog.html and src/config/site-blog.ts disagree: the page and the route would serve different orgs');
});

check('blog.html links its cards at the path SITE_BLOG_POST_PATH declares', () => {
    const html = read('blog.html');
    const m = html.match(/data-bms-post-url'\s*,\s*'([^']+)'/);
    assert.ok(m, 'blog.html no longer sets data-bms-post-url — the index went back to hash links');
    assert.equal(m![1], SITE_BLOG_POST_PATH);
});

check('SITE_BLOG_POST_PATH and the netlify rule describe the same URL', () => {
    assert.equal(SITE_BLOG_POST_PATH.replace('{slug}', 'x'), '/blog/x');
    assert.equal(parseBlogRoute(SITE_BLOG_POST_PATH.replace('{slug}', 'x'))?.slug, 'x');
});

// ── the engagement beacon on the server-rendered page ───────────────────────
const BASE = {
    title: 'A Post', description: 'd', pageUrl: 'https://bemoreswan.com/blog/a-post',
    canonicalUrl: 'https://bemoreswan.com/blog/a-post', robots: 'index,follow',
    imageUrl: null, imageAlt: null, tags: [], publishedAt: null, modifiedAt: null,
    authorName: null, publisher: { name: 'BMS', logoUrl: null }, siteName: 'BMS',
    bodyHtml: '<p>hi</p>', aiAssisted: false, badgeEnabled: false,
};

check('with engagement set, the page posts to the SAME endpoint the widget does', () => {
    const html = renderBlogPage({ ...BASE, engagement: { publicKey: 'wgt_k', slug: 'a-post' } });
    assert.ok(html.includes('/.netlify/functions/widget-ab-beacon'), 'beacon endpoint missing');
    assert.ok(html.includes('navigator.sendBeacon'), 'no sendBeacon call');
});

check('the beacon payload uses the field names widget-ab-beacon.ts actually reads', () => {
    const html = renderBlogPage({ ...BASE, engagement: { publicKey: 'wgt_k', slug: 'a-post' } });
    const server = read('netlify/functions/widget-ab-beacon.ts');
    // A field renamed on one side stops counting on the other, silently — the metric just drifts down.
    for (const field of ['publicKey', 'slug', 'dwellMs', 'scrollPct', 'engaged']) {
        assert.ok(html.includes(field + ':'), `rendered beacon omits ${field}`);
        assert.ok(server.includes(field), `widget-ab-beacon.ts no longer reads ${field}`);
    }
});

check('without engagement, no beacon is emitted at all', () => {
    const html = renderBlogPage({ ...BASE });
    assert.ok(!html.includes('widget-ab-beacon'), 'beacon must be absent, not present-and-disabled');
    assert.ok(!html.includes('sendBeacon'));
    const blank = renderBlogPage({ ...BASE, engagement: { publicKey: '', slug: 'a-post' } });
    assert.ok(!blank.includes('widget-ab-beacon'), 'an empty key must not produce a beacon');
});

check('a hostile slug cannot break out of the beacon <script>', () => {
    const html = renderBlogPage({
        ...BASE,
        engagement: { publicKey: 'wgt_k', slug: '</script><script>alert(1)</script>' },
    });
    assert.ok(!html.includes('<script>alert(1)'), 'raw injected script survived into the document');
    assert.ok(html.includes('\\u003c/script'), 'the angle bracket should be unicode-escaped in place');
});

// ── widget.js: opt-in linked cards ──────────────────────────────────────────
const widget = read('widget.js');

check('widget.js reads data-bms-post-url and renders anchors when it is set', () => {
    assert.ok(widget.includes("getAttribute('data-bms-post-url')"), 'attribute never read');
    assert.ok(widget.includes("'<a class=\"bms-card\" href=\"'"), 'no anchor card branch');
    assert.ok(widget.includes('a.bms-card{display:block;color:inherit;text-decoration:none;}'),
        'the accent-colour rule would repaint the whole linked card');
});

check('the click-to-navigate handler binds to DIV cards only', () => {
    // Binding to '.bms-card' would attach a hash-navigation handler to the anchors too, and the
    // widget would swap innerHTML underneath a link that is also navigating away.
    assert.ok(widget.includes("querySelectorAll('div.bms-card')"),
        'handler must not bind to anchor cards');
});

check('an unsafe or placeholder-less data-bms-post-url is rejected, not turned into an href', () => {
    assert.ok(widget.includes("indexOf('{slug}') !== -1"), 'missing {slug} must disable the feature');
    // The guard is a rooted-path-or-http(s) test; a javascript: URL must not satisfy it.
    const guard = /^(\/(?!\/)|https?:\/\/)/;
    assert.ok(!guard.test('javascript:alert(1)'));
    assert.ok(!guard.test('//evil.test/{slug}'), 'protocol-relative must not pass');
    assert.ok(guard.test('/blog/{slug}'));
    assert.ok(guard.test('https://acme.com/blog/{slug}'));
});

// ── the page heading ────────────────────────────────────────────────────────
// published_payload.html is a render of the post's Markdown and so opens with its own "# Title"
// <h1>. The document also rendered one from the SEO meta title, which put TWO <h1> elements on
// every permalink — the site-suffixed SEO string first, the real headline second.
const BODY_WITH_H1 = '<h1>The Real Headline</h1>\n<p>Opening paragraph.</p><h2>A section</h2>';

check('exactly one <h1>, and it is the post title — not the SEO meta title', () => {
    const html = renderBlogPage({
        ...BASE,
        title: 'Safe Content Benchmark for Brand Integrity | Be More Swan',
        heading: 'The Real Headline',
        bodyHtml: BODY_WITH_H1,
    });
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'a document must not carry two <h1>s');
    assert.ok(html.includes('<h1>The Real Headline</h1>'));
    assert.ok(!/<h1>[^<]*\| Be More Swan/.test(html), 'the site suffix must not appear as the page heading');
});

check('the SEO title still owns <title>, og:title and the JSON-LD', () => {
    const html = renderBlogPage({
        ...BASE,
        title: 'SEO Title | Be More Swan',
        heading: 'The Real Headline',
        bodyHtml: BODY_WITH_H1,
    });
    assert.ok(html.includes('<title>SEO Title | Be More Swan</title>'));
    assert.ok(html.includes('content="SEO Title | Be More Swan"'), 'og/twitter title unchanged');
});

check('a body with NO leading h1 still gets a heading', () => {
    const html = renderBlogPage({ ...BASE, heading: 'The Real Headline', bodyHtml: '<p>Straight into prose.</p>' });
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
    assert.ok(html.includes('<h1>The Real Headline</h1>'));
    assert.ok(html.includes('<p>Straight into prose.</p>'), 'body must survive untouched');
});

check('only a LEADING h1 is dropped — one used mid-article survives', () => {
    const html = renderBlogPage({
        ...BASE, heading: 'Top', bodyHtml: '<p>Intro.</p><h1>Mid-article</h1><p>More.</p>',
    });
    assert.ok(html.includes('<h1>Mid-article</h1>'), 'a non-leading h1 is the author\'s, leave it');
    assert.ok(html.includes('<h1>Top</h1>'));
});

check('heading falls back to the title when none is given', () => {
    const html = renderBlogPage({ ...BASE, title: 'Only A Title', bodyHtml: '<p>x</p>' });
    assert.ok(html.includes('<h1>Only A Title</h1>'));
});

check('a hostile heading is escaped', () => {
    const html = renderBlogPage({ ...BASE, heading: '<img src=x onerror=alert(1)>', bodyHtml: '<p>x</p>' });
    assert.ok(!html.includes('<img src=x'), 'heading must be escaped, it is not sanitised markup');
    assert.ok(html.includes('&lt;img src=x'));
});

check('one read sends one beacon, on BOTH the widget and the server page', () => {
    // A reader who tabs away and later closes the page fires visibilitychange AND pagehide. Without
    // a guard that is two views for one read — which inflates blog_engagement_stats.views and so
    // DEFLATES Average Read Time, because the KPI divides summed dwell by views.
    assert.ok(/function flush\(\)\s*\{\s*if \(sent\) return;\s*sent = true;/.test(widget),
        'widget.js flush() must be idempotent');
    const page = renderBlogPage({ ...BASE, engagement: { publicKey: 'wgt_k', slug: 'a-post' } });
    assert.ok(/if \(sent\) return;/.test(page), 'the server page beacon must be idempotent too');
});

// ── widget.js carries the same heading fix ──────────────────────────────────
check('the widget strips the body\'s leading h1 instead of stacking two headlines', () => {
    assert.ok(widget.includes('function stripLeadingH1(html)'), 'widget.js lost stripLeadingH1');
    assert.ok(widget.includes('stripLeadingH1(payload.html)'),
        'the helper must actually be applied to the body, not just defined');
    assert.ok(!/\(payload\.html \|\| ''\) \+/.test(widget), 'the raw body is being rendered again');
});

check('the widget heading is the post title, and a live A/B variant still wins', () => {
    assert.ok(widget.includes("variant && variant.h1 ? variant.h1 : (post.title || post.metaTitle)"),
        'headline test must win; the fallback must be the post title, not the SEO metaTitle');
    assert.ok(!widget.includes('(post.metaTitle || post.title)'),
        'the SEO meta title must not be the visible heading');
});

check('both strip helpers use the SAME pattern — they must not drift apart', () => {
    // One is the server permalink, one is the customer embed. A pattern fixed on one side only is
    // how the duplicate heading comes back on the surface nobody re-checked.
    const seo = read('src/utils/blog-seo.ts');
    const pattern = String.raw`/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i`;
    assert.ok(seo.includes(pattern), `blog-seo.ts strip pattern changed shape:\n${pattern}`);
    assert.ok(widget.includes(pattern), `widget.js strip pattern changed shape:\n${pattern}`);
});

console.log(`\n${passed} checks passed.`);
