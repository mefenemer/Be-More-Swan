// tests/post-render.test.ts
// The pure half of the video-overlay render pipeline (src/lib/post-render.ts): which overlays are
// worth rendering, and the frame metadata put on the queued job.
//
// Worth testing without a browser or a Lambda because every input here is untrusted or absent —
// width/height/duration are read off a <video> element in the client and content_assets stores no
// duration at all — and a NaN or odd-numbered value does not fail fast: it fails 40 seconds into a
// billed render, or silently truncates a published clip.
//
// Run:  npx tsx tests/post-render.test.ts

import assert from 'node:assert';
import { frameMeta, frameMetaFromJson, renderableOverlays, MAX_RENDER_SECONDS, RENDER_FPS } from '../src/lib/post-render';
import type { VideoBase } from '../src/lib/post-render';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const base = (over: Partial<VideoBase> = {}): VideoBase => ({
    assetId: 1, storageKey: 'content/org-1/x.mp4', externalUrl: null,
    mimeType: 'video/mp4', width: 720, height: 1280, kind: 'video', ...over,
});

check('renderableOverlays keeps only boxes with real text', () => {
    const kept = renderableOverlays([
        { id: 'a', text: 'Hello' },
        { id: 'b', text: '   ' },
        { id: 'c', text: '' },
        { id: 'd' },
        null,
    ]);
    assert.deepEqual(kept.map(o => o.id), ['a']);
});

check('renderableOverlays treats a non-array as no overlays', () => {
    assert.deepEqual(renderableOverlays(null), []);
    assert.deepEqual(renderableOverlays(undefined), []);
    assert.deepEqual(renderableOverlays({ text: 'hi' }), []);
    assert.deepEqual(renderableOverlays('[]'), []);
});

check('frameMeta uses the client numbers when they are sane', () => {
    const m = frameMeta({ width: 1080, height: 1920, durationS: 8 }, base());
    assert.equal(m.width, 1080);
    assert.equal(m.height, 1920);
    assert.equal(m.fps, RENDER_FPS);
    assert.equal(m.durationInFrames, 8 * RENDER_FPS);
});

check('frameMeta falls back to the asset dimensions, then to a portrait default', () => {
    const fromAsset = frameMeta({}, base());
    assert.equal(fromAsset.width, 720);
    assert.equal(fromAsset.height, 1280);
    // content_assets stores width/height only for some providers.
    const noneAtAll = frameMeta({}, base({ width: null, height: null }));
    assert.equal(noneAtAll.width, 1080);
    assert.equal(noneAtAll.height, 1920);
});

check('frameMeta rounds dimensions up to even — h264 rejects odd ones', () => {
    const m = frameMeta({ width: 641, height: 361 }, base());
    assert.equal(m.width, 642);
    assert.equal(m.height, 362);
});

check('frameMeta refuses junk rather than passing NaN to the renderer', () => {
    for (const bad of [NaN, Infinity, -100, 0, 'wide', null, undefined]) {
        const m = frameMeta({ width: bad, height: bad, durationS: bad }, base());
        assert.equal(m.width, 720, `width from ${String(bad)}`);
        assert.equal(m.height, 1280, `height from ${String(bad)}`);
        assert.equal(m.durationInFrames, 15 * RENDER_FPS, `duration from ${String(bad)}`);
    }
});

check('frameMeta caps a runaway duration and never renders zero frames', () => {
    const huge = frameMeta({ durationS: 99_999 }, base());
    assert.equal(huge.durationInFrames, MAX_RENDER_SECONDS * RENDER_FPS);
    // A sub-frame clip still has to produce a frame.
    const tiny = frameMeta({ durationS: 0.001 }, base());
    assert.equal(tiny.durationInFrames, 1);
});

check('frameMeta caps dimensions so one junk value cannot queue a 40k render', () => {
    const m = frameMeta({ width: 99_999, height: 99_999 }, base());
    assert.equal(m.width, 4096);
    assert.equal(m.height, 4096);
});

check('frameMetaFromJson round-trips what frameMeta wrote', () => {
    const m = frameMeta({ width: 1080, height: 1920, durationS: 12 }, base());
    assert.deepEqual(frameMetaFromJson(JSON.parse(JSON.stringify(m))), m);
});

check('frameMetaFromJson rejects a partial or junk row so the caller recomputes', () => {
    assert.equal(frameMetaFromJson(null), null);
    assert.equal(frameMetaFromJson('{}'), null);
    assert.equal(frameMetaFromJson({ width: 1080, height: 1920, fps: 30 }), null);          // no duration
    assert.equal(frameMetaFromJson({ width: 1080, height: 0, fps: 30, durationInFrames: 90 }), null);
    assert.equal(frameMetaFromJson({ width: 'wide', height: 1920, fps: 30, durationInFrames: 90 }), null);
});

console.log(`\n${passed}/10 passed`);
