// tests/blog-studio-usability.test.ts
// Ten faults reported against Blog Studio on 2026-08-19, all variations on one theme: the surface
// knew things the author could not see.
//
//  1. Every secondary button was a flat grey rectangle — no border, no shadow, no hover — so
//     "Choose from Library", "Stock photo", "2 Columns" and "Connect Google Search Console" read as
//     labels rather than controls.
//  2. There was no way to choose which platforms a post syndicated to. Connecting a blog in the
//     Connections tab opted it in for EVERY post, permanently and silently.
//  3. The feature-image box said "No feature image yet." and nothing about how to fill it.
//  4. Changing "Font family" changed a stored setting and nothing on screen — a picker of 53 names
//     rendered in a face that was none of them.
//  5. "Discard" was the only surviving window.confirm() in the client (see
//     dialogs-js-is-the-only-dialog): the browser's grey box in the middle of a styled product.
//  6. "Remove" hid among five identical grey buttons under the hero.
//  7. Feature and Inline media were two rows of the SAME five sources, forcing the author to pick a
//     destination before seeing the media.
//  8. The Columns buttons appended an empty layout at the END of the draft (currentSel is only set
//     by a text SELECTION, so clicking into a paragraph anchored nothing), and only MEDIA blocks
//     carried draggable=true — so there was no way to move a paragraph into a column at all.
//  9/10. "AI draft", "Ask Swan to improve", "Stock", "AI" named nobody, though the work is done by
//     an assistant the user hired and named.
//
// Pure source scans plus a real call into the editor's pure helpers. No DB, no network, no DOM.
// Run:  npx tsx tests/blog-studio-usability.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { landmark } from './landmark';

let passed = 0;
const check = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

// Drop whole-line `//` comments. Two checks below assert that a phrase is GONE from the source, and
// this file's own subjects are heavily commented — the comment explaining why window.confirm() was
// removed contains the string "window.confirm(", and the comment above the renamed buttons quotes
// their old wording. Scanning raw text there passes prose off as code and hides a real regression
// behind a green tick. Only leading-`//` lines go: a trailing `//` would eat the `https://` in URLs.
const codeOnly = (src: string) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const modal = read('../src/components/blog-studio-modal.js');
const editor = read('../src/components/markdown-editor.js');
const draft = read('../netlify/functions/save-blog-draft.ts');
const syndicate = read('../src/utils/blog-destinations/syndicate.ts');

// The STYLES / MARKUP constants are string-concatenated JS, so a scan of the file text is a scan of
// the rendered CSS and HTML. Slice them apart so a match in one can't be read as a match in both.
const styles = modal.slice(landmark(modal, 'var STYLES ='), landmark(modal, 'var MARKUP ='));
const markup = modal.slice(landmark(modal, 'var MARKUP ='), landmark(modal, 'function selectedAssistant()'));

console.log('\n(1) Secondary buttons look like buttons\n');

check('the ghost style has an edge, a lift and a hover — not just a grey fill', () => {
    const rule = styles.slice(landmark(styles, ".bs-btn-ghost{"), landmark(styles, ".bs-btn-sm{"));
    assert.ok(/border-color:#d1d5db/.test(rule), 'the ghost button still has no visible border');
    assert.ok(/box-shadow:/.test(rule), 'the ghost button still sits flat on the panel');
    assert.ok(/\.bs-btn-ghost:hover/.test(rule), 'nothing happens on hover, so it does not read as clickable');
});

check('focus is visible, so the row is reachable from the keyboard', () => {
    assert.ok(/\.bs-btn:focus-visible\{outline:2px solid/.test(styles), 'no focus ring on the button style');
});

console.log('\n(2) The author chooses where a post is published\n');

check('Blog Studio has a per-post destination panel', () => {
    assert.ok(markup.includes('Where this post gets published'), 'no distribution panel in the markup');
    assert.ok(markup.includes('id="bs-dist-list"'), 'no list to render connected platforms into');
    // The org's own blog is not optional. It is shown so the panel tells the whole truth about
    // where a post goes, but it must be disabled — an enabled tick box implies it can be turned off.
    const ownRow = markup.slice(landmark(markup, 'class="bs-dest"'), landmark(markup, 'id="bs-dist-list"'));
    assert.ok(/checked disabled/.test(ownRow), 'the always-on "Your blog" row can be unticked');
    assert.ok(/always included/.test(ownRow), 'the row does not say it is always included');
});

check('the choice is saved through save-blog-draft', () => {
    const fn = modal.slice(landmark(modal, 'function saveDistribution()'), landmark(modal, 'function loadDistribution('));
    assert.ok(fn.includes("api('save-blog-draft'"), 'the tick boxes save nowhere');
    assert.ok(/distribution: chosen/.test(fn), 'the chosen ids are not sent');
});

check('save-blog-draft merges the choice INTO destinations, never over it', () => {
    const start = landmark(draft, 'if (Array.isArray(body.distribution))');
    const slice = draft.slice(start, start + 900);
    assert.ok(slice.includes('isBlogDestinationId'), 'an arbitrary string can be stored as a target');
    // destinations also holds every target's publish status and the widget's — a plain assign
    // would erase the record of where the post has already been.
    assert.ok(/\.\.\.\(\(current\.destinations/.test(slice), 'the existing destinations blob is being overwritten');
    assert.ok(slice.includes('selected'), 'the choice is not stored under the reserved key');
});

check('syndication honours the choice, and ABSENT still means "everything connected"', () => {
    const fn = syndicate.slice(landmark(syndicate, 'export async function syndicatePublishedPost'),
                               landmark(syndicate, 'const projected = await projectPost'));
    assert.ok(/Array\.isArray\(stored\.selected\) \? stored\.selected\.map\(String\) : null/.test(fn),
        'the stored choice is not read back');
    assert.ok(/selected === null \|\| selected\.includes\(d\.id\)/.test(fn),
        'the filter does not distinguish "no choice made" from "my site only"');
    // The distinction matters: [] is a real answer. Collapsing it to "no choice" would push a post
    // the author deliberately held back.
    assert.ok(/null \(not \[\]\)/.test(syndicate), 'the empty-vs-absent distinction is undocumented');
});

console.log('\n(3, 6, 7) One media panel, with the hero explained and removable\n');

check('the duplicate Feature/Inline button rows are gone', () => {
    ['bs-feature-library', 'bs-feature-upload', 'bs-feature-pexels', 'bs-feature-canva', 'bs-feature-ai',
     'bs-inline-library', 'bs-inline-upload', 'bs-inline-pexels', 'bs-inline-canva', 'bs-inline-ai',
    ].forEach((id) => assert.ok(!markup.includes('id="' + id + '"'), `${id} is still in the markup`));
    ['bs-media-library', 'bs-media-upload', 'bs-media-pexels', 'bs-media-canva', 'bs-media-ai',
    ].forEach((id) => assert.ok(markup.includes('id="' + id + '"'), `the single ${id} button is missing`));
});

check('the destination flag that forced the choice up front is gone', () => {
    // state.mediaTarget decided where a pick landed from WHICH BUTTON ROW opened the picker.
    assert.ok(!/state\.mediaTarget\s*=/.test(modal), 'something still assigns the old mediaTarget flag');
    assert.ok(!/function routeMedia\(/.test(modal), 'the mode-based router is still here');
    assert.ok(/function routeFeature\(/.test(modal), 'there is no explicit "make this the hero" path');
});

check('every tile offers BOTH destinations, and the hero one only for images', () => {
    const fn = modal.slice(landmark(modal, 'function renderTiles('), landmark(modal, "function openLibrary("));
    assert.ok(/attachInline\(item\.body\)/.test(fn), 'clicking a tile no longer adds it to the post');
    assert.ok(/routeFeature\(item\.body\)/.test(fn), 'no tile-level way to set the feature image');
    assert.ok(/\(item\.type \|\| 'image'\) === 'image'/.test(fn),
        'the Feature action is offered on video/audio, which blog-media always refuses');
    // Discoverability was the whole complaint — a hover-only affordance repeats it.
    assert.ok(!/\.bs-tile:hover \.bs-tile-feature/.test(styles), 'the Feature chip is hover-only again');
});

check('the feature box is a real drop target and says what it is for', () => {
    assert.ok(markup.includes('id="bs-feature-drop"'), 'there is no drop container around the hero');
    assert.ok(/Drop an image here to make it the feature image\./.test(modal),
        'the empty hero still reports a state instead of offering an action');
    assert.ok(markup.includes('The banner shown at the top of the published post'),
        'no help text explaining what the feature image is');
    const fn = modal.slice(landmark(modal, 'function featureDragKind('), landmark(modal, 'function insertColumns('));
    assert.ok(fn.includes("mediaEls.drop.addEventListener('drop'"), 'nothing can be dropped on the hero');
    assert.ok(/video and audio go in the post body/.test(fn),
        'a non-image drop is not explained — it just fails downstream');
});

check('Remove sits ON the image and names what it removes', () => {
    assert.ok(/Remove feature image<\/button>/.test(markup), 'the button no longer names its target');
    const rule = styles.slice(landmark(styles, '.bs-feature-remove{'), landmark(styles, '.bs-media-picker{'));
    assert.ok(/position:absolute/.test(rule), 'Remove is back in the row of identical grey buttons');
});

console.log('\n(4) Choosing a font reformats the draft\n');

check('the editor exposes setFontFamily, and the picker calls it', () => {
    assert.ok(/setFontFamily\(stack\) \{/.test(editor), 'the editor cannot be told which face to use');
    assert.ok(/--bmsme-font/.test(editor), 'no custom property for the blocks to inherit');
    assert.ok(/\.bmsme-block, \.bmsme-block \.bmsme-input \{ font-family: var\(--bmsme-font/.test(editor),
        'the blocks do not read the font variable, so setting it changes nothing');
    const fn = modal.slice(landmark(modal, 'function applyFontToEditor('), landmark(modal, 'function applyWidget('));
    assert.ok(fn.includes('state.editor.setFontFamily'), 'the Studio never pushes the font into the editor');
    // Both entry points: the picker's change event AND the stored value on open.
    assert.ok(/el\('bs-font'\)\.addEventListener\('change', function \(\) \{ applyFontToEditor/.test(modal),
        'changing the picker does not reformat the draft');
    assert.ok(/applyFontToEditor\(theme\.fontFamily\)/.test(modal),
        'a post opened with a stored font does not render in it');
});

console.log('\n(5) Discard uses the product\'s dialog\n');

check('no native confirm survives in Blog Studio', () => {
    assert.ok(!/window\.confirm\(/.test(codeOnly(modal)), 'Blog Studio still calls the browser confirm()');
    const fn = modal.slice(landmark(modal, "el('bs-discard').addEventListener"),
                           landmark(modal, "el('bs-gsc-connect').addEventListener"));
    assert.ok(fn.length > 200, 'the Discard slice is empty — re-anchor it');
    assert.ok(fn.includes('await window.confirmModal('), 'Discard does not go through /dialogs.js');
    assert.ok(/confirmLabel: 'Yes, archive it'/.test(fn), 'the dialog does not name the verb it performs');
    // blog-posts DELETE sets status='archived' — the dialog must not promise permanence.
    assert.ok(/The draft is kept/.test(fn), 'the wording no longer says the draft survives');
});

console.log('\n(8) Columns can actually be filled\n');

check('EVERY block carries a drag handle, not only media', () => {
    const fn = editor.slice(landmark(editor, 'function paintBlock('), landmark(editor, 'function renderAll()'));
    assert.ok(/handle\.setAttribute\('draggable', 'true'\)/.test(fn), 'the handle cannot start a drag');
    assert.ok(fn.includes("handle.className = 'bmsme-handle'"), 'no handle is painted at all');
    // renderOneBlock used to assign innerHTML directly, which ate the handle for that one block.
    assert.ok(/paintBlock\(el, b\);/.test(editor.slice(landmark(editor, 'function renderOneBlock('),
        landmark(editor, 'function renderOneBlock(') + 400)), 'renderOneBlock still wipes the handle');
});

check('a drag begun on the handle is accepted', () => {
    const fn = editor.slice(landmark(editor, 'function onDragStart('), landmark(editor, 'function onDragEnd('));
    assert.ok(/closest\('\.bmsme-handle'\)/.test(fn), 'the handle drag is ignored');
    assert.ok(/!fromHandle && blockEl\.getAttribute\('draggable'\) !== 'true'/.test(fn),
        'the media-only gate still rejects a handle drag on a paragraph');
});

check('the handle is a grip, not a second way into edit mode', () => {
    const fn = editor.slice(landmark(editor, 'function onRootClick('), landmark(editor, 'function onSelect()'));
    assert.ok(/closest\('\.bmsme-handle'\)\) return;/.test(fn),
        'clicking the handle drops the author into a textarea instead of moving anything');
});

check('columns land after the block being edited, not at the end of the draft', () => {
    const fn = modal.length && editor.slice(landmark(editor, 'insertColumns(cols) {'), landmark(editor, 'insertColumnsAt,'));
    assert.ok(/editing && editing\.blockId/.test(fn as string),
        'an open edit is still not an anchor, so the layout appends to the end');
    assert.ok(/formatTargetId/.test(fn as string), 'the last-touched block is still not a fallback anchor');
});

check('the new layout is scrolled to and flashed', () => {
    assert.ok(/function revealBlock\(blockId\)/.test(editor), 'nothing draws attention to the insert');
    const fn = editor.slice(landmark(editor, 'function insertColumnsAt('), landmark(editor, 'function spliceIntoColumn('));
    assert.ok(/revealBlock\(block\.id\)/.test(fn), 'insertColumnsAt does not reveal what it inserted');
});

console.log('\n(9, 10) The assistant is named on the work it does\n');

check('all four "ask the assistant" labels are generated from one place', () => {
    assert.ok(/var ASSISTANT_LABELS = \{/.test(modal), 'no single source for the labels');
    ['draft', 'improve', 'stock', 'generate'].forEach((k) => {
        assert.ok(markup.includes('data-bs-assistant-label="' + k + '"'), `the ${k} button carries no name slot`);
        assert.ok(new RegExp(k + ": function \\(n\\) \\{ return 'Ask ' \\+ n").test(modal),
            `the ${k} label does not name the assistant`);
    });
    // The old anonymous wording must be gone, not merely shadowed.
    const markupCode = codeOnly(markup);
    assert.ok(!/>AI draft</.test(markupCode), '"AI draft" is still the button text');
    assert.ok(!/Ask Swan to improve/.test(markupCode), '"Ask Swan to improve" is still the button text');
});

check('a Blog Writer is resolved when the caller passed no assistantId', () => {
    // Calendar and the standalone page open with only a postId; a blank draft has neither.
    const fn = modal.slice(landmark(modal, 'function ensureAssistantIdentity()'), landmark(modal, '// ── "Ask Swan to improve"'));
    assert.ok(fn.includes('resolveBlogWriter()'), 'no fallback lookup, so the buttons stay anonymous');
    assert.ok(/state\.assistantName === ''/.test(fn),
        'a workspace with no Blog Writer refetches on every open — "" must record the negative result');
});

console.log(`\n${passed} checks passed.\n`);
