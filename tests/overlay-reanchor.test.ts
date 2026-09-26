// tests/overlay-reanchor.test.ts
// Keeping text with its clip when the cut changes (_pceReanchorOverlays in workspace.html).
//
// Overlays are stored in seconds of the FINISHED video, because that is what the renderer times
// them against — and that is exactly what makes every one of them wrong the moment a clip's length
// changes. Trim two seconds off clip one and every box after it points two seconds late; trim clip
// one from ten seconds to five and a box at 5s-7s of it never shows at all.
//
// The arithmetic is lifted out of the page and run for real, because "the text still displays" is
// not something a source scan can tell you. The extraction is verbatim and the last check asserts
// the page still contains the function it ran.
//
// Run:  npx tsx tests/overlay-reanchor.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const workspace = readFileSync(join(import.meta.dirname, '..', 'workspace.html'), 'utf8');

function slice(from: string, to: string): string {
    const a = workspace.indexOf(from);
    const b = workspace.indexOf(to, a + 1);
    assert.notStrictEqual(a, -1, `marker missing: ${from}`);
    assert.ok(b > a, `marker missing after it: ${to}`);
    return workspace.slice(a, b);
}

const prelude = `
const _pceClipDurations = {};
function _pceClipLength(c) {
  const full = _pceClipDurations[c.assetId] != null ? _pceClipDurations[c.assetId] : c.sourceDurationS;
  const inS = c.inS || 0;
  if (c.outS != null) return Math.max(0, c.outS - inS);
  if (full == null) return null;
  return Math.max(0, full - inS);
}
function _pceClips() { return []; }
`;
const src = prelude + slice('function _pceSpansFor(clips)', 'window._pceOverlayToClip = function');
const mod = new Function(src + '; return { _pceSpansFor, _pceSpanAt, _pceReanchorOverlays };')() as any;
const { _pceSpansFor: spansFor, _pceReanchorOverlays: reanchor } = mod;

const clip = (id: string, assetId: number, len: number, over: Record<string, unknown> = {}) =>
    ({ id, assetId, sourceDurationS: len, ...over });

console.log('\nthe case that was reported');

check('a 2s box 5s into a 10s clip survives that clip becoming 5s', () => {
    // Before: it showed 5s-7s. After the trim that moment does not exist, and the box never showed.
    const A = clip('a', 1, 10), B = clip('b', 2, 10);
    const post = { overlays: [{ id: 'x', startS: 5, endS: 7 }] };
    const before = spansFor([A, B]);
    assert.strictEqual(reanchor(post, before, [clip('a', 1, 10, { outS: 5 }), B]), true);
    // Still on clip one, still two seconds — pulled back rather than squashed.
    assert.deepStrictEqual([post.overlays[0].startS, post.overlays[0].endS], [3, 5]);
});

check('the duration is preserved, not clamped to whatever is left', () => {
    // Clamping the start alone would leave 4.8s-5s: "displays" in the same sense a single frame does.
    const A = clip('a', 1, 10);
    const post = { overlays: [{ id: 'x', startS: 8, endS: 9.5 }] };
    const before = spansFor([A]);
    reanchor(post, before, [clip('a', 1, 10, { outS: 4 })]);
    const shown = (post.overlays[0].endS ?? 4) - (post.overlays[0].startS ?? 0);
    assert.ok(Math.abs(shown - 1.5) < 0.001, `kept ${shown}s of a 1.5s box`);
});

console.log('\nwhat else moves the boundaries');

check('trimming an EARLIER clip carries later text with it', () => {
    // Every boundary after the trim shifts; a box on clip two is otherwise two seconds late forever.
    const A = clip('a', 1, 10), B = clip('b', 2, 10);
    const post = { overlays: [{ id: 'x', startS: 12, endS: 14 }] };   // 2s into clip B
    reanchor(post, spansFor([A, B]), [clip('a', 1, 10, { outS: 8 }), B]);
    assert.deepStrictEqual([post.overlays[0].startS, post.overlays[0].endS], [10, 12]);
});

check('a reorder carries text with its own footage, not with the position', () => {
    // Anchored by clip ID. By index, text would stay on "whatever is third now".
    const A = clip('a', 1, 10), B = clip('b', 2, 10);
    const post = { overlays: [{ id: 'y', startS: 12, endS: 14 }] };   // 2s into B
    reanchor(post, spansFor([A, B]), [B, A]);                          // B is now first
    assert.deepStrictEqual([post.overlays[0].startS, post.overlays[0].endS], [2, 4]);
});

check('a removed clip hands its text to whatever took its place, never drops it', () => {
    // Losing text the reviewer wrote is the one unrecoverable answer.
    const A = clip('a', 1, 10), B = clip('b', 2, 10), C = clip('c', 3, 10);
    const post = { overlays: [{ id: 'z', startS: 12, endS: 14 }] };   // on B
    reanchor(post, spansFor([A, B, C]), [A, C]);                       // B is gone
    assert.ok(post.overlays[0].startS != null, 'the text must still exist');
    assert.ok(post.overlays[0].startS >= 10, 'and sit on the clip that took B’s place');
});

console.log('\nsafety');

check('a box already inside its clip is left exactly where it was', () => {
    const A = clip('a', 1, 10), B = clip('b', 2, 10);
    const post = { overlays: [{ id: 'x', startS: 2, endS: 4 }] };
    const moved = reanchor(post, spansFor([A, B]), [A, B]);
    assert.strictEqual(moved, false, 'an unchanged cut must not rewrite anything');
    assert.deepStrictEqual([post.overlays[0].startS, post.overlays[0].endS], [2, 4]);
});

check('nothing is attempted while a clip is still being measured', () => {
    // An unmeasured clip has no honest length, and guessing one would move text against a number
    // that is about to change.
    const post = { overlays: [{ id: 'x', startS: 2, endS: 4 }] };
    assert.strictEqual(reanchor(post, null, [clip('a', 1, 10)]), false);
    assert.strictEqual(reanchor(post, spansFor([clip('a', 1, 10)]), [{ id: 'n', assetId: 9 }]), false);
    assert.deepStrictEqual([post.overlays[0].startS, post.overlays[0].endS], [2, 4]);
});

check('the page still contains the function this ran', () => {
    assert.ok(workspace.includes('function _pceReanchorOverlays(post, oldSpans, newClips)'));
    // ...and calls it BEFORE the new cut overwrites the old one.
    const at = workspace.indexOf('function _pceClipsChanged(clips)');
    const scope = workspace.slice(at, at + 1200);
    assert.ok(scope.indexOf('_pceSpansFor(_pceClips(post))') < scope.indexOf('_pcePersistVideoEdit('),
        'the old cut must be read before it is replaced');
});

console.log(`\n${passed} checks passed`);
