// tests/post-link.test.ts
// The post's link, and the text a platform actually receives (src/utils/post-link.ts).
//
// Run:  npx tsx tests/post-link.test.ts
//
// Guards three things that are each a user-visible failure rather than a crash:
//   1. A link the user typed reaches the platform. link_url existed for months while every
//      publisher composed `[caption, hashtags]` — the field saved, the preview drew it, and
//      nothing ever sent it.
//   2. Only http(s) is ever stored or rendered. The composer and calendar put this value in an
//      `<a href>`; HTML-escaping does not disarm a `javascript:` URL.
//   3. The link is part of the priced/limited string. X charges per link and caps at 280 — a text
//      composed before the link is appended is billed and length-checked against the wrong post.
// Pure logic — no DB required.

import assert from 'node:assert';
import { normalisePostLink, postLinkLine, composePostText } from '../src/utils/post-link';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// ── normalisePostLink ───────────────────────────────────────────────────────────────────────────

check('accepts an ordinary https URL unchanged', () => {
    assert.equal(normalisePostLink('https://example.com/offer?a=1'), 'https://example.com/offer?a=1');
});

check('accepts http, and trims surrounding whitespace', () => {
    assert.equal(normalisePostLink('  http://example.com/x  '), 'http://example.com/x');
});

check('assumes https when no scheme was typed', () => {
    assert.equal(normalisePostLink('example.com/offer'), 'https://example.com/offer');
    assert.equal(normalisePostLink('www.example.co.uk'), 'https://www.example.co.uk');
});

check('a bad scheme is REJECTED, never repaired into https', () => {
    // The whole point: prefixing https:// onto "javascript:alert(1)" would produce a valid URL.
    assert.equal(normalisePostLink('javascript:alert(1)'), null);
    assert.equal(normalisePostLink('JavaScript:alert(1)'), null);
    assert.equal(normalisePostLink('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(normalisePostLink('vbscript:msgbox(1)'), null);
    assert.equal(normalisePostLink('file:///etc/passwd'), null);
    assert.equal(normalisePostLink('ftp://example.com/x'), null);
});

check('empty, whitespace and non-string values are null', () => {
    assert.equal(normalisePostLink(''), null);
    assert.equal(normalisePostLink('   '), null);
    assert.equal(normalisePostLink(null), null);
    assert.equal(normalisePostLink(undefined), null);
});

check('a value with internal whitespace is not a URL', () => {
    // "read this example.com" is someone typing a sentence into the link field.
    assert.equal(normalisePostLink('read this example.com'), null);
    assert.equal(normalisePostLink('https://example.com/a b'), null);
});

check('a host with no dot is refused', () => {
    assert.equal(normalisePostLink('https://localhost:3000/x'), null);
    assert.equal(normalisePostLink('notaurl'), null);
});

// ── postLinkLine ────────────────────────────────────────────────────────────────────────────────

check('bare URL when there is no call to action', () => {
    assert.equal(postLinkLine({ linkUrl: 'https://example.com' }), 'https://example.com');
});

check('call to action precedes the URL on one line', () => {
    assert.equal(
        postLinkLine({ linkUrl: 'example.com/blog', ctaText: 'Read the full story' }),
        'Read the full story https://example.com/blog',
    );
});

check('a multi-line CTA is flattened so the link stays on its own line', () => {
    assert.equal(
        postLinkLine({ linkUrl: 'https://example.com', ctaText: ' Read\n  the story \n' }),
        'Read the story https://example.com',
    );
});

check('null when there is no link', () => {
    assert.equal(postLinkLine({ caption: 'Hello', ctaText: 'Read more' }), null);
});

check('null when the caption already contains the URL — never published twice', () => {
    assert.equal(postLinkLine({ caption: 'Out now: https://example.com/offer', linkUrl: 'https://example.com/offer' }), null);
});

check('deduplicates against the RAW form the user typed, not just the normalised one', () => {
    // The caption says example.com; the link field says example.com; the normalised form has a
    // scheme the caption does not. Comparing only the normalised value would append it again.
    assert.equal(postLinkLine({ caption: 'More at example.com/offer', linkUrl: 'example.com/offer' }), null);
});

// ── composePostText ─────────────────────────────────────────────────────────────────────────────

check('caption, hashtags and link are three paragraphs, in that order', () => {
    assert.equal(
        composePostText({ caption: 'Cold brew season', hashtags: '#coffee', linkUrl: 'https://example.com', ctaText: 'Order' }),
        'Cold brew season\n\n#coffee\n\nOrder https://example.com',
    );
});

check('unchanged from the old [caption, hashtags] join when there is no link', () => {
    assert.equal(composePostText({ caption: 'Cold brew season', hashtags: '#coffee' }), 'Cold brew season\n\n#coffee');
    assert.equal(composePostText({ caption: 'Just words' }), 'Just words');
    assert.equal(composePostText({ hashtags: '#coffee' }), '#coffee');
});

check('a post with nothing to say composes to empty — the publishers refuse on this', () => {
    assert.equal(composePostText({}), '');
    assert.equal(composePostText({ caption: '   ', hashtags: '' }), '');
});

check('an unpublishable link is dropped rather than pasted in as text', () => {
    assert.equal(composePostText({ caption: 'Hi', linkUrl: 'javascript:alert(1)' }), 'Hi');
});

check('a link-only post is still a post', () => {
    assert.equal(composePostText({ linkUrl: 'https://example.com' }), 'https://example.com');
});

check('the composed length is what a platform limit must be checked against', () => {
    // The regression this guards: 270 chars of caption fits X, and did not once the link was
    // appended. The number the composer shows has to count the same string this returns.
    const caption = 'x'.repeat(260);
    const text = composePostText({ caption, linkUrl: 'https://example.com/a-fairly-long-path' });
    assert.ok(text.length > 280, `expected the link to push past X's limit, got ${text.length}`);
});

console.log(`\n${passed} check(s) passed.`);
