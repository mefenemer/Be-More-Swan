// tests/video-overlay-timing.test.ts
//
// A text box on a video is stored as SECONDS, timed against an axis the editor draws from the
// clip's duration. When the browser cannot read that duration, the editor used to draw the axis
// anyway from a 15-second fallback — so a box placed at 8–14s on a clip that is really 6s long was
// saved with times that exist nowhere:
//
//   preview  — _rqOverlayVisibleAt is never true, because currentTime never reaches 8s
//   render   — overlayFrameRange clamps `from` to the last frame and the box gets ONE frame
//
// Neither surface reports anything. The reviewer sees two text boxes in the editor, approves, and
// the published clip carries one. This asserts the two halves of the fix: the axis is not invented,
// and a box already stranded past the end is pulled back inside the clip rather than lost.
//
// Run:  npx tsx tests/video-overlay-timing.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { overlayFrameRange } from '../src/lib/overlay-geometry';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.log(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const ws = readFileSync(path.join(ROOT, 'workspace.html'), 'utf8');

/** Pull one top-level function out of workspace.html (it is not a module, so this is the only way). */
function extract(signature: string): string {
    const at = ws.indexOf(signature);
    assert.ok(at >= 0, `${signature} not found in workspace.html`);
    const rest = ws.slice(at);
    return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

// Run the reconcile with its two side-effects stubbed, and report what it did.
function runReconcile(overlays: Array<Record<string, unknown>>, dur: number) {
    const persisted: number[] = [];
    const messages: string[] = [];
    const factory = new Function(
        '_rqPersistOverlays', '_pceSetOverlayMsg',
        `${extract('function _rqReconcileOverlayTimes(post, dur) {')}; return _rqReconcileOverlayTimes;`,
    ) as (p: (id: number) => void, m: (t: string) => void) => (post: unknown, dur: number) => void;
    const post = { id: 7, overlays };
    factory((id) => persisted.push(id), (t) => messages.push(t))(post, dur);
    return { overlays, persisted, messages };
}

console.log('\nvideo text-overlay timing\n');

check('a box timed past the end of the clip is pulled back inside it', () => {
    // The reported case: two boxes, the second timed on the 15s fallback axis over a 6s clip.
    const { overlays, persisted, messages } = runReconcile([
        { id: 'a', text: 'first', startS: 0, endS: 3 },
        { id: 'b', text: 'second', startS: 8, endS: 14 },
    ], 6);
    const b = overlays[1] as { startS?: number; endS?: number };
    assert.ok((b.startS ?? 0) < 6, `a start of ${b.startS} on a 6s clip is a box that never appears`);
    assert.ok(b.endS == null || b.endS <= 6, 'the window must end inside the clip');
    assert.deepStrictEqual(persisted, [7], 'the repair has to reach the server, or it undoes itself on reload');
    assert.match(messages[0] || '', /6s/, 'the reviewer is told what happened and to what');
});

check('the repaired box is genuinely visible in the render', () => {
    // The point of the repair: a real frame window, not the one-frame sliver overlayFrameRange
    // produces for anything starting at or past the end.
    const { overlays } = runReconcile([{ id: 'b', text: 'second', startS: 8, endS: 14 }], 6);
    const fps = 30, frames = 6 * fps;
    const range = overlayFrameRange(overlays[0] as never, fps, frames);
    assert.ok(range.durationInFrames > fps, `${range.durationInFrames} frames is a flicker, not a caption`);
});

check('a box already inside the clip is left exactly as the reviewer set it', () => {
    const { overlays, persisted } = runReconcile([{ id: 'a', text: 'first', startS: 1, endS: 4 }], 6);
    assert.deepStrictEqual(overlays[0], { id: 'a', text: 'first', startS: 1, endS: 4 });
    assert.deepStrictEqual(persisted, [], 'nothing changed, so nothing is written');
});

check('an end past the clip becomes "to the end" rather than a phantom time', () => {
    const { overlays } = runReconcile([{ id: 'a', text: 'first', startS: 1, endS: 99 }], 6);
    assert.strictEqual((overlays[0] as { endS?: number }).endS, undefined);
    assert.strictEqual((overlays[0] as { startS?: number }).startS, 1, 'the start it was given is untouched');
});

check('an unreadable clip is never given an invented length', () => {
    // 0 means UNKNOWN. _rqVideoDuration keeps its 15s fallback for drawing an axis, but the timeline
    // and the Start/End controls must both gate on the KNOWN one, or they hand back the guess.
    const known = extract('function _rqVideoDurationKnown() {');
    assert.match(known, /:\s*0;/, 'unknown must be 0, not a plausible default');
    const timeline = extract('function _rqRenderTimeline(post) {');
    assert.match(timeline, /isVideo && !_rqVideoDurationKnown\(\)/,
        'the timeline must refuse to draw a draggable axis it cannot measure');
    const timing = extract('function _pceRefreshOverlayTiming() {');
    assert.match(timing, /!_rqVideoDurationKnown\(\)/,
        'the Start/End inputs are the other way to write seconds against a phantom axis');
});

check('reconciling runs on both metadata paths', () => {
    // A cached <video> already has its metadata when the canvas mounts and fires no loadedmetadata,
    // so hanging the repair only on the event would skip the reopened post entirely.
    const paint = extract('function _rqRenderCanvasOverlays(post) {');
    const calls = paint.match(/_rqReconcileOverlayTimes\(/g) || [];
    assert.strictEqual(calls.length, 2, 'both the loadedmetadata path and the already-loaded path');
});

// ── The other half: the clip has to still be there to be measured ───────────────────────────────
// Both symptoms above start with a <video> that cannot be read. Two server-side causes, each of
// which makes the duration unknowable and the player stall with no error anywhere.

check('a video post gets a preview URL at all', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/get-social-drafts.ts'), 'utf8');
    assert.ok(!/thumbnailUrl = \(await resolvePostImage\(/.test(src),
        'the image-only resolver returns null for a clip — the post comes back carrying no media, '
        + 'the canvas shows its empty state, and overlayCapable goes false so text never mounts');
    assert.match(src, /resolvePostMedia\(db, contentAssetIds\)/, 'image OR video');
    assert.match(src, /thumbnailUrl, mediaType,/,
        'the client picks <video> vs <img> from this; inferring it from the post format renders a clip into an <img>');
});

check('the preview URL outlives an editing session', () => {
    const src = readFileSync(path.join(ROOT, 'netlify/functions/attach-draft-media.ts'), 'utf8');
    assert.match(src, /presignR2Get\(asset\.storageKey, 3600\)/,
        'a clip is streamed in byte ranges across the whole session — at the 10-minute default, '
        + 'pressing play later 403s mid-stream, which fires no error event and just stalls the player');
});

console.log(`\n${passed}/${total} passed\n`);
if (passed !== total) process.exit(1);
