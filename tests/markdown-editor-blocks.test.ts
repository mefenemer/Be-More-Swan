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

const { splitBlocks, isMediaBlock, isColumnsBlock, mediaRaw, spliceColumnRaw,
        columnBodyRaw, replaceColumnRaw, COLUMN_SEED,
        toggleInlineMark, insertLink, detectBlockType, setBlockType, INLINE_MARKS } = Editor;

let passed = 0;
/**
 * ⚠️ AWAITS the body. renderMarkdown is async — `marked` is ESM-only and is reached through a
 * dynamic import. Without the await, an async body returns a pending promise, the tick prints, and
 * the assertions inside never run.
 */
async function check(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`  ✓ ${name}`); passed++; }

async function main() {

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

await check('a column layout is ONE block despite its inner blank line', async () => {
    assert.deepStrictEqual(splitBlocks(COLS), [COLS]);
});

await check('a column layout surrounded by prose keeps its neighbours separate', async () => {
    assert.deepStrictEqual(splitBlocks(`Before.\n\n${COLS}\n\nAfter.`), ['Before.', COLS, 'After.']);
});

await check('two column layouts back to back stay two blocks', async () => {
    assert.deepStrictEqual(splitBlocks(`${COLS}\n\n${COLS}`), [COLS, COLS]);
});

await check('ordinary prose still splits on blank lines', async () => {
    assert.deepStrictEqual(splitBlocks('A.\n\nB.'), ['A.', 'B.']);
});

await check('a fenced code block still survives its blank line', async () => {
    const md = '```js\nconst a=1;\n\nconst b=2;\n```';
    assert.deepStrictEqual(splitBlocks(md), [md]);
});

await check('a ::::columns fence INSIDE a code block is not counted', async () => {
    const md = '```\n::::columns{cols=2}\n```';
    assert.deepStrictEqual(splitBlocks(`${md}\n\nAfter.`), [md, 'After.']);
});

await check('an unterminated layout does not swallow the document into nothing', async () => {
    assert.strictEqual(splitBlocks('::::columns{cols=2}\n:::column\nx\n:::').length, 1);
});

await check('empty input yields one empty block (the editor needs a surface to click)', async () => {
    assert.deepStrictEqual(splitBlocks(''), ['']);
});

await check('splitBlocks round-trips a mixed draft byte-identically', async () => {
    const md = `# Title\n\n${COLS}\n\n![A](asset://1)\n\nEnd.`;
    assert.strictEqual(splitBlocks(md).join('\n\n'), md);
});

// ── isMediaBlock: what may be dragged ─────────────────────────────────────────────────────────
// Only media blocks get draggable=true. Text blocks must NOT: draggable makes the browser start a
// drag instead of a selection, and drag-select is the whole basis of the AI-rewrite toolbar.
console.log('\nisMediaBlock — drag gating');

await check('a :::media directive is a media block', async () => {
    assert.ok(isMediaBlock(':::media{asset=42 type=video caption="Hi"}'));
});

await check('a bare asset image is a media block', async () => {
    assert.ok(isMediaBlock('![](asset://42)'));
    assert.ok(isMediaBlock('![An alt](asset://7)'));
});

await check('prose is NOT a media block (drag-select must survive)', async () => {
    assert.ok(!isMediaBlock('## A Heading'));
    assert.ok(!isMediaBlock('Some **bold** text.'));
});

await check('an image INSIDE a sentence is not a media block', async () => {
    assert.ok(!isMediaBlock('Text with ![](asset://42) inline'));
});

await check('an external image is not a media block (no asset ref to reorder)', async () => {
    assert.ok(!isMediaBlock('![](https://example.com/a.png)'));
});

await check('a two-colon lookalike is not our directive', async () => {
    assert.ok(!isMediaBlock('::media{asset=1}'));
});

await check('isColumnsBlock recognises only the columns container', async () => {
    assert.ok(isColumnsBlock(COLS));
    assert.ok(!isColumnsBlock(':::media{asset=1 type=image}'));
    assert.ok(!isColumnsBlock('Prose.'));
});

// ── mediaRaw: what the editor writes ──────────────────────────────────────────────────────────
console.log('\nmediaRaw — the writer');

await check('a captionless image stays PLAIN markdown, so no draft needs migrating (§3.1)', async () => {
    assert.strictEqual(mediaRaw({ assetId: 42, type: 'image', alt: 'A' }), '![A](asset://42)');
});

await check('a caption forces the directive, because Markdown cannot say it', async () => {
    assert.strictEqual(mediaRaw({ assetId: 42, type: 'image', alt: 'A', caption: 'Cap' }),
        ':::media{asset=42 type=image alt="A" caption="Cap"}');
});

await check('video and audio always use the directive', async () => {
    assert.strictEqual(mediaRaw({ assetId: 5, type: 'video' }), ':::media{asset=5 type=video}');
    assert.strictEqual(mediaRaw({ assetId: 6, type: 'audio' }), ':::media{asset=6 type=audio}');
});

await check('an unknown type degrades to image rather than emitting a type nothing renders', async () => {
    assert.strictEqual(mediaRaw({ assetId: 9, type: 'spreadsheet' as any }), '![](asset://9)');
});

await check('a quote in author text cannot break out of the attribute grammar', async () => {
    const raw = mediaRaw({ assetId: 1, type: 'video', caption: 'He said "hi" }' });
    assert.ok(!raw.includes('"hi"'), raw);
    // The result must still parse — a broken directive would reach a customer page as literal text.
    const html = await renderMarkdown(raw);
    assert.ok(!html.includes(':::'), html);
});

await check('brackets in alt cannot break the plain-image form', async () => {
    assert.strictEqual(mediaRaw({ assetId: 1, type: 'image', alt: 'a [b] c' }), '![a b c](asset://1)');
});

// ── spliceColumnRaw: dropping into a column ───────────────────────────────────────────────────
console.log('\nspliceColumnRaw — column drops');

await check('media lands in the targeted column and leaves the other alone', async () => {
    const out = spliceColumnRaw(COLS, 1, '![Shot](asset://42)')!;
    assert.ok(out.includes('Right side.\n\n![Shot](asset://42)'), out);
    assert.ok(out.includes('Left para one.\n\nLeft para two.'), out);
});

await check('an out-of-range column returns null rather than a half-edited draft', async () => {
    assert.strictEqual(spliceColumnRaw(COLS, 5, '![](asset://1)'), null);
    assert.strictEqual(spliceColumnRaw(COLS, -1, '![](asset://1)'), null);
});

await check('splicing into an EMPTY column does not leave a stray blank line', async () => {
    const empty = '::::columns{cols=2}\n:::column\n\n:::\n:::column\nRight.\n:::\n::::';
    const out = spliceColumnRaw(empty, 0, '![](asset://1)')!;
    assert.ok(!out.includes('\n\n\n'), JSON.stringify(out));
});

await check('the splice output still splits as ONE block (the two halves agree)', async () => {
    const out = spliceColumnRaw(COLS, 0, ':::media{asset=9 type=audio}')!;
    assert.deepStrictEqual(splitBlocks(out), [out]);
});

// ── columnBodyRaw / replaceColumnRaw: TYPING in a column ──────────────────────────────────────
// Clicking a layout used to open the block editor, whose textarea holds the block's raw — for a
// columns block that is the `::::columns{cols=2}` container itself, so the author was handed the
// scaffolding as the thing to type over. The editor now opens one COLUMN, and these two functions
// are the seam: read a column's prose out, write the edited prose back inside the fence.
console.log('\ncolumn editing — read/write one column body');

await check('a column body reads back without any fence around it', () => {
    assert.strictEqual(columnBodyRaw(COLS, 0), 'Left para one.\n\nLeft para two.');
    assert.strictEqual(columnBodyRaw(COLS, 1), 'Right side.');
});

await check('an untouched column reads as EMPTY, never as the seed instruction', () => {
    const fresh = `::::columns{cols=2}\n:::column\n${COLUMN_SEED}\n:::\n:::column\n${COLUMN_SEED}\n:::\n::::`;
    assert.strictEqual(columnBodyRaw(fresh, 0), '');
    assert.strictEqual(columnBodyRaw(fresh, 1), '');
});

await check('an out-of-range column reads null, so nothing opens over the wrong column', () => {
    assert.strictEqual(columnBodyRaw(COLS, 2), null);
    assert.strictEqual(columnBodyRaw(COLS, -1), null);
});

await check('an edit REPLACES that column and leaves the other byte-for-byte alone', () => {
    const out = replaceColumnRaw(COLS, 0, 'Rewritten.')!;
    assert.ok(out.includes(':::column\nRewritten.\n:::'), out);
    assert.ok(out.includes('Right side.'), out);
    assert.ok(!out.includes('Left para one.'), out);
});

await check('blank RE-SEEDS the column — an empty .bms-column has no height to click back into', () => {
    const out = replaceColumnRaw(COLS, 1, '   \n  ')!;
    assert.strictEqual(columnBodyRaw(out, 1), '');
    assert.ok(out.includes(COLUMN_SEED), out);
});

await check('a typed fence line cannot close the container early', () => {
    const out = replaceColumnRaw(COLS, 0, 'safe\n:::\n::::columns{cols=3}\nalso safe')!;
    // The container's own open + close, and nothing smuggled in between.
    assert.strictEqual((out.match(/^::::columns\{/gm) || []).length, 1);
    assert.strictEqual((out.match(/^::::$/gm) || []).length, 1);
    assert.strictEqual((out.match(/^:::column$/gm) || []).length, 2);
    assert.strictEqual(columnBodyRaw(out, 0), 'safe\nalso safe');
});

await check('an out-of-range write returns null rather than a half-edited draft', () => {
    assert.strictEqual(replaceColumnRaw(COLS, 5, 'x'), null);
    assert.strictEqual(replaceColumnRaw(COLS, -1, 'x'), null);
});

await check('an edited layout still splits as ONE block — the fence is never stranded', () => {
    const out = replaceColumnRaw(COLS, 0, 'One para.\n\nTwo para.')!;
    assert.deepStrictEqual(splitBlocks(out), [out]);
});

await check('read → write with no change is a no-op (the round-trip the blur handler runs)', () => {
    assert.strictEqual(replaceColumnRaw(COLS, 0, columnBodyRaw(COLS, 0)!), COLS);
    assert.strictEqual(replaceColumnRaw(COLS, 1, columnBodyRaw(COLS, 1)!), COLS);
});

await check('media already in a column survives an edit to the OTHER column', () => {
    const withMedia = spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'image', alt: 'Shot' }))!;
    const out = replaceColumnRaw(withMedia, 0, 'New left.')!;
    assert.ok(out.includes('![Shot](asset://42)'), out);
});

// ── Round-trip: the editor's writer vs the server's reader ────────────────────────────────────
// The seam that matters. Anything the editor writes must render on the server, or the Studio's
// preview is lying about what will publish.
console.log('\nround-trip — editor output through the SERVER renderer');

await check('a fresh 2-column layout renders as a real grid', async () => {
    const html = await renderMarkdown(COLS);
    assert.ok(html.includes('<div class="bms-columns" data-cols="2">'), html);
    assert.strictEqual((html.match(/class="bms-column"/g) || []).length, 2);
});

await check('a dropped image renders inside the column it was aimed at', async () => {
    const html = await renderMarkdown(spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'image', alt: 'Shot' }))!);
    const cols = html.split('<div class="bms-column">');
    assert.ok(!cols[1].includes('data-bms-asset'), cols[1]);
    assert.ok(cols[2].includes('data-bms-asset="42"'), cols[2]);
});

await check('dropped audio renders an <audio> element inside the column (Phase 2)', async () => {
    const html = await renderMarkdown(spliceColumnRaw(COLS, 0, mediaRaw({ assetId: 9, type: 'audio' }))!);
    assert.ok(/<audio[^>]+data-bms-asset="9"/.test(html), html);
});

await check('the snapshot stays SRC-LESS — the asset:// presign invariant holds inside columns', async () => {
    const html = await renderMarkdown(spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'video' }))!);
    assert.ok(!/<(img|video|audio)[^>]+src=/.test(html), html);
});

await check('prose typed into a column publishes as that column, formatting and all', async () => {
    const html = await renderMarkdown(replaceColumnRaw(COLS, 0, 'A **bold** line.')!);
    const cols = html.split('<div class="bms-column">');
    assert.ok(cols[1].includes('<strong>bold</strong>'), cols[1]);
    assert.ok(cols[2].includes('Right side.'), cols[2]);
    assert.strictEqual((html.match(/class="bms-column"/g) || []).length, 2);
});

await check('no literal directive text can reach a published page', async () => {
    const html = await renderMarkdown(spliceColumnRaw(COLS, 1, mediaRaw({ assetId: 42, type: 'image', caption: 'C' }))!);
    assert.ok(!html.includes(':::'), html);
});

// ── Formatting bar primitives ─────────────────────────────────────────────────────────────────
// The bar writes Markdown into the same block `raw` that typing and AI rewrites write, so a bug
// here is not a cosmetic toolbar bug — it is a corrupted draft that autosaves over the original.

await check('bold wraps the selection and keeps it selected', () => {
    const out = toggleInlineMark('make this bold', 5, 9, INLINE_MARKS.bold);
    assert.strictEqual(out.text, 'make **this** bold');
    assert.strictEqual(out.text.slice(out.selStart, out.selEnd), 'this');
});

await check('bold on an already-bold selection unwraps it (round-trip)', () => {
    const on = toggleInlineMark('make this bold', 5, 9, INLINE_MARKS.bold);
    const off = toggleInlineMark(on.text, on.selStart, on.selEnd, INLINE_MARKS.bold);
    assert.strictEqual(off.text, 'make this bold');
    assert.strictEqual(off.text.slice(off.selStart, off.selEnd), 'this');
});

await check('bold unwraps when the markers are INSIDE the selection too', () => {
    const out = toggleInlineMark('make **this** bold', 5, 13, INLINE_MARKS.bold);
    assert.strictEqual(out.text, 'make this bold');
});

await check('a collapsed caret gets an empty pair with the caret between the markers', () => {
    const out = toggleInlineMark('ab', 1, 1, INLINE_MARKS.bold);
    assert.strictEqual(out.text, 'a****b');
    assert.strictEqual(out.selStart, 3);
    assert.strictEqual(out.selEnd, 3);
});

await check('a backwards drag-select (end < start) is handled, not corrupted', () => {
    const out = toggleInlineMark('make this bold', 9, 5, INLINE_MARKS.bold);
    assert.strictEqual(out.text, 'make **this** bold');
});

// ⚠️ THE REASON ITALIC IS `_` AND NOT `*`. With `*`, this toggle matches the bold marker one
// character in, strips a single star, and turns **bold** into a broken half-emphasis — silently,
// in a draft that then autosaves. Changing INLINE_MARKS.italic to '*' must fail here.
await check('italic inside a bold run does not eat the bold markers', () => {
    const out = toggleInlineMark('a **bold** b', 4, 8, INLINE_MARKS.italic);
    assert.strictEqual(out.text, 'a **_bold_** b');
});

await check('link wraps the selection and leaves the URL selected to type over', () => {
    const out = insertLink('see the docs here', 8, 12);
    assert.strictEqual(out.text, 'see the [docs](https://) here');
    assert.strictEqual(out.text.slice(out.selStart, out.selEnd), 'https://');
});

await check('link with no selection still emits visible label text', () => {
    // `[](https://)` renders as nothing at all, which reads as the button having done nothing.
    const out = insertLink('', 0, 0);
    assert.strictEqual(out.text, '[link text](https://)');
});

await check('detectBlockType reads the first line', () => {
    assert.strictEqual(detectBlockType('## Heading'), 'h2');
    assert.strictEqual(detectBlockType('> quoted'), 'quote');
    assert.strictEqual(detectBlockType('- one\n- two'), 'ul');
    assert.strictEqual(detectBlockType('1. one\n2. two'), 'ol');
    assert.strictEqual(detectBlockType('just words'), 'p');
    assert.strictEqual(detectBlockType(''), 'p');
});

// Naive prepending produces `> - ## text`, which renders as a quote containing a bulleted heading.
await check('switching type REPLACES the old prefix rather than stacking', () => {
    assert.strictEqual(setBlockType('## Heading', 'quote'), '> Heading');
    assert.strictEqual(setBlockType('> quoted', 'ul'), '- quoted');
    assert.strictEqual(setBlockType('- item', 'h2'), '## item');
    assert.strictEqual(setBlockType('1. item', 'p'), 'item');
});

await check('every type round-trips back to a clean paragraph', () => {
    for (const t of ['p', 'h1', 'h2', 'h3', 'h4', 'quote', 'ul', 'ol']) {
        assert.strictEqual(setBlockType(setBlockType('plain text', t), 'p'), 'plain text', t);
        assert.strictEqual(detectBlockType(setBlockType('plain text', t)), t, t);
    }
});

await check('a multi-line block becomes ONE heading, not one heading per line', () => {
    assert.strictEqual(setBlockType('line one\nline two', 'h2'), '## line one line two');
});

await check('lists and quotes are applied per line, and ol renumbers from 1', () => {
    assert.strictEqual(setBlockType('a\nb\nc', 'ol'), '1. a\n2. b\n3. c');
    assert.strictEqual(setBlockType('a\nb', 'ul'), '- a\n- b');
    assert.strictEqual(setBlockType('a\nb', 'quote'), '> a\n> b');
});

// The bar disables itself for these, but the guard is worth stating: their raw is a directive, and
// stripBlockPrefix on `:::media{...}` would be a corrupted layout the author never asked for.
await check('media and columns raw are recognised, so the bar can lock itself', () => {
    assert.ok(isMediaBlock(mediaRaw({ assetId: 1, type: 'video' })));
    assert.ok(isColumnsBlock(COLS));
});

console.log(`\n${passed} checks passed.\n`);

}

void main();