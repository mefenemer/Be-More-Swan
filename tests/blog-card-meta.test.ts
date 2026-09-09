// tests/blog-card-meta.test.ts
// The byline, the date and the tags — on the post page and on every card in a blog list.
//
// The half of this that matters most is the BYLINE, because it was wrong in public. Every
// published post declared `"author":{"@type":"Person","name":"AI: Lyra"}` in its structured data
// and printed "By AI: Lyra" under the headline, on live customer blogs. blog_posts.owner_label is
// an INTERNAL creator label; wiring it to the public byline leaked an internal name and asserted
// personhood for an assistant, in the one field search engines read as a factual claim.
//
// Run:  npx tsx tests/blog-card-meta.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHeadTags, renderBlogPage } from '../src/utils/blog-seo';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── the byline ──────────────────────────────────────────────────────────────
console.log('\nThe byline is the organisation\n');

const HEAD = {
    title: 'T', description: 'D',
    pageUrl: 'https://app.test/b/wgt_k/s', canonicalUrl: 'https://acme.com/blog/s',
    robots: 'index,follow', imageUrl: null, imageAlt: null,
    tags: ['ai', 'seo'],
    publishedAt: '2026-01-01T00:00:00.000Z', modifiedAt: null,
    authorName: 'Restorative Futures',
    publisher: { name: 'Restorative Futures', logoUrl: null },
    siteName: 'Restorative Futures',
};

check('⚠️ schema.org author is an Organization, not a Person', () => {
    // The live bug: "@type":"Person","name":"AI: Lyra". An assistant is not a person, and this is
    // the machine-readable field a search engine treats as a claim about the world.
    const head = buildHeadTags(HEAD);
    assert.ok(head.includes('"author":{"@type":"Organization","name":"Restorative Futures"}'),
        `author must be an Organization: ${(head.match(/"author":\{[^}]*\}/) || ['(absent)'])[0]}`);
    assert.ok(!/"author":\{"@type":"Person"/.test(head), 'no Person author may be emitted');
});

check('the visible byline and article:author carry the same name', () => {
    const head = buildHeadTags(HEAD);
    assert.ok(head.includes('<meta property="article:author" content="Restorative Futures">'));
    const page = renderBlogPage({
        ...HEAD, heading: 'T', bodyHtml: '<p>x</p>',
        aiAssisted: false, badgeEnabled: true, theme: null,
    } as Parameters<typeof renderBlogPage>[0]);
    assert.ok(page.includes('By Restorative Futures'), 'the reader must see the same name');
});

check('⚠️ the post page never sources its byline from owner_label', () => {
    // ownerLabel is "AI: Lyra" or a staff member's name — who inside the workspace drafted it.
    // That is not the public author, and AI involvement is disclosed by the transparency badge,
    // which is the mechanism actually designed for it.
    const page = readFileSync(join(root, 'netlify/functions/blog-page.ts'), 'utf8');
    const call = page.slice(landmark(page, 'const html = renderBlogPage({'), landmark(page, 'bodyHtml,'));
    assert.match(call, /authorName: org\?\.name \|\| null,/, 'the byline must be the organisation');
    assert.ok(!/authorName:\s*post\.ownerLabel/.test(page), 'owner_label must not reach the byline');
    // ⚠️ org.name, not siteName. siteName falls back to the literal string 'Blog' for og:site_name,
    // which as a byline reads "By Blog" — a plausible-looking wrong answer rather than no answer.
    assert.ok(!/authorName: siteName/.test(page), "siteName's 'Blog' fallback must not become a byline");
});

check('a byline is omitted rather than faked when there is no name', () => {
    const head = buildHeadTags({ ...HEAD, authorName: null });
    assert.ok(!head.includes('article:author'), 'no author meta without a name');
    assert.ok(!head.includes('"author"'), 'and no author in the structured data either');
});

check('the byline is escaped like everything else', () => {
    const head = buildHeadTags({ ...HEAD, authorName: 'Ac<me> & "Co"' });
    assert.ok(!/content="Ac<me>/.test(head), 'must not emit raw angle brackets into an attribute');
    assert.ok(head.includes('Ac&lt;me&gt; &amp; &quot;Co&quot;'));
});

// ── the list endpoint ───────────────────────────────────────────────────────
console.log('\nWhat the list endpoint serves\n');

const api = readFileSync(join(root, 'netlify/functions/widget-api.ts'), 'utf8');
const list = api.slice(landmark(api, "if (resource === 'posts' && !slug)"), landmark(api, "if (resource === 'posts' && slug)"));

check('⚠️ the card byline is the ORG name, not the widget\'s own name', () => {
    // widgetConfigs.name sits directly beside organisations.name in the same select and defaults
    // to "Default". Reaching for the wrong one puts the literal word "Default" under every
    // headline on the customer's blog.
    assert.match(list, /author: cfg\.orgName \|\| null/, 'the byline comes from the organisation');
    assert.ok(!/author: cfg\.name/.test(list), 'cfg.name is the widget label, not the publisher');
    assert.match(api, /orgName: organisations\.name/, 'and it is selected from the organisations table');
});

check('the byline costs no extra query', () => {
    // Joined into the config lookup that already runs on every request. A separate SELECT would
    // add a round trip to a CDN-cacheable endpoint for one string.
    assert.match(api, /\.leftJoin\(organisations, eq\(organisations\.id, widgetConfigs\.organisationId\)\)/);
});

check('date and tags are served on every card', () => {
    assert.match(list, /publishedAt: r\.publishedAt/);
    assert.match(list, /tags: r\.tags/);
});

// ── the widget's formatting, executed ───────────────────────────────────────
console.log('\nThe widget formatters, run from the real source\n');

const widget = readFileSync(join(root, 'widget.js'), 'utf8');

/** Lift the two formatters out of widget.js and run them, so behaviour is checked, not just wiring. */
function widgetFormatters() {
    const fmt = widget.slice(landmark(widget, 'function formatDate(iso)'), landmark(widget, '  var TAG_LIMIT'));
    const tags = widget.slice(landmark(widget, '  var TAG_LIMIT'), landmark(widget, '  // Remove the body\'s own leading <h1>.'));
    const esc = widget.slice(landmark(widget, 'function esc(v)'), landmark(widget, '  // A published date'));
    return new Function(`${esc}\n${fmt}\n${tags}\nreturn { formatDate: formatDate, tagsHtml: tagsHtml, TAG_LIMIT: TAG_LIMIT };`)() as {
        formatDate: (iso: unknown) => string;
        tagsHtml: (tags: unknown) => string;
        TAG_LIMIT: number;
    };
}

check('a date renders, and a broken one costs the line rather than the card', () => {
    const { formatDate } = widgetFormatters();
    assert.ok(formatDate('2026-09-05T10:00:00.000Z').length > 6, 'a real date must format to something');
    // "Invalid Date" printed under a headline is worse than no date at all.
    for (const bad of [null, undefined, '', 'not a date', {}, []]) {
        assert.equal(formatDate(bad), '', `must yield nothing for ${JSON.stringify(bad)}`);
    }
});

check('⚠️ tags are capped — a card is a summary, not a taxonomy', () => {
    const { tagsHtml, TAG_LIMIT } = widgetFormatters();
    const many = tagsHtml(['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal((many.match(/<li>/g) || []).length, TAG_LIMIT,
        'a post with twelve tags would otherwise push the excerpt off every row in the list');
});

check('tags survive contact with untrusted values', () => {
    // Tags are post metadata: not guaranteed strings, not guaranteed short, not guaranteed safe.
    const { tagsHtml } = widgetFormatters();
    assert.equal(tagsHtml([]), '', 'no tags must render no strip at all');
    assert.equal(tagsHtml(null), '');
    assert.equal(tagsHtml(['   ', '']), '', 'blank tags are not tags');
    const evil = tagsHtml(['<img src=x onerror=alert(1)>']);
    assert.ok(!evil.includes('<img'), `tag markup must be escaped: ${evil}`);
    assert.ok(evil.includes('&lt;img'));
    const long = tagsHtml(['x'.repeat(200)]);
    assert.ok(long.length < 120, 'an absurdly long tag must be trimmed, not rendered whole');
    assert.doesNotThrow(() => tagsHtml([null, undefined, 42, { a: 1 }]), 'non-strings must not throw');
});

// ── the card markup ─────────────────────────────────────────────────────────
console.log('\nThe card\n');

check('⚠️ each part is independently optional', () => {
    // A post with no tags must not leave an empty strip, and a missing date must not leave a
    // dangling separator — so the dot is built from the parts that exist.
    const fn = widget.slice(landmark(widget, 'function cardHtml(p)'), landmark(widget, 'function paintList()'));
    assert.match(fn, /\[p\.author, formatDate\(p\.publishedAt\)\]\.filter\(Boolean\)/,
        'the separator must be joined across present parts, never hard-coded');
    assert.match(fn, /meta\s*\?/, 'the meta line itself must be conditional');
});

check('the date is machine-readable as well as human-readable', () => {
    const fn = widget.slice(landmark(widget, 'function cardHtml(p)'), landmark(widget, 'function paintList()'));
    assert.match(fn, /<time datetime="/, 'a published date belongs in a <time datetime>');
});

check('the tag pills override the UA list styling', () => {
    // :host{all:initial} resets the shadow tree, but a <ul> still picks up discs and a 40px indent.
    assert.match(widget, /\.bms \.bms-tags\{[^}]*list-style:none/);
    assert.match(widget, /\.bms \.bms-tags\{[^}]*padding:0/);
});

// ── the crawler-visible list ────────────────────────────────────────────────
console.log('\nThe crawler-visible index\n');

check('the baked list carries the byline and tags too', () => {
    // widget.js hides this copy behind a shadow root, so this is what search engines read for
    // /blog and nothing else. Anything left out here is left out for them specifically.
    const build = readFileSync(join(root, 'scripts/build-seo-html.mjs'), 'utf8');
    const start = landmark(build, 'const cards = posts.map');
    const fn = build.slice(start, landmark(build, 'const payload =', start));
    assert.match(fn, /p\.author \? escHtml\(p\.author\)/, 'the byline must be baked in');
    assert.match(fn, /p\.tags\.slice\(0, 3\)/, 'and the tags, capped as on the card');
    assert.match(fn, /<time datetime=/, 'the date stays machine-readable');
});

console.log(`\n${passed} checks passed.`);
