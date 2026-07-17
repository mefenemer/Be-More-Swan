// tests/markdown-editor-blocks.test.ts
// Blog Media Composition — locks the editor's DOCUMENT MODEL: how a draft's Markdown becomes
// blocks, and what the editor writes back into it (plan §3.1, §3.6, §4 Phases 3–4).
//
// Scope: the pure half of markdown-editor.js only. mount() needs a DOM, and the drag gesture needs
// OS focus, so neither is reachable from a node test — those are verified in a browser. What IS
// here is the part that silently corrupts a draft when it's wrong: splitBlocks shredding a column
// layout on load, or a splice writing Markdown the server can't parse back.
//
// The output of mediaRaw/spliceColumnRaw must stay parseable by src/lib/marked-bms-directives.js —
// the SAME tokenizer the server renders the published snapshot with. If the editor's writer and
// that reader drift, the Studio's preview lies about what publishes. renderMarkdown is imported
// here to hold that seam shut, so these are round-trip tests, not just string assertions.
//
// Run:  npx tsx tests/markdown-editor-blocks.test.ts

import assert from 'node:assert';
import { renderMarkdown } from '../src/utils/markdown-render';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Editor = require('../src/components/markdown-editor.js');

const { splitBlocks, isMediaBlock, isColumnsBlock, mediaRaw, spliceColumnRaw } = Editor;

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

const COLS = [
    '::::columns{cols=2}',
    ':::column',
    'Left para one.',
    '',
    'Left para two.',
    ':::',
    ':::column',
    'Right side.',
    ':::',
    '::::',
].join('\n');

// ── splitBlocks: container awareness (plan §3.6) ──────────────────────────────────────────────
// Blank lines are the block separator and a column holds ordinary Markdown, so it holds blank
// lines. Without a ::::columns depth counter a multi-paragraph column is shredded into loose
// top-level blocks and the fence is stranded — the layout dies on LOAD, untouched by the author.
console.log('\nsplitBlocks — container awareness');

check('a column layout is ONE block despite its inner blank line', () => {
    assert.deepStrictEqual(splitBlocks(COLS), [COLS]);
});

check('a column layout surrounded by prose keeps its neighbours separate', () => {
    assert.deepStrictEqual(splitBlocks(`Before.\n\n${COLS}\n\nAfter.`), ['Before.', COLS, 'After.']);
});

check('two column layouts back to back stay two blocks', () => {
    assert.deepStrictEqual(splitBlocks(`${COLS}\n\n${COLS}`), [COLS, COLS]);
});

check('ordinary prose still splits on blank lines', () => {
    assert.deepStrictEqual(splitBlocks('A.\n\nB.'), ['A.', 'B.']);
});

check('a fenced code block still survives its blank line', () => {
    const md = '```js\nconst a=1;\n\nconst b=2;\n```';
    assert.deepStrictEqual(splitBlocks(md), [md]);
});

check('a ::::columns fence INSIDE a code block is not counted', () => {
    const md = '```\n::::columns{cols=2}\n```';
    assert.deepStrictEqual(splitBlocks(`${md}\n\nAfter.`), [md, 'After.']);
});

check('an unterminated layout does not swallow the document into nothing', () => {
    assert.strictEqual(splitBlocks('::::columns{cols=2}\n:::column\nx\n:::').length, 1);
});

check('empty input yields one empty block (the editor needs a surface to click)', () => {
    assert.deepStrictEqual(splitBlocks(''), ['']);
});

check('splitBlocks round-trips a mixed draft byte-identically', () => {
    const md = `# Title\n\n${COLS}\n\n![A](asset://1)\n\nEnd.`;
    assert.strictEqual(splitBlocks(md).join('\n\n'), md);
});

// ── isMediaBlock: what may be dragged ─────────────────────────────────────────────────────────
// Only media blocks get draggable=true. Text blocks must NOT: draggable makes the browser start a
// drag instead of a selection, and drag-select is the whole basis of the AI-rewrite toolbar.
console.log('\nisMediaBlock — drag gating');

check('a :::media directive is a media block', () => {
    assert.ok(isMediaBlock(':::media{asset=42 type=video caption="Hi"}'));
});

check('a bare asset image is a media block', () => {
    assert.ok(isMediaBlock('![](asset://42)'));
    assert.ok(isMediaBlock('![An alt](asset://7)'));
});

check('prose is NOT a media block (drag-select must survive)', () => {
    assert.ok(!isMediaBlock('## A Heading'));
    assert.ok(!isMediaBlock('Some **bold** text.'));
});

check('an image INSIDE a sentence is not a media block', () => {
    assert.ok(!isMediaBlock('Text with ![](asset://42) inline'));
});

check('an external image is not a media block (no asset ref to reorder)', () => {
    assert.ok(!isMediaBlock('![](https://example.com/a.png)'));
});

check('a two-colon lookalike is not our directive', () => {
    assert.ok(!isMediaBlock('::media{asset=1}'));
});

check('isColumnsBlock recognises only the columns container', () => {
    assert.ok(isColumnsBlock(COLS));
    assert.ok(!isColumnsBlock(':::media{asset=1 type=image}'));
    assert.ok(!isColumnsBlock('Prose.'));
});

// ── mediaRaw: what the editor writes ──────────────────────────────────────────────────────────
console.log('\nmediaRaw — the writer');

check('a captionless image stays PLAIN markdown, so no draft needs migrating (§3.1)', () => {
    assert.strictEqual(mediaRaw({ assetId: 42, type: 'image', alt: 'A' }), '![A](asset://42)');
});

check('a caption forces the directive, because Markdown cannot say it', () => {
    assert.strictEqual(mediaRaw({ assetId: 42, type: 'image', alt: 'A', caption: 'Cap' }),
        ':::media{asset=42 type=image alt="A" caption="Cap"}');
});

check('video and audio always use the directive', () => {
    assert.strictEqual(mediaRaw({ assetId: 5, type: 'video' }), ':::media{asset=5 type=video}');
    assert.strictEqual(mediaRaw({ assetId: 6, type: 'audio' }), ':::media{asset=6 type=audio}');
});

check('an unknown type degrades to image rather than emitting a type nothing renders', () => {
    assert.strictEqual(mediaRaw({ assetId: 9, type: 'spreadsheet' as any }), '![](asset://9)');
});

check('a quote in author text cannot break out of the attribute grammar', () => {
    const raw = mediaRaw({ assetId: 1, type: 'video', caption: 'He said "hi" }' });
    assert.ok(!raw.includes('"hi"'), raw);
    // The result must still parse — a broken directive would reach a customer page as literal text.
    assert.ok(!renderMarkdown(raw).includes(':::'), renderMarkdown(raw));
});

check('brackets in alt cannot break the plain-image form', () => {
    assert.strictEqual(mediaRaw({ assetId: 1, type: 'image', alt: 'a [b] c' }), '![a b c](asset://1)');
});

// ── spliceColumnRaw: dropping into a column ───────────────────────────────────────────────────
console.log('\nspliceColumnRaw — column drops');

check('media lands in the targeted column and leaves the other alone', () => {
    const out = spliceColumnRaw(COLS, 1, '![Shot](asset://42)')!;
    assert.ok(out.includes('Right side.\n\n![Shot](asset://42)'), out);
    assert.ok(out.includes('Left para one.\n\nLeft para two.'), out);
});

check('an out-of-range column returns null rather than a half-edited draft', () => {
    assert.strictEqual(spliceColumnRaw(COLS, 5, '![](asset://1)'), null);
    assert.strictEqual(spliceColumnRaw(COLS, -1, '![](asset://1)'), null);
});

check('splicing into an EMPTY column does not leave a stray blank line', () => {
    const empty = '::::columns{cols=2}\n:::column\n\n:::\n:::column\nRight.\n:::\n::::';
    const out = spliceColumnRaw(empty, 0, '![](asset://1)')!;
    assert.ok(!out.includes('\n\n\n'), JSON.stringify(out));
});

check('the splice output still splits as ONE block (the two halves agree)', () => {
    const out = spliceColumnRaw(COLS, 0, ':::media{asset=9 type=audio}')!;
    assert.deepStrictEqual(splitBlocks(out), [out]);
});

// ── Round-trip: the editor's writer vs the server's reader ────────────────────────────────────
// The seam that matters. Anything the editor writes must render on the server, or the Studio's
// preview is lying about what will publish.
console.log('\nround-trip — editor output through the SERVER renderer');

check('a fresh 2-column layout renders as a real grid', () => {
    const html = renderMarkdown(COLS);
    assert.ok(html.includes('<div class="bms-columns" data-cols="2">'), html);
    assert.strictEqual((html.match(/class="bms-column"/g) || []).length, 2);
});

check('a dropped image renders inside the column it was aimed at', () => {
    const html = renderMarkdown(spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'image', alt: 'Shot' }))!);
    const cols = html.split('<div class="bms-column">');
    assert.ok(!cols[1].includes('data-bms-asset'), cols[1]);
    assert.ok(cols[2].includes('data-bms-asset="42"'), cols[2]);
});

check('dropped audio renders an <audio> element inside the column (Phase 2)', () => {
    const html = renderMarkdown(spliceColumnRaw(COLS, 0, mediaRaw({ assetId: 9, type: 'audio' }))!);
    assert.ok(/<audio[^>]+data-bms-asset="9"/.test(html), html);
});

check('the snapshot stays SRC-LESS — the asset:// presign invariant holds inside columns', () => {
    const html = renderMarkdown(spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'video' }))!);
    assert.ok(!/<(img|video|audio)[^>]+src=/.test(html), html);
});

check('no literal directive text can reach a published page', () => {
    const html = renderMarkdown(spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'image', caption: 'C' }))!);
    assert.ok(!html.includes(':::'), html);
});

console.log(`\n${passed} checks passed.\n`);
