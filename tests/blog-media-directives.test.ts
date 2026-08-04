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
/**
 * ⚠️ AWAITS the body. renderMarkdown became async when `marked` moved to a dynamic import (it is
 * ESM-only and cannot be require()d from the CJS function bundle). If this helper did not await,
 * an async body would return a pending promise, `check` would print a tick, and every assertion
 * inside it — including the stored-XSS ones this file exists for — would be skipped silently.
 */
async function check(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`  ✓ ${name}`); passed++; }

async function main() {

// ── The asset:// invariant (plan §1) ──────────────────────────────────────────────────────────
// The single most important property in the epic: presigned R2 URLs expire and the payload is
// immutable + CDN-cached, so a baked-in src yields posts whose media dies hours after publish.

console.log('\nasset:// indirection');

await check('plain markdown image → src-less data-bms-asset', async () => {
    const html = await renderMarkdown('![a cat](asset://42)');
    assert.match(html, /data-bms-asset="42"/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
});

await check(':::media image → src-less data-bms-asset', async () => {
    const html = await renderMarkdown(':::media{asset=42 type=image}');
    assert.match(html, /<img[^>]*data-bms-asset="42"/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
});

await check(':::media video → src-less <video controls>, never autoplay', async () => {
    const html = await renderMarkdown(':::media{asset=7 type=video}');
    assert.match(html, /<video[^>]*data-bms-asset="7"/);
    assert.match(html, /controls/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
    assert.ok(!/autoplay/i.test(html), 'autoplay must never survive');
});

await check(':::media audio → src-less <audio controls>', async () => {
    const html = await renderMarkdown(':::media{asset=9 type=audio}');
    assert.match(html, /<audio[^>]*data-bms-asset="9"/);
    assert.ok(!/src=/.test(html), 'snapshot must not contain a src');
});

await check('real https image URL still passes through (Pexels hotlink)', async () => {
    const html = await renderMarkdown('![x](https://images.pexels.com/p/1.jpg)');
    assert.match(html, /src="https:\/\/images\.pexels\.com\/p\/1\.jpg"/);
});

// ── Hostile input (plan §3.4) ─────────────────────────────────────────────────────────────────

console.log('\nhostile input');

await check('script tag is stripped', async () => {
    const html = await renderMarkdown('<script>alert(1)</script>');
    assert.ok(!/<script/i.test(html));
});

await check('directive cannot inject an event handler via an attribute', async () => {
    const html = await renderMarkdown(':::media{asset=1 type=video onerror=alert(1)}');
    assert.ok(!/onerror/i.test(html), 'unknown directive attrs must be dropped, not emitted');
});

await check('directive cannot break out of the attribute quote', async () => {
    const html = await renderMarkdown(':::media{asset=1 type=video caption="a\\" onload=\\"alert(1)"}');
    assert.ok(!/onload/i.test(html), 'caption must be escaped into the attribute/text');
});

await check('directive cannot smuggle a src', async () => {
    const html = await renderMarkdown(':::media{asset=1 type=video src=https://evil.example/x.mp4}');
    assert.ok(!/src=/.test(html), 'src is not an allowed directive attribute');
});

await check('non-numeric asset is refused and leaks no literal directive text', async () => {
    const html = await renderMarkdown(':::media{asset=1;DROP type=image}');
    assert.ok(!/:::media/.test(html), 'must never publish literal directive syntax');
    assert.ok(!/DROP/.test(html));
});

await check('unparseable directive is consumed, never published as literal text', async () => {
    // The tokenizer deliberately consumes an invalid directive rather than letting it fall through
    // to the paragraph tokenizer, which would print `:::media{...}` on a customer's page (plan §5).
    const html = await renderMarkdown(':::media{asset=}');
    assert.ok(!/:::media/.test(html));
});

await check('javascript: link scheme is stripped', async () => {
    const html = await renderMarkdown('[x](javascript:alert(1))');
    assert.ok(!/javascript:/i.test(html));
});

await check('data: image URI is refused (would bypass the media pipeline)', async () => {
    const html = await renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
    assert.ok(!/data:image/i.test(html));
});

await check('arbitrary raw div is stripped (div is allowed ONLY for columns)', async () => {
    const html = await renderMarkdown('<div class="evil" onclick="alert(1)">hi</div>');
    assert.ok(!/onclick/i.test(html));
    assert.ok(!/class="evil"/.test(html), 'allowedClasses must reject non-BMS classes');
});

await check('raw <video src> in the body cannot smuggle a URL', async () => {
    const html = await renderMarkdown('<video src="https://evil.example/x.mp4" autoplay></video>');
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

await check('columns render a gated grid with per-column divs', async () => {
    const html = await renderMarkdown(COLUMNS_MD);
    assert.match(html, /<div class="bms-columns" data-cols="2">/);
    assert.ok((html.match(/class="bms-column"/g) || []).length === 2);
    assert.match(html, /Left/);
    assert.match(html, /data-bms-asset="5"/);
});

await check('data-cols is clamped — an out-of-range value is dropped, not echoed', async () => {
    const html = await renderMarkdown(COLUMNS_MD.replace('cols=2', 'cols=99'));
    assert.ok(!/data-cols="99"/.test(html));
});

// ── Syndication strip (plan §3.5) ─────────────────────────────────────────────────────────────
// Text-only for Dev.to/Hashnode. Also closes a live bug: bodyMarkdown was syndicated raw, so
// `![alt](asset://42)` shipped to Dev.to as a literal unresolvable ref (plan §2.4).

console.log('\nsyndication strip');
const strip = (md: string) => BmsDirectives.stripMediaForSyndication(marked, md);

await check('asset:// image is removed', async () => {
    const out = strip('Intro.\n\n![a cat](asset://42)\n\nOutro.');
    assert.ok(!/asset:\/\//.test(out));
    assert.match(out, /Intro\./);
    assert.match(out, /Outro\./);
});

await check(':::media is removed and leaves no literal syntax', async () => {
    const out = strip('Intro.\n\n:::media{asset=7 type=video}\n\nOutro.');
    assert.ok(!/:::media/.test(out));
    assert.ok(!/asset/.test(out));
    assert.match(out, /Intro\./);
});

await check('columns are UNWRAPPED, not dropped — the prose survives', async () => {
    // The important one: dropping the container would silently delete the author's words, not
    // just their media.
    const out = strip(COLUMNS_MD);
    assert.match(out, /Left \*\*prose\*\*\./, 'column prose must survive');
    assert.ok(!/:::/.test(out), 'no directive syntax may leak to Dev.to');
    assert.ok(!/asset/.test(out), 'column media must still be stripped');
});

await check('a real https image is KEPT (it still resolves off-platform)', async () => {
    const out = strip('![x](https://images.pexels.com/p/1.jpg)');
    assert.match(out, /https:\/\/images\.pexels\.com/);
});

await check('an image inline with text drops only the image, keeping the sentence', async () => {
    const out = strip('Before ![x](asset://1) after.');
    assert.ok(!/asset:\/\//.test(out));
    assert.match(out, /Before/);
    assert.match(out, /after\./);
});

await check('ordinary markdown structure is preserved byte-for-byte', async () => {
    const md = '# Title\n\nA paragraph.\n\n- one\n- two\n\n> quote';
    assert.strictEqual(strip(md), md);
});

await check('empty body is safe', async () => {
    assert.strictEqual(strip(''), '');
});

console.log(`\n${passed} checks passed.\n`);

}

void main();