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
// 11. The Widget panel was the last thing in the Studio behind a "Save settings" button, in a modal
//     where the body, the SEO fields and the destinations all autosave. Nobody presses a button
//     they have been trained not to need, so accent, font, badge and the two canonical-URL fields
//     were being typed and thrown away on close.
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
const widgetFn = read('../netlify/functions/save-widget-config.ts');

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

console.log('\n(11) Widget settings autosave, and say so\n');

// One slice per concern, so a failure names which half moved.
const widgetSave = modal.slice(landmark(modal, 'function saveWidgetSettings()'),
                               landmark(modal, 'function widgetChanged()'));
const widgetWiring = modal.slice(landmark(modal, 'function widgetChanged()'),
                                 landmark(modal, '// ── SEO metadata overrides'));

check('the Save settings button is gone, not merely hidden', () => {
    assert.ok(!codeOnly(modal).includes('bs-save-theme'), 'the Save settings button is still in the source');
    assert.ok(!/>Save settings</.test(codeOnly(markup)), '"Save settings" is still on screen');
    // A panel that saves silently and shows nothing reads as a panel that has stopped saving.
    assert.ok(markup.includes('id="bs-widget-status"'), 'nothing tells the author the panel is saving');
});

check('every control in the panel schedules a save', () => {
    [['bs-accent', 'input'], ['bs-font', 'change'], ['bs-badge', 'change'],
     ['bs-site-base', 'input'], ['bs-site-path', 'input'],
    ].forEach(([id, ev]) => {
        assert.ok(new RegExp(`el\\('${id}'\\)\\.addEventListener\\('${ev}', widgetChanged\\)`).test(widgetWiring),
            `${id} still writes nowhere on ${ev}`);
    });
    // <input type="color"> fires `input` continuously while the swatch is dragged — without the
    // debounce that is a request per frame.
    assert.ok(/setTimeout\(saveWidgetSettings, \d{3}\)/.test(widgetWiring), 'the save is not debounced');
});

check('a save is armed only once the panel shows the org’s OWN settings', () => {
    // The markup default for bs-accent is Be More Swan pink and the font select starts empty; a
    // save fired before applyWidget paints would store those over a real brand.
    const apply = modal.slice(landmark(modal, 'function applyWidget('), landmark(modal, '// ── SEO metadata panel'));
    assert.ok(/state\.widgetReady = true/.test(apply), 'nothing ever arms the autosave');
    const clear = modal.slice(landmark(modal, 'function clearWorkspaceState()'), landmark(modal, '// ── Public API'));
    assert.ok(/state\.widgetReady = false/.test(clear),
        'the modal is reused between opens, so a stale arm survives into the next post');
    // Both ends: the debounce must not be scheduled, AND a timer already in flight must not fire.
    assert.ok(/if \(!state\.widgetReady\) return;/.test(widgetWiring), 'an edit during the load still schedules a save');
    assert.ok(/if \(!state\.widgetReady\) return Promise\.resolve\(\)/.test(widgetSave),
        'a debounce started before the reload still fires into it');
});

check('a half-typed URL is held back, and says so instead of failing silently', () => {
    const guards = modal.slice(landmark(modal, 'function siteBaseState()'), landmark(modal, 'function saveWidgetSettings()'));
    // The hold-back mirrors save-widget-config's own validation — sending "https:/" earns a 400.
    assert.ok(/\^https\?:\\\/\\\/\[\^\\s\/\]\+/.test(guards), 'the base-URL guard no longer matches the server rule');
    assert.ok(/v\.charAt\(0\) === '\/' && v\.indexOf\('\{slug\}'\) >= 0/.test(guards),
        'the path guard no longer matches the server rule');
    // '' is a decision (clear the field), not an unfinished value — it must still be sent.
    assert.ok((guards.match(/return \{ send: true, value: '' \}/g) || []).length === 2,
        'clearing a site field no longer clears it server-side');
    assert.ok(/if \(base\.send\) payload\.siteBaseUrl/.test(widgetSave), 'a valid base URL is not sent');
    assert.ok(/if \(path\.send\) payload\.sitePostPath/.test(widgetSave), 'a valid path is not sent');
    // Silence would be the worst of both: typed, abandoned, never stored, nothing admitting it.
    ['bs-site-base-hint', 'bs-site-path-hint'].forEach((id) => {
        assert.ok(markup.includes('id="' + id + '"'), `${id} is missing, so the hold-back is invisible`);
    });
    assert.ok(/toggleHint\('bs-site-base-hint', !base\.send\)/.test(widgetSave), 'the base hint never appears');
    assert.ok(/toggleHint\('bs-site-path-hint', !path\.send\)/.test(widgetSave), 'the path hint never appears');
    assert.ok(/Saved \\u2014 one field is still waiting/.test(widgetSave),
        'a partial save reports plain "Saved", which is a lie about the held-back field');
});

check('an untouched font survives a change to the accent', () => {
    // ⚠️ The trap this guards. `theme` is ONE json column and the update branch does
    // `updates.theme = checked.theme` — a REPLACE, not a merge. So omitting fontFamily does not
    // preserve the stored face, it deletes it. Assert the server really is wholesale, because the
    // day it starts merging, the client-side merge base below is dead weight and should go.
    const upd = widgetFn.slice(landmark(widgetFn, "if (body.action === 'update')"),
                               landmark(widgetFn, 'if (typeof body.name'));
    assert.ok(/updates\.theme = checked\.theme;/.test(upd),
        'save-widget-config no longer replaces the theme wholesale — re-check the client merge base');
    // Hence: re-send what the panel is not changing.
    assert.ok(/var stack = el\('bs-font'\)\.value;/.test(widgetSave), 'the picker is no longer the first source');
    assert.ok(/if \(!stack && stored\.fontFamily\)/.test(widgetSave),
        'an empty picker sends no fontFamily, which wipes the stored one');
    // ...but NOT blindly. A family retired from the catalogue is refused by findBlogFont, and
    // re-sending it would 400 the whole save — losing the accent too, from a panel that cannot
    // show the author the value it is choking on.
    assert.ok(/stack = \(!catalogue \|\| catalogue\.get\(stored\.fontFamily\)\) \? stored\.fontFamily : '';/.test(widgetSave),
        'a stack the catalogue no longer offers is re-sent, which 400s every save from this panel');
    assert.ok(/null when it isn't one we offer/.test(read('../src/generated/platform-constants.js')),
        'BlogFonts.get no longer answers null for an unknown stack, so the guard above is inert');
    assert.ok(/if \(!font\) return \{ error: 'theme\.fontFamily is not one of the available fonts\.' \}/.test(widgetFn),
        'the server no longer rejects an unknown family — re-check whether the guard is still needed');
    const apply = modal.slice(landmark(modal, 'function applyWidget('), landmark(modal, '// ── SEO metadata panel'));
    assert.ok(/state\.widgetTheme = theme;/.test(apply), 'nothing records what was last stored');
    assert.ok(/state\.widgetTheme = res\.body\.config\.theme/.test(widgetSave),
        'the merge base goes stale after the first save');
    // Still guarded at the bottom: '' really does mean "never chosen", and the server reads that
    // as a reset to DEFAULT_FONT_STACK — recording a choice nobody made.
    assert.ok(/if \(stack\) payload\.theme\.fontFamily = stack;/.test(widgetSave),
        'an empty stack is sent as a deliberate reset');
    assert.ok(/theme\.fontFamily = DEFAULT_FONT_STACK/.test(widgetFn), 'the reset-on-empty rule moved — re-check the guard');
});

check('the response never repaints the inputs', () => {
    // applyWidget would yank a half-typed URL out from under the person still typing it.
    assert.ok(!/applyWidget\(/.test(codeOnly(widgetSave)), 'the save handler repaints the panel from the server');
});

check('nothing is lost to the debounce window', () => {
    // Leaving a field is the author saying they are done with it.
    ['bs-site-base', 'bs-site-path'].forEach((id) => {
        assert.ok(new RegExp(`el\\('${id}'\\)\\.addEventListener\\('blur'`).test(widgetWiring),
            `${id} sits on the debounce when the author moves on`);
    });
    assert.ok(/state\.flushWidgetSettings = function \(\)/.test(widgetWiring),
        'no flush is exposed, so closeBlogStudio cannot reach the pending save');
    const close = modal.slice(landmark(modal, 'function closeBlogStudio()'), landmark(modal, 'function closeBlogStudio()') + 700);
    assert.ok(/if \(state\.flushWidgetSettings\) state\.flushWidgetSettings\(\);/.test(close),
        'closing inside the debounce window drops the last edit');
    // The flush must run BEFORE the editor teardown clears state, not after.
    assert.ok(landmark(close, 'state.flushWidgetSettings()') < landmark(close, 'state.editor.destroy'),
        'the flush runs after the modal has already begun tearing down');
});

console.log('\n(12) AI image generation is preflighted, not discovered from a 403\n');

// Generating images is an admin-managed capability of an assistant TYPE (assistant_features).
// My Content resolves it on modal-open and hides its AI tab; Blog Studio rendered a live-looking
// "Ask <name> to generate" button regardless, and the only feedback an org without the capability
// got was generate-ai-image's raw 403 sentence, printed into the status line after they had already
// written a prompt.
const caps = modal.slice(landmark(modal, 'function loadMediaCapabilities()'),
                         landmark(modal, 'function openAiForm()'));
const openStudio = modal.slice(landmark(modal, 'function openBlogStudio('),
                               landmark(modal, 'function notifyChanged()'));
const aiGenerate = modal.slice(landmark(modal, "mediaEls.aiGo.addEventListener('click'"),
                               landmark(modal, 'mediaEls.pexelsGo.addEventListener'));

check('the capability is resolved from the same endpoint My Content preflights against', () => {
    assert.ok(/api\('get-ai-credit-balance'/.test(caps), 'nothing asks whether the org may generate at all');
    assert.ok(/res\.body\.canImage/.test(caps), 'the answer is fetched but canImage is never read');
    // Same source of truth as my-content.js's _mcLoadCapabilities — if that endpoint stops
    // reporting the flag, both surfaces are wrong together rather than one silently drifting.
    assert.ok(/canImage/.test(read('../netlify/functions/get-ai-credit-balance.ts')),
        'get-ai-credit-balance no longer reports canImage — the preflight has nothing to read');
});

check('a failed lookup closes the control rather than opening it', () => {
    assert.ok(/\.catch\(function \(\) \{ state\.canImage = false; \}\)/.test(caps),
        'a network failure leaves the last answer standing — the button must fail shut');
});

check('the control is resolved on every open, from a closed start', () => {
    assert.ok(/state\.canImage = false;/.test(openStudio), 'the previous org’s answer is reused');
    assert.ok(/loadMediaCapabilities\(\)/.test(openStudio), 'the capability is never resolved on open');
    // Painting the closed state first is what stops a stale capability flashing a live button.
    assert.ok(landmark(openStudio, 'state.canImage = false;') < landmark(openStudio, 'loadMediaCapabilities()'),
        'the reset lands after the fetch is armed, so a stale answer can still paint');
});

check('an org without the capability sees a disabled button AND the reason', () => {
    assert.ok(/btn\.disabled = !can;/.test(caps), 'the generate button stays clickable without the capability');
    assert.ok(/setAttribute\('title', AI_UNAVAILABLE\)/.test(caps), 'a disabled button with no title explains nothing');
    assert.ok(markup.includes('id="bs-ai-unavailable"'), 'there is nowhere on screen to say why the button is dead');
    assert.ok(/note\.classList\.toggle\('bs-hidden', can\)/.test(caps),
        'the explanation does not track the capability');
    // A disabled button that looks identical to a live one is the original fault in a new place.
    assert.ok(/\.bs-btn:disabled\{[^}]*opacity/.test(styles), 'disabled buttons are not visibly disabled');
    // openAiForm is reachable programmatically; the prompt box must not be.
    const guard = modal.slice(landmark(modal, 'function openAiForm()'), landmark(modal, 'function openPexelsForm()'));
    assert.ok(/if \(!state\.canImage\)/.test(guard), 'the prompt box opens even when the server would refuse');
});

check('feature_unavailable is handled, not printed', () => {
    assert.ok(/res\.body\.code === 'feature_unavailable'/.test(aiGenerate),
        'the 403 code is ignored, so the server sentence lands in the status line verbatim');
    assert.ok(/state\.canImage = false;[\s\S]{0,120}applyMediaCapabilities\(\)/.test(aiGenerate),
        'a capability revoked mid-session leaves the button live for the next attempt');
    // The code the client keys on has to be the one the server sends.
    assert.ok(/code: 'feature_unavailable'/.test(read('../src/utils/assistant-capabilities.ts')),
        'featureUnavailableResponse no longer sends that code — the client branch is dead');
    // 402's `error` is the machine string 'insufficient_credits'; the same fault, one branch over.
    assert.ok(/res\.body\.error === 'insufficient_credits'/.test(aiGenerate),
        'an out-of-credits org is shown the raw machine code');
});

console.log(`\n${passed} checks passed.\n`);
