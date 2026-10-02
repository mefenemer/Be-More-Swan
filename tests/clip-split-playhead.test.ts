// tests/clip-split-playhead.test.ts
// Instagram-style cutting in the post editor (2026-10-02): a draggable playhead on each clip's trim
// bar, ✂ Split at it, ⧉ Duplicate. A split is two entries on the SAME asset — the save and the
// renderer already accept that, so the client is the whole feature.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { sanitiseVideoEdit } from '../src/lib/video-edit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = readFileSync(join(root, 'workspace.html'), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const slice = (a: string, b: string) => W.slice(landmark(W, a), landmark(W, b));

check('the server keeps both halves of a split (same asset twice, own windows)', () => {
    const e = sanitiseVideoEdit({ clips: [
        { id: 'a', assetId: 9, outS: 3 },
        { id: 'b', assetId: 9, inS: 3 },
    ] });
    assert.ok(e);
    assert.deepStrictEqual(e!.clips.map(c => [c.id, c.assetId, c.inS ?? null, c.outS ?? null]), [['a', 9, null, 3], ['b', 9, 3, null]]);
});

const SPLIT = slice('window._pceClipSplit = function (i) {', 'window._pceClipDuplicate = function (i) {');

check('split cuts at the playhead into [in → t] and [t → out]', () => {
    assert.match(SPLIT, /const first = Object\.assign\(\{\}, clip, \{ outS: t \}\);/);
    assert.match(SPLIT, /const second = Object\.assign\(\{\}, clip, \{ id: _pceNewClipId\(clip\.assetId\), inS: t \}\);/);
    assert.match(SPLIT, /if \(clip\.outS == null\) delete second\.outS;/);
    assert.match(SPLIT, /clips\.splice\(i, 1, first, second\);/);
});

check('split refuses a playhead outside the kept part, and says what to do', () => {
    assert.match(SPLIT, /t < inS \+ EDGE \|\| t > out - EDGE/);
    assert.match(SPLIT, /Drag the pink playhead on this clip/);
    assert.match(SPLIT, /clips\.length >= 20/);
});

check('split does NOT re-anchor text — the finished video keeps its length', () => {
    assert.doesNotMatch(SPLIT, /_pceClipsChanged\(/);
    assert.match(SPLIT, /_pcePersistVideoEdit\(id, next\);/);
});

check('duplicate inserts a copy after the clip and re-anchors like a move', () => {
    const dup = slice('window._pceClipDuplicate = function (i) {', "'clip-play': (el)");
    assert.match(dup, /clips\.splice\(i \+ 1, 0, Object\.assign\(\{\}, clip, \{ id: _pceNewClipId\(clip\.assetId\) \}\)\);/);
    assert.match(dup, /_pceClipsChanged\(/);
});

check('every trim bar draws a playhead and the Split / Duplicate buttons', () => {
    const track = slice('function _pceTrimTrackHtml(clip, index) {', 'async function _pcePersistVideoEdit(');
    assert.match(track, /data-trim-playhead/);
    assert.match(track, /data-pce-act="clip-split"/);
    assert.match(track, /data-pce-act="clip-dup"/);
    assert.match(W, /'clip-split': \(el\) => window\._pceClipSplit\(/);
    assert.match(W, /'clip-dup': \(el\) => window\._pceClipDuplicate\(/);
});

check('the playhead is dragged on the bar, never on a trim handle, and never repaints mid-drag', () => {
    const bind = slice('function _pceBindClipTrimOn(host) {', '/** Move the lit section and its handles without rebuilding the row. */');
    assert.match(bind, /if \(ev\.target\.closest && ev\.target\.closest\('\[data-trim-edge\]'\)\) return;   \/\/ trimming, not scrubbing/);
    assert.match(bind, /_pceCanvasShowFrame\(clip, clamped\);/);
    assert.match(W, /_pceClipDrag\.from != null \|\| _pceScrubDrag\.on === true;/, 'a scrub must count as a drag, or a repaint tears the playhead away');
});

check('the playhead follows the picture only while it plays', () => {
    const tick = slice('function _pceTickPlayhead(media) {', 'function _pceNewClipId(assetId) {');
    assert.match(tick, /media\.paused \|\| _pceScrubDrag\.on \|\| _pceTrimDrag\.on/);
    assert.match(W, /_pcePreviewTick\(media\);\s*_pceTickPlayhead\(media\);/);
});

check('▶ plays from the playhead and toggles play/pause on its own clip', () => {
    const play = slice('window._pcePlayClip = async function (i) {', '// ── The playhead, split and duplicate');
    assert.match(play, /if \(v && v\.paused\) v\.play\(\)\.catch\(\(\) => \{\}\); else if \(v\) v\.pause\(\);/);
    assert.match(play, /await _pcePreviewSeat\(i, at != null/);
    assert.match(W, /async function _pcePreviewSeat\(i, startS\) \{/);
});

console.log(`\n${passed} checks passed`);
