// tests/editor-multi-pick-and-caption-scope.test.ts
// Two post-editor fixes found while preparing the LinkedIn screencast (2026-11-19):
//  1. "Use my own" with several pictures ticked on a multi-picture format (Document carousel, Instagram
//     carousel, X image grid) showed no button at all; now "Use these N pictures" sets them as slides.
//  2. Editing a caption on the post itself saved it to every destination with nothing saying so; the
//     box now says where it saves, with "only this one".
// Run:  npx tsx tests/editor-multi-pick-and-caption-scope.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const html = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
const between = (a: string, b: string) => {
    const i = html.indexOf(a); const j = html.indexOf(b, i + a.length);
    assert.ok(i > 0 && j > i, `section ${a} … ${b} found`);
    return html.slice(i, j);
};

check('the picker bar has a "Use these" button for multi-picture formats', () => {
    assert.ok(html.includes('id="gp-ai-own-slides" onclick="window._pceOwnUseAsSlides()"'));
});

check('several ticked pictures on a multi-picture format show it; the bar is no longer blank', () => {
    const sync = between('function _pceSyncOwnSelection() {', 'window._pceOwnAdd = async function');
    assert.ok(sync.includes("bar?.classList.toggle('hidden', n === 0 || (!canAdd && !canReplace && !canSlides));"));
    assert.ok(sync.includes('const over = fresh > room;') && sync.includes('sl.disabled = over || pickedVideo || fresh === 0;'), 'counts only new pictures; over the room left or nothing new: disabled and says so');
    assert.ok(sync.includes('const fresh = slides ? _pceOwnPicked.filter(id => !slides.ids.includes(id)).length : 0;'));
    assert.ok(sync.includes('const canSlides = !!slides && slides.editable && !_pcePickerAddOnly && n > 1;'), 'hidden where it cannot act');
});

check('multi-picture means an image/mixed format with max > 1 — never video or one-picture formats', () => {
    const lim = between('function _pceOwnSlideLimits() {', 'window._pceOwnUseAsSlides = async function');
    assert.ok(lim.includes("fmt.m === 'video' || fmt.m === 'none' || !(Number(fmt.max) > 1)"));
    assert.ok(lim.includes('if (post.brandCard) return null;'), 'never on a branded-card post, whose slides would be hidden');
    const consts = readFileSync(new URL('../src/generated/platform-constants.js', import.meta.url), 'utf8');
    assert.match(consts, /"k":"li_document"[^}]*"m":"image"[^}]*"max":20/, 'a Document carousel qualifies');
});

check('"Use these" ADDS after the existing slides (never replaces), in tick order, through the one write path', () => {
    const fn = between('window._pceOwnUseAsSlides = async function () {', 'window._pceOwnReplace = async function');
    assert.ok(fn.includes('const existing = _pceSlideIds(post);'));
    assert.ok(fn.includes('const additions = picked.filter(id => !existing.includes(id));'), 'no duplicates');
    assert.ok(fn.includes('const wanted = existing.concat(additions);'), 'existing slides kept, additions after');
    assert.ok(fn.includes('wanted.length > slides.max) return;'), 'never sends more than the format holds');
    assert.ok(fn.includes('await _pcePersistSlides(wanted);'));
});

check('ticks are cleared and the picker closes only when the save really took, in order', () => {
    const fn = between('window._pceOwnUseAsSlides = async function () {', 'window._pceOwnReplace = async function');
    const save = fn.indexOf('await _pcePersistSlides(wanted);');
    const clear = fn.indexOf('_pceOwnPicked = [];');
    assert.ok(save > 0 && clear > save, 'selection kept until after the save');
    assert.ok(fn.includes('now.every((id, i) => id === wanted[i])'), 'order checked, not just presence');
});

check('a picture-only format refuses ticked videos, and the room left is what counts', () => {
    const sync = between('function _pceSyncOwnSelection() {', 'window._pceOwnAdd = async function');
    assert.ok(sync.includes("slides.picturesOnly && _pceOwnPicked.some(id => (_pceOwnAssets[id] || {}).type === 'video')"));
    assert.ok(sync.includes('const room = slides ? Math.max(0, slides.max - slides.have) : 0;'));
    const lim = between('function _pceOwnSlideLimits() {', 'window._pceOwnUseAsSlides = async function');
    assert.ok(lim.includes("picturesOnly: fmt.m === 'image'"));
    assert.ok(html.includes('_pceOwnAssets[a.id] = { name: a.name, url: thumb, type: a.assetType };'), 'the tile records its kind');
});

check('the inline caption box says where it saves and offers "only this one"', () => {
    const box = between("hint.textContent = 'Click away to save · Esc to cancel';", 'host.innerHTML = \'\';');
    assert.ok(box.includes("const allCb = _pceEl('post-review-amend-all-cb');"));
    assert.ok(box.includes('Saves to all ${n} destinations'));
    assert.ok(box.includes('data-pce-caption-scope="one"') && box.includes('Saves to this destination only'));
    assert.ok(box.includes("hint.addEventListener('mousedown'") && box.includes('ev.preventDefault();'), 'changing scope does not blur-save first');
});

check('the save still follows the one checkbox the side panel uses', () => {
    assert.ok(html.includes("const applyAll = _rqReviewGroupIds.length > 1 && document.getElementById('post-review-amend-all-cb')?.checked;"));
});

console.log(`\n${passed} passed`);
