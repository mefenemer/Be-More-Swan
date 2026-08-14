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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalisePostLink, postLinkLine, composePostText, type PostLinkFields } from '../src/utils/post-link';
import { landmark } from './landmark';

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

// ── The composer's mirror of this rule ──────────────────────────────────────────────────────────
// workspace.html cannot import src/, so it carries its own copy of postLinkLine (_pcePostLinkLine)
// to draw the link on the mock-up. The two must agree: the preview claims to show what will be
// published, and the link step's echo says "Added to the end of your post: …". They disagreed —
// the mock-up rendered the CTA ALONE as the anchor text, so a post promising
// "Buy Now https://example.com" previewed as a bare "Buy Now" — which is what this pins.

/** Pull a function out of workspace.html and make it callable here. */
function clientFn(names: string[]): (post: unknown) => string | null {
    const html = readFileSync(path.join(import.meta.dirname, '..', 'workspace.html'), 'utf8');
    const bodies = names.map(name => {
        const start = html.indexOf(`function ${name}(`);
        if (start < 0) throw new Error(`${name} not found in workspace.html`);
        let depth = 0;
        for (let j = html.indexOf('{', start); j < html.length; j++) {
            if (html[j] === '{') depth++;
            else if (html[j] === '}') { depth--; if (depth === 0) return html.slice(start, j + 1); }
        }
        throw new Error(`unbalanced ${name}`);
    });
    return new Function(`${bodies.join('\n')}\nreturn ${names[names.length - 1]};`)() as (p: unknown) => string | null;
}

const clientLinkLine = clientFn(['_pceNormaliseLink', '_pcePostLinkLine']);

check('the composer draws exactly the line the publishers append', () => {
    const cases: PostLinkFields[] = [
        { caption: 'Autumn menu is here', linkUrl: 'https://www.somepage.com', ctaText: 'Buy Now' },
        { caption: 'Autumn menu is here', linkUrl: 'https://www.somepage.com', ctaText: null },
        { caption: 'Autumn menu is here', linkUrl: 'somepage.com', ctaText: 'Buy Now' },
        // Already in the words — the publisher does not append it, so the preview must not draw it.
        { caption: 'Order at https://www.somepage.com today', linkUrl: 'https://www.somepage.com', ctaText: 'Buy Now' },
        { caption: 'Order at somepage.com today', linkUrl: 'somepage.com', ctaText: 'Buy Now' },
        // Never publishable, never rendered as an anchor.
        { caption: 'Hi', linkUrl: 'javascript:alert(1)', ctaText: 'Tap' },
        { caption: 'Hi', linkUrl: '', ctaText: 'Tap' },
        { caption: 'Hi', linkUrl: null, ctaText: null },
        // A CTA is a label: newlines in it would split the link onto its own line.
        { caption: 'Hi', linkUrl: 'https://example.com', ctaText: 'Read\n  the  story' },
    ];
    for (const c of cases) {
        assert.strictEqual(clientLinkLine(c), postLinkLine(c),
            `preview and publish disagree for ${JSON.stringify(c)}`);
    }
});

check('a CTA is only ever shown with its URL, never on its own', () => {
    // The exact shape of the bug: a CTA with a link must render both.
    const line = clientLinkLine({ caption: 'x', linkUrl: 'https://www.somepage.com', ctaText: 'Buy Now' });
    assert.strictEqual(line, 'Buy Now https://www.somepage.com');
    assert.ok(line!.includes('https://www.somepage.com'), 'the URL is half of what gets published');
});

check('the link step saves itself, since its rail step has no Save button', () => {
    // "Save changes" lives in the CAPTION block; the rail mounts #pce-link-block into its own step
    // and does not bring that button with it. Without a save on blur the echo described a line that
    // was never written, never previewed and never published.
    const html = readFileSync(path.join(import.meta.dirname, '..', 'workspace.html'), 'utf8');
    const block = html.slice(landmark(html, '<div id="pce-link-block"'), landmark(html, '<!-- ── "Write with'));
    assert.match(block, /id="post-review-link-url"[\s\S]*?onblur="[^"]*_pceSaveLinkFields\(\)"/,
        'the link field must commit on blur');
    assert.match(block, /id="post-review-cta"[\s\S]*?onblur="[^"]*_pceSaveLinkFields\(\)"/,
        'so must the call to action');
    // And re-seeding must not eat what is being typed in the field the cursor just moved to.
    assert.match(html, /if \(el && document\.activeElement !== el\) el\.value = value;/,
        '_pceFillCaption must skip the focused field');
});

console.log(`\n${passed} check(s) passed.`);
