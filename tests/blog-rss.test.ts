// tests/blog-rss.test.ts
// Locks the pure RSS 2.0 serialiser behind /api/widget/:key/rss (US 3.2 §A.4): escaping, the CDATA
// breakout guard, RFC-822 dates, guid stability, and the document shape. No network or DB.
// Run:  npx tsx tests/blog-rss.test.ts

import assert from 'node:assert';
import { buildRssFeed, emptyRssFeed, feedGuid, escXml, cdata, rfc822, type RssItemInput } from '../src/utils/blog-rss';

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const CHANNEL = {
    title: 'Acme Blog',
    link: 'https://acme.com',
    description: 'Latest posts from Acme Blog.',
    selfUrl: 'https://app.test/api/widget/wgt_k/rss',
    lastBuildDate: new Date('2026-08-18T09:00:00Z'),
};

function item(over: Partial<RssItemInput> = {}): RssItemInput {
    return {
        title: 'My Post',
        link: 'https://acme.com/blog/my-post',
        guid: feedGuid('wgt_k', 'my-post'),
        publishedAt: new Date('2026-08-18T09:00:00Z'),
        description: 'A short summary.',
        contentHtml: '<p>Hello</p>',
        tags: ['ai', 'marketing'],
        ...over,
    };
}

// ── escaping ────────────────────────────────────────────────────────────────
check('escXml escapes the full angle/amp/quote set, ampersand first', () => {
    assert.equal(escXml(`<a href="x">Tom & Jerry's</a>`),
        '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;');
});

check('escXml does not double-escape an existing entity', () => {
    // & is escaped once; the result must decode back to the original text, not to "&amp;amp;".
    assert.equal(escXml('a &amp; b'), 'a &amp;amp; b');
});

check('a hostile title cannot break out of its element', () => {
    const xml = buildRssFeed(CHANNEL, [item({ title: '</title><script>alert(1)</script>' })]);
    assert.ok(!xml.includes('<script>'), 'raw script tag must not survive into the feed');
    assert.ok(xml.includes('&lt;/title&gt;&lt;script&gt;'), 'must be escaped in place');
});

check('a hostile link cannot inject an attribute', () => {
    const xml = buildRssFeed(CHANNEL, [item({ link: 'https://x.test/"><item><title>spoof' })]);
    assert.ok(!xml.includes('"><item>'), 'quote/angle break-out must be escaped');
    assert.equal((xml.match(/<item>/g) || []).length, 1, 'no injected second item');
});

// ── CDATA breakout guard ────────────────────────────────────────────────────
check('CDATA guard splits a literal ]]> so the section cannot close early', () => {
    assert.equal(cdata('a ]]> b'), '<![CDATA[a ]]]]><![CDATA[> b]]>');
});

check('a body containing ]]> cannot inject markup into the feed', () => {
    const xml = buildRssFeed(CHANNEL, [item({ contentHtml: '<p>x</p>]]><script>alert(1)</script>' })]);
    // The only unescaped `]]>` sequences are the ones the guard itself emits; the script tag stays
    // sealed inside a CDATA section rather than becoming live markup in the document.
    assert.ok(xml.includes(']]]]><![CDATA[>'), 'breakout split applied');
    assert.ok(xml.trimEnd().endsWith('</rss>'), 'document still well-formed to the end');
});

check('content HTML is NOT escaped — it rides inside CDATA', () => {
    const xml = buildRssFeed(CHANNEL, [item({ contentHtml: '<p>Real <strong>markup</strong></p>' })]);
    assert.ok(xml.includes('<![CDATA[<p>Real <strong>markup</strong></p>]]>'));
});

// ── dates ───────────────────────────────────────────────────────────────────
check('pubDate is RFC-822, not ISO 8601', () => {
    assert.equal(rfc822(new Date('2026-08-18T09:00:00Z')), 'Tue, 18 Aug 2026 09:00:00 GMT');
    const xml = buildRssFeed(CHANNEL, [item()]);
    assert.ok(xml.includes('<pubDate>Tue, 18 Aug 2026 09:00:00 GMT</pubDate>'));
    assert.ok(!xml.includes('2026-08-18T09:00:00'), 'an ISO date would be invalid RSS');
});

check('a post with no publish date simply omits pubDate', () => {
    const xml = buildRssFeed({ ...CHANNEL, lastBuildDate: null }, [item({ publishedAt: null })]);
    assert.ok(!xml.includes('<pubDate>'));
    assert.ok(!xml.includes('<lastBuildDate>'));
});

// ── guid stability ──────────────────────────────────────────────────────────
check('guid is independent of the link, so a canonical change does not re-announce the archive', () => {
    // The day a customer fills in site_base_url + site_post_path, every canonical URL changes. If the
    // guid tracked the link, every subscriber's reader would resurface the entire back catalogue.
    const before = item({ link: 'https://app.test/b/wgt_k/my-post' });
    const after = item({ link: 'https://acme.com/blog/my-post' });
    assert.equal(before.guid, after.guid);
    assert.equal(before.guid, 'urn:bms:blog:wgt_k:my-post');
});

check('guid is marked isPermaLink="false" — the urn is not fetchable', () => {
    assert.ok(buildRssFeed(CHANNEL, [item()]).includes('<guid isPermaLink="false">urn:bms:blog:wgt_k:my-post</guid>'));
});

// ── document shape ──────────────────────────────────────────────────────────
check('declares the content: and atom: namespaces it actually uses', () => {
    const xml = buildRssFeed(CHANNEL, [item()]);
    assert.ok(xml.includes('xmlns:content="http://purl.org/rss/1.0/modules/content/"'));
    assert.ok(xml.includes('xmlns:atom="http://www.w3.org/2005/Atom"'));
    assert.ok(xml.includes('<atom:link href="https://app.test/api/widget/wgt_k/rss" rel="self" type="application/rss+xml"/>'));
});

check('carries the required channel elements', () => {
    const xml = buildRssFeed(CHANNEL, [item()]);
    for (const tag of ['<title>Acme Blog</title>', '<link>https://acme.com</link>', '<description>']) {
        assert.ok(xml.includes(tag), `channel missing ${tag}`);
    }
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});

check('tags become <category> elements, blank ones dropped', () => {
    const xml = buildRssFeed(CHANNEL, [item({ tags: ['ai', '', '  ', 'marketing'] })]);
    assert.equal((xml.match(/<category>/g) || []).length, 2);
    assert.ok(xml.includes('<category>ai</category>'));
});

check('an empty feed is still a well-formed document', () => {
    const xml = buildRssFeed({ ...CHANNEL, lastBuildDate: null }, []);
    assert.ok(xml.includes('<channel>') && xml.trimEnd().endsWith('</rss>'));
    assert.ok(!xml.includes('<item>'));
});

check('emptyRssFeed (unknown key) parses as a feed rather than an error page', () => {
    const xml = emptyRssFeed();
    assert.ok(xml.startsWith('<?xml'));
    assert.ok(xml.includes('<rss version="2.0">') && xml.includes('</rss>'));
    assert.ok(!xml.includes('<item>'));
});

check('optional per-item fields are omitted, not emitted empty', () => {
    const xml = buildRssFeed(CHANNEL, [item({ description: null, contentHtml: null, tags: [] })]);
    assert.ok(!xml.includes('<description></description>'));
    assert.ok(!xml.includes('<content:encoded>'));
    assert.ok(!xml.includes('<category>'));
    assert.ok(xml.includes('<title>My Post</title>'), 'the entry itself still renders');
});

check('a channel with no resolvable base URL omits atom:link entirely', () => {
    const xml = buildRssFeed({ ...CHANNEL, selfUrl: null }, [item()]);
    assert.ok(!xml.includes('<atom:link'));
});

console.log(`\n${passed} checks passed.`);
