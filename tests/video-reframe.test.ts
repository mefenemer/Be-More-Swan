// tests/video-reframe.test.ts
// Phase 4 of docs/video-editing-plan.md: which platforms re-frame the rendered master, and which
// posts may share one render.
//
// Both halves are worth testing without a Lambda because both fail silently and expensively. A
// wrong re-frame publishes a crop nobody chose; a wrong fingerprint match publishes ONE sibling's
// text burned into ANOTHER sibling's video, with no error raised anywhere at any point.
//
// Run:  npx tsx tests/video-reframe.test.ts

import assert from 'node:assert';
import { reframeRatioFor } from '../src/utils/format-router';
import { renderFingerprint, type RenderIdentity } from '../src/lib/post-render';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('\nreframeRatioFor — a 9:16 master');

check('the four platforms that take vertical need no re-frame at all', () => {
    // This is the economic claim the whole plan rests on: one render serves most of the fan-out.
    assert.strictEqual(reframeRatioFor('instagram', 'ig_reel', '9:16'), null);
    assert.strictEqual(reframeRatioFor('linkedin', 'li_video', '9:16'), null);
    assert.strictEqual(reframeRatioFor('x', 'x_video', '9:16'), null);
    assert.strictEqual(reframeRatioFor('youtube', 'yt_short', '9:16'), null);
});

check('Facebook and Threads re-frame, and to the SAME ratio so they share one render', () => {
    const fb = reframeRatioFor('facebook', 'fb_feed', '9:16');
    const th = reframeRatioFor('threads', 'th_text', '9:16');
    assert.strictEqual(fb, '4:5');
    assert.strictEqual(th, '4:5');
    assert.strictEqual(fb, th, 'if these ever diverge the fan-out costs an extra render');
});

check('the closest accepted ratio wins, not the first one listed', () => {
    // fb_feed lists 1:1 first, but 4:5 is nearer 9:16 and throws away less picture.
    assert.strictEqual(reframeRatioFor('facebook', 'fb_feed', '9:16'), '4:5');
});

check('a 16:9 master re-frames the other way', () => {
    assert.strictEqual(reframeRatioFor('youtube', 'yt_vod', '16:9'), null);
    assert.strictEqual(reframeRatioFor('instagram', 'ig_reel', '16:9'), '9:16');
});

check('a format with no live entry falls back to the platform default rather than throwing', () => {
    assert.doesNotThrow(() => reframeRatioFor('instagram', 'made_up_key', '9:16'));
    assert.doesNotThrow(() => reframeRatioFor('nonsense', null, '9:16'));
});

check('an unusable master ratio re-frames nothing', () => {
    assert.strictEqual(reframeRatioFor('facebook', 'fb_feed', 'vertical'), null);
});

console.log('\nrenderFingerprint');

const identity = (over: Partial<RenderIdentity> = {}): RenderIdentity => ({
    videoEdit: { clips: [{ id: 'a', assetId: 11, inS: 1, outS: 4 }, { id: 'b', assetId: 12 }] },
    baseAssetId: 11,
    hasTimelineAudio: false,
    imageOverlays: [{ id: 'o1', text: 'LIVE TONIGHT', x: 0.5, y: 0.2 }],
    audioOverlays: [],
    targetRatio: '9:16',
    framePosition: null,
    ...over,
});

check('the same inputs always give the same fingerprint', () => {
    assert.strictEqual(renderFingerprint(identity()), renderFingerprint(identity()));
});

check('different TEXT means a different file — the sharing bug that would publish the wrong words', () => {
    const other = identity({ imageOverlays: [{ id: 'o1', text: 'DOORS AT 9', x: 0.5, y: 0.2 }] });
    assert.notStrictEqual(renderFingerprint(identity()), renderFingerprint(other));
});

check('a different target ratio is a different file', () => {
    assert.notStrictEqual(renderFingerprint(identity()), renderFingerprint(identity({ targetRatio: '4:5' })));
});

check('a different crop position is a different file', () => {
    const moved = identity({ targetRatio: '4:5', framePosition: { offsetX: 0, offsetY: -1 } });
    const centred = identity({ targetRatio: '4:5', framePosition: null });
    assert.notStrictEqual(renderFingerprint(moved), renderFingerprint(centred));
});

check('a different cut is a different file', () => {
    const recut = identity({ videoEdit: { clips: [{ id: 'a', assetId: 11, inS: 2, outS: 4 }, { id: 'b', assetId: 12 }] } });
    assert.notStrictEqual(renderFingerprint(identity()), renderFingerprint(recut));
});

check('a different clip ORDER is a different file', () => {
    const reordered = identity({ videoEdit: { clips: [{ id: 'b', assetId: 12 }, { id: 'a', assetId: 11, inS: 1, outS: 4 }] } });
    assert.notStrictEqual(renderFingerprint(identity()), renderFingerprint(reordered));
});

check('different sound is a different file', () => {
    const withTrack = identity({ audioOverlays: [{ id: 't', assetId: 99, volume: 1 }] });
    assert.notStrictEqual(renderFingerprint(identity()), renderFingerprint(withTrack));
});

check('muting the camera changes the file even with the same clips', () => {
    // hasTimelineAudio flips the gain default, so the same cut sounds different.
    assert.notStrictEqual(
        renderFingerprint(identity({ hasTimelineAudio: false })),
        renderFingerprint(identity({ hasTimelineAudio: true })),
    );
});

check('with NO edit, two posts differ when their own media differs', () => {
    // The fan-out recomputes each sibling against its OWN base asset. If that were taken from the
    // rendering post instead, a sibling carrying different footage would match and be handed the
    // wrong video.
    const a = identity({ videoEdit: null, baseAssetId: 41 });
    const b = identity({ videoEdit: null, baseAssetId: 42 });
    assert.notStrictEqual(renderFingerprint(a), renderFingerprint(b));
});

check('a clip id is NOT part of the file — only what it renders', () => {
    // Ids are client-generated handles. Two identical cuts must share a render even if the editor
    // relabelled the rows, or the whole dedup stops working after any reorder in the UI.
    const relabelled = identity({ videoEdit: { clips: [{ id: 'zzz', assetId: 11, inS: 1, outS: 4 }, { id: 'yyy', assetId: 12 }] } });
    assert.strictEqual(renderFingerprint(identity()), renderFingerprint(relabelled));
});

console.log(`\n${passed} checks passed`);
