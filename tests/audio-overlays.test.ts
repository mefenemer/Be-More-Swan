// tests/audio-overlays.test.ts
// The timed-audio model (src/lib/audio-overlays.ts) — voice notes and sound placed on a post.
//
// Worth testing without a browser or a Lambda for the same reason the text overlay maths is: every
// input is untrusted, and the failures are silent rather than loud. A clip with an inverted window
// doesn't throw — it just never plays. A cross-tenant asset id doesn't throw — it publishes someone
// else's audio. And needsVideoRender decides whether a PHOTO post quietly becomes a video, which is
// the most surprising consequence in the whole feature.
//
// Run:  npx tsx tests/audio-overlays.test.ts

import assert from 'node:assert';
import {
    sanitiseAudioOverlays, renderableAudio, needsVideoRender, audioExtentS,
    MAX_AUDIO_OVERLAYS, AUDIO_DEFAULTS,
} from '../src/lib/audio-overlays';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('a plain clip round-trips with defaults filled in', () => {
    const [a] = sanitiseAudioOverlays([{ assetId: 7, label: 'Intro' }])!;
    assert.equal(a.assetId, 7);
    assert.equal(a.label, 'Intro');
    assert.equal(a.volume, AUDIO_DEFAULTS.volume);
    assert.ok(a.id, 'an id is generated when none is given');
    // No bounds = the whole post. That equivalence is the reason there is one model and not two.
    assert.equal(a.startS, undefined);
    assert.equal(a.endS, undefined);
});

check('an inverted or zero-length window degrades to “the whole post”', () => {
    // Never a clip that silently never plays — same rule the text overlays use.
    const [inverted] = sanitiseAudioOverlays([{ assetId: 1, startS: 5, endS: 2 }])!;
    assert.equal(inverted.startS, 5);
    assert.equal(inverted.endS, undefined);
    const [zero] = sanitiseAudioOverlays([{ assetId: 1, startS: 3, endS: 3 }])!;
    assert.equal(zero.endS, undefined);
});

check('clips with no usable asset are dropped, not rendered as silence', () => {
    const out = sanitiseAudioOverlays([
        { assetId: 5 }, { assetId: 0 }, { assetId: -2 }, { assetId: 'x' }, { label: 'no asset' },
    ])!;
    assert.deepEqual(out.map(a => a.assetId), [5]);
});

check('junk times and volumes are replaced, never passed to the renderer', () => {
    const [a] = sanitiseAudioOverlays([
        { assetId: 1, startS: NaN, endS: Infinity, volume: 'loud', fadeInS: -3 },
    ])!;
    assert.equal(a.startS, undefined);
    assert.equal(a.endS, undefined);
    assert.equal(a.volume, 0, 'an unparseable volume becomes 0 rather than NaN');
    assert.equal(a.fadeInS, AUDIO_DEFAULTS.fadeInS, 'a negative fade falls back to the default');
});

check('volume is clamped to 0..1', () => {
    assert.equal(sanitiseAudioOverlays([{ assetId: 1, volume: 9 }])![0].volume, 1);
    assert.equal(sanitiseAudioOverlays([{ assetId: 1, volume: -4 }])![0].volume, 0);
    assert.equal(sanitiseAudioOverlays([{ assetId: 1, volume: 0.35 }])![0].volume, 0.35);
});

check('a non-array or oversized payload is refused outright', () => {
    assert.equal(sanitiseAudioOverlays(null), null);
    assert.equal(sanitiseAudioOverlays('[]'), null);
    assert.equal(sanitiseAudioOverlays({ assetId: 1 }), null);
    const tooMany = Array.from({ length: MAX_AUDIO_OVERLAYS + 1 }, () => ({ assetId: 1 }));
    assert.equal(sanitiseAudioOverlays(tooMany), null);
    assert.ok(sanitiseAudioOverlays(tooMany.slice(1)) !== null, 'exactly the cap is allowed');
});

check('text and labels are bounded so the DB cannot take unbounded input', () => {
    const [a] = sanitiseAudioOverlays([{ assetId: 1, label: 'x'.repeat(500), id: 'y'.repeat(500) }])!;
    assert.equal(a.label!.length, 120);
    assert.equal(a.id.length, 64);
});

check('renderableAudio keeps only clips that point at an asset', () => {
    assert.deepEqual(renderableAudio([{ id: 'a', assetId: 3 }, { id: 'b', assetId: 0 }, null]).map(a => a.id), ['a']);
    assert.deepEqual(renderableAudio(null), []);
    assert.deepEqual(renderableAudio('nope'), []);
});

check('needsVideoRender: audio forces a render on ANYTHING, text only on video', () => {
    // The surprising one, and the reason this is a named function: a photo post with a voice note
    // becomes a video at approval time, because no platform takes a still with sound.
    assert.equal(needsVideoRender({ hasVideo: false, textOverlays: 0, audioOverlays: 1 }), true);
    assert.equal(needsVideoRender({ hasVideo: true, textOverlays: 0, audioOverlays: 1 }), true);
    // A photo's text still bakes in the browser — faster, free, and font-perfect.
    assert.equal(needsVideoRender({ hasVideo: false, textOverlays: 3, audioOverlays: 0 }), false);
    assert.equal(needsVideoRender({ hasVideo: true, textOverlays: 3, audioOverlays: 0 }), true);
    // Nothing on it at all — never burn a Lambda render to reproduce the original.
    assert.equal(needsVideoRender({ hasVideo: true, textOverlays: 0, audioOverlays: 0 }), false);
    assert.equal(needsVideoRender({ hasVideo: false, textOverlays: 0, audioOverlays: 0 }), false);
});

check('audioExtentS reports the bounded end and which clips still need measuring', () => {
    // Audio can outlast its backdrop, so the render length depends on this being right.
    const { boundedEndS, unbounded } = audioExtentS([
        { id: 'a', assetId: 1, volume: 1, startS: 0, endS: 4 },
        { id: 'b', assetId: 2, volume: 1, startS: 2, endS: 9 },
        { id: 'c', assetId: 3, volume: 1, startS: 1 },
    ]);
    assert.equal(boundedEndS, 9);
    assert.deepEqual(unbounded.map(a => a.id), ['c'], 'an unbounded clip can only be measured from the file');
    assert.deepEqual(audioExtentS([]), { boundedEndS: 0, unbounded: [] });
});

console.log(`\n${passed}/10 passed`);
