// tests/blog-media-directives.test.ts
// Blog Media Composition — locks the `:::media` / `::::columns` directive contract.
// See docs/blog-media-composition-plan.md §3.
//
// This file is HOSTILE-INPUT FIRST by design. renderMarkdown's output is frozen into
// blog_posts.published_payload and served by the widget onto THIRD-PARTY customer domains, so a
// stored-XSS here executes on someone else's site. The allowlist widening that let video/audio/div
// through (plan §3.4) ships with these tests, not after them.
//
// Run:  npx tsx tests/blog-media-directives.test.ts

import assert from 'node:assert';
import { marked } from 'marked';
import { renderMarkdown } from '../src/utils/markdown-render';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BmsDirectives = require('../src/lib/marked-bms-directives.js');

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

// ── The asset:// invariant (plan §1) ──────────────────────────────────────────────────────────
// The single most important property in the epic: presigned R2 URLs expire and the payload is
// immutable + CDN-cached, so a baked-in src yields posts whose media dies hours after publish.

console.log('\nasset:// indirection');

check('plain markdown image → src-less data-bms-asset', () => {
    const html = renderMarkdown('![a cat](asset://42)');
    assert.match(html, /data-bms-asset="42"/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
});

check(':::media image → src-less data-bms-asset', () => {
    const html = renderMarkdown(':::media{asset=42 type=image}');
    assert.match(html, /<img[^>]*data-bms-asset="42"/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
});

check(':::media video → src-less <video controls>, never autoplay', () => {
    const html = renderMarkdown(':::media{asset=7 type=video}');
    assert.match(html, /<video[^>]*data-bms-asset="7"/);
    assert.match(html, /controls/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
    assert.ok(!/autoplay/i.test(html), 'autoplay must never survive');
});

check(':::media audio → src-less <audio controls>', () => {
    const html = renderMarkdown(':::media{asset=9 type=audio}');
    assert.match(html, /<audio[^>]*data-bms-asset="9"/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
});

check('real https image URL still passes through (Pexels hotlink)', () => {
    const html = renderMarkdown('![x](https://images.pexels.com/p/1.jpg)');
    assert.match(html, /src="https:\/\/images\.pexels\.com\/p\/1\.jpg"/);
});

// ── Hostile input (plan §3.4) ─────────────────────────────────────────────────────────────────

console.log('\nhostile input');

check('script tag is stripped', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assert.ok(!/<script/i.test(html));
});

check('directive cannot inject an event handler via an attribute', () => {
    const html = renderMarkdown(':::media{asset=1 type=video onerror=alert(1)}');
    assert.ok(!/onerror/i.test(html), 'unknown directive attrs must be dropped, not emitted');
});

check('directive cannot break out of the attribute quote', () => {
    const html = renderMarkdown(':::media{asset=1 type=video caption="a\\" onload=\\"alert(1)"}');
    assert.ok(!/onload/i.test(html), 'caption must be escaped into the attribute/text');
});

check('directive cannot smuggle a src', () => {
    const html = renderMarkdown(':::media{asset=1 type=video src=https://evil.example/x.mp4}');
    assert.ok(!/src=/.test(html), 'src is not an allowed directive attribute');
});

check('non-numeric asset is refused and leaks no literal directive text', () => {
    const html = renderMarkdown(':::media{asset=1;DROP type=image}');
    assert.ok(!/:::media/.test(html), 'must never publish literal directive syntax');
    assert.ok(!/DROP/.test(html));
});

check('unparseable directive is consumed, never published as literal text', () => {
    // The tokenizer deliberately consumes an invalid directive rather than letting it fall through
    // to the paragraph tokenizer, which would print `:::media{...}` on a customer's page (plan §5).
    const html = renderMarkdown(':::media{asset=}');
    assert.ok(!/:::media/.test(html));
});

check('javascript: link scheme is stripped', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    assert.ok(!/javascript:/i.test(html));
});

check('data: image URI is refused (would bypass the media pipeline)', () => {
    const html = renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    assert.ok(!/data:image/i.test(html));
});

check('arbitrary raw div is stripped (div is allowed ONLY for columns)', () => {
    const html = renderMarkdown('<div class="evil" onclick="alert(1)">hi</div>');
    assert.ok(!/onclick/i.test(html));
    assert.ok(!/class="evil"/.test(html), 'allowedClasses must reject non-BMS classes');
});

check('raw <video src> in the body cannot smuggle a URL', () => {
    const html = renderMarkdown('<video src="https://evil.example/x.mp4" autoplay></video>');
    assert.ok(!/src=/.test(html), 'video src is never an allowed attribute');
    assert.ok(!/autoplay/i.test(html));
});

// ── Columns (plan §3.3) ───────────────────────────────────────────────────────────────────────

console.log('\ncolumns');

const COLUMNS_MD = [
    '::::columns{cols=2}',
    ':::column',
    'Left **prose**.',
    ':::',
    ':::column',
    ':::media{asset=5 type=image}',
    ':::',
    '::::',
].join('\n');

check('columns render a gated grid with per-column divs', () => {
    const html = renderMarkdown(COLUMNS_MD);
    assert.match(html, /<div class="bms-columns" data-cols="2">/);
    assert.ok((html.match(/class="bms-column"/g) || []).length === 2);
    assert.match(html, /Left/);
    assert.match(html, /data-bms-asset="5"/);
});

check('data-cols is clamped — an out-of-range value is dropped, not echoed', () => {
    const html = renderMarkdown(COLUMNS_MD.replace('cols=2', 'cols=99'));
    assert.ok(!/data-cols="99"/.test(html));
});

// ── Syndication strip (plan §3.5) ─────────────────────────────────────────────────────────────
// Text-only for Dev.to/Hashnode. Also closes a live bug: bodyMarkdown was syndicated raw, so
// `![alt](asset://42)` shipped to Dev.to as a literal unresolvable ref (plan §2.4).

console.log('\nsyndication strip');
const strip = (md: string) => BmsDirectives.stripMediaForSyndication(marked, md);

check('asset:// image is removed', () => {
    const out = strip('Intro.\n\n![a cat](asset://42)\n\nOutro.');
    assert.ok(!/asset:\/\//.test(out));
    assert.match(out, /Intro\./);
    assert.match(out, /Outro\./);
});

check(':::media is removed and leaves no literal syntax', () => {
    const out = strip('Intro.\n\n:::media{asset=7 type=video}\n\nOutro.');
    assert.ok(!/:::media/.test(out));
    assert.ok(!/asset/.test(out));
    assert.match(out, /Intro\./);
});

check('columns are UNWRAPPED, not dropped — the prose survives', () => {
    // The important one: dropping the container would silently delete the author's words, not
    // just their media.
    const out = strip(COLUMNS_MD);
    assert.match(out, /Left \*\*prose\*\*\./, 'column prose must survive');
    assert.ok(!/:::/.test(out), 'no directive syntax may leak to Dev.to');
    assert.ok(!/asset/.test(out), 'column media must still be stripped');
});

check('a real https image is KEPT (it still resolves off-platform)', () => {
    const out = strip('![x](https://images.pexels.com/p/1.jpg)');
    assert.match(out, /https:\/\/images\.pexels\.com/);
});

check('an image inline with text drops only the image, keeping the sentence', () => {
    const out = strip('Before ![x](asset://1) after.');
    assert.ok(!/asset:\/\//.test(out));
    assert.match(out, /Before/);
    assert.match(out, /after\./);
});

check('ordinary markdown structure is preserved byte-for-byte', () => {
    const md = '# Title\n\nA paragraph.\n\n- one\n- two\n\n> quote';
    assert.strictEqual(strip(md), md);
});

check('empty body is safe', () => {
    assert.strictEqual(strip(''), '');
});

console.log(`\n${passed} checks passed.\n`);
