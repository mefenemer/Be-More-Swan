// tests/video-edit.test.ts
// The pure half of the edit list (src/lib/video-edit.ts): what survives sanitising, what counts as
// a real cut, and what trim reaches the renderer.
//
// Worth testing without a browser or a Lambda because every number here arrives untrusted — in/out
// points come off a <video> element in the client and content_assets stores no duration at all —
// and the failure modes are expensive rather than loud. An inverted window is a zero-frame
// composition, which is a hard Remotion error at the END of a billed render. An untouched trim
// counted as a real one gates the post behind a render that changes nothing. And a trim applied to
// the wrong clip publishes the wrong seconds of the wrong footage with no error anywhere.
//
// Run:  npx tsx tests/video-edit.test.ts

import assert from 'node:assert';
import {
    sanitiseVideoEdit, renderableClips, readVideoEdit, clipIsTrimmed, editHasTrim, editChangesMedia,
    resolveTrim, resolveClipGain, parseRatio, frameForRatio, MAX_CLIPS, type VideoClip,
} from '../src/lib/video-edit';
import { needsVideoRender, audioGainAt } from '../src/lib/audio-overlays';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const clip = (over: Partial<VideoClip> = {}): VideoClip => ({ id: 'c1', assetId: 7, ...over });

console.log('\nsanitiseVideoEdit');

check('rejects a payload that is not an object with clips', () => {
    assert.strictEqual(sanitiseVideoEdit(null), null);
    assert.strictEqual(sanitiseVideoEdit([]), null);
    assert.strictEqual(sanitiseVideoEdit('nope'), null);
    assert.strictEqual(sanitiseVideoEdit({}), null);
});

check('rejects more clips than the ceiling', () => {
    const clips = Array.from({ length: MAX_CLIPS + 1 }, (_, i) => ({ assetId: i + 1 }));
    assert.strictEqual(sanitiseVideoEdit({ clips }), null);
});

check('accepts an empty cut', () => {
    const out = sanitiseVideoEdit({ clips: [] });
    assert.deepStrictEqual(out, { clips: [] });
});

check('drops a clip with no usable asset, keeps the rest', () => {
    const out = sanitiseVideoEdit({ clips: [{ assetId: 0 }, { assetId: 'x' }, { assetId: 9 }] });
    assert.strictEqual(out!.clips.length, 1);
    assert.strictEqual(out!.clips[0].assetId, 9);
});

check('an inverted window degrades to "to the end", never a zero-length segment', () => {
    const out = sanitiseVideoEdit({ clips: [{ assetId: 1, inS: 5, outS: 3 }] });
    assert.strictEqual(out!.clips[0].inS, 5);
    assert.strictEqual(out!.clips[0].outS, undefined);
});

check('a zero-length window degrades the same way', () => {
    const out = sanitiseVideoEdit({ clips: [{ assetId: 1, inS: 4, outS: 4 }] });
    assert.strictEqual(out!.clips[0].outS, undefined);
});

check('negative and non-finite times are dropped, not clamped to zero', () => {
    const out = sanitiseVideoEdit({ clips: [{ assetId: 1, inS: -3, outS: Number.NaN }] });
    assert.strictEqual(out!.clips[0].inS, undefined);
    assert.strictEqual(out!.clips[0].outS, undefined);
});

check('gain is clamped to 0..1 and left absent when unset', () => {
    const out = sanitiseVideoEdit({ clips: [{ assetId: 1 }, { assetId: 2, gain: 9 }, { assetId: 3, gain: -2 }] });
    assert.strictEqual('gain' in out!.clips[0], false, 'unset gain must stay absent, not default to 1');
    assert.strictEqual(out!.clips[1].gain, 1);
    assert.strictEqual(out!.clips[2].gain, 0);
});

check('only a well-formed ratio survives', () => {
    assert.strictEqual(sanitiseVideoEdit({ clips: [], targetRatio: '9:16' })!.targetRatio, '9:16');
    assert.strictEqual(sanitiseVideoEdit({ clips: [], targetRatio: 'vertical' })!.targetRatio, undefined);
    assert.strictEqual(sanitiseVideoEdit({ clips: [], targetRatio: '9x16' })!.targetRatio, undefined);
});

check('frame offsets are clamped to -1..1 and an empty map is dropped', () => {
    const out = sanitiseVideoEdit({ clips: [], frames: { facebook: { offsetX: 4, offsetY: -9 } } });
    assert.deepStrictEqual(out!.frames!.facebook, { offsetX: 1, offsetY: -1 });
    assert.strictEqual(sanitiseVideoEdit({ clips: [], frames: {} })!.frames, undefined);
});

check('clip ids are bounded and generated when missing', () => {
    const out = sanitiseVideoEdit({ clips: [{ assetId: 4 }, { assetId: 5, id: 'x'.repeat(200) }] });
    assert.ok(out!.clips[0].id.length > 0);
    assert.strictEqual(out!.clips[1].id.length, 64);
});

console.log('\nclipIsTrimmed / editHasTrim');

check('an untouched clip is NOT a trim', () => {
    assert.strictEqual(clipIsTrimmed(clip()), false);
    assert.strictEqual(clipIsTrimmed(clip({ inS: 0 })), false, 'in at 0 with no out point is the whole clip');
});

check('a real in or out point is a trim', () => {
    assert.strictEqual(clipIsTrimmed(clip({ inS: 0.5 })), true);
    assert.strictEqual(clipIsTrimmed(clip({ outS: 3 })), true);
    assert.strictEqual(clipIsTrimmed(clip({ inS: 0, outS: 3 })), true);
});

check('editHasTrim reads through a stored jsonb value', () => {
    assert.strictEqual(editHasTrim(null), false);
    assert.strictEqual(editHasTrim({ clips: [{ id: 'a', assetId: 1 }] }), false);
    assert.strictEqual(editHasTrim({ clips: [{ id: 'a', assetId: 1 }, { id: 'b', assetId: 2, outS: 2 }] }), true);
});

check('a clip with no asset cannot make the post need a render', () => {
    assert.strictEqual(editHasTrim({ clips: [{ id: 'a', assetId: 0, outS: 2 }] }), false);
});

console.log('\nresolveTrim');

check('an untouched clip resolves to no trim at all', () => {
    assert.strictEqual(resolveTrim(clip(), 30), null);
    assert.strictEqual(resolveTrim(clip({ inS: 0 }), 30), null);
});

check('a bounded window passes through with its duration', () => {
    const t = resolveTrim(clip({ inS: 2, outS: 5 }), 30)!;
    assert.deepStrictEqual([t.inS, t.outS, t.durationS], [2, 5, 3]);
});

check('an out point past the end of the file is clamped to it', () => {
    const t = resolveTrim(clip({ inS: 1, outS: 99 }), 10)!;
    assert.deepStrictEqual([t.inS, t.outS, t.durationS], [1, 10, 9]);
});

check('an in point past the end falls back to the whole clip, never a negative length', () => {
    const t = resolveTrim(clip({ inS: 50, outS: 60 }), 10)!;
    assert.deepStrictEqual([t.inS, t.outS], [0, null]);
});

check('an unknown source duration leaves the numbers for the renderer to clamp', () => {
    const t = resolveTrim(clip({ inS: 2, outS: 5 }), null)!;
    assert.deepStrictEqual([t.inS, t.outS, t.durationS], [2, 5, 3]);
    const open = resolveTrim(clip({ inS: 2 }), null)!;
    assert.strictEqual(open.outS, null);
    assert.strictEqual(open.durationS, null, 'no duration is knowable without the file');
});

check('an open-ended trim against a known file reports the remaining length', () => {
    const t = resolveTrim(clip({ inS: 4 }), 10)!;
    assert.deepStrictEqual([t.inS, t.outS, t.durationS], [4, null, 6]);
});

console.log('\neditChangesMedia');

check('several clips always change the media, even untrimmed', () => {
    // The trap this closes: gating on trimming alone would let an untrimmed four-clip reel skip the
    // render and publish as clip one, alone, with no error anywhere.
    const edit = { clips: [{ id: 'a', assetId: 1 }, { id: 'b', assetId: 2 }] };
    assert.strictEqual(editHasTrim(edit), false);
    assert.strictEqual(editChangesMedia(edit), true);
});

check('one untouched clip changes nothing', () => {
    assert.strictEqual(editChangesMedia({ clips: [{ id: 'a', assetId: 1 }] }), false);
    assert.strictEqual(editChangesMedia({ clips: [{ id: 'a', assetId: 1, inS: 0 }] }), false);
});

check('one trimmed clip changes the media', () => {
    assert.strictEqual(editChangesMedia({ clips: [{ id: 'a', assetId: 1, outS: 3 }] }), true);
});

check('clips with no asset do not count towards the stitch', () => {
    assert.strictEqual(editChangesMedia({ clips: [{ id: 'a', assetId: 1 }, { id: 'b', assetId: 0 }] }), false);
});

console.log('\nframeForRatio');

check('parseRatio takes w:h and rejects anything else', () => {
    assert.deepStrictEqual(parseRatio('9:16'), { w: 9, h: 16 });
    assert.strictEqual(parseRatio('vertical'), null);
    assert.strictEqual(parseRatio(null), null);
});

check('the four ratios we publish land on the documented sizes', () => {
    assert.deepStrictEqual(frameForRatio('9:16'), { width: 1080, height: 1920 });
    assert.deepStrictEqual(frameForRatio('1:1'), { width: 1080, height: 1080 });
    assert.deepStrictEqual(frameForRatio('4:5'), { width: 1080, height: 1350 });
    assert.deepStrictEqual(frameForRatio('16:9'), { width: 1920, height: 1080 });
});

check('an extreme ratio is capped on its long side, not left unbounded', () => {
    const f = frameForRatio('4:1')!;
    assert.strictEqual(Math.max(f.width, f.height), 1920);
});

check('every frame is even — an odd dimension fails the h264 encode at the very end', () => {
    for (const r of ['9:16', '1:1', '4:5', '16:9', '3:2', '5:4', '4:1']) {
        const f = frameForRatio(r)!;
        assert.strictEqual(f.width % 2, 0, `${r} width`);
        assert.strictEqual(f.height % 2, 0, `${r} height`);
    }
});

check('an unusable ratio yields no frame, so the caller measures the source instead', () => {
    assert.strictEqual(frameForRatio('nope'), null);
    assert.strictEqual(frameForRatio(undefined), null);
});

console.log('\nneedsVideoRender with an edit');

check('an edit alone forces a render on a video', () => {
    assert.strictEqual(
        needsVideoRender({ hasVideo: true, textOverlays: 0, audioOverlays: 0, hasEdit: true }),
        true,
    );
});

check('an edit cannot force a render on a still', () => {
    // There is no footage to cut or stitch. Gating a photo post here would strand it: the worker
    // resolves no timeline, bails, and the reviewer sees a render that "did nothing".
    assert.strictEqual(
        needsVideoRender({ hasVideo: false, textOverlays: 0, audioOverlays: 0, hasEdit: true }),
        false,
    );
});

check('the existing rules are unchanged when no edit is present', () => {
    assert.strictEqual(needsVideoRender({ hasVideo: true, textOverlays: 0, audioOverlays: 0 }), false);
    assert.strictEqual(needsVideoRender({ hasVideo: true, textOverlays: 2, audioOverlays: 0 }), true);
    assert.strictEqual(needsVideoRender({ hasVideo: false, textOverlays: 0, audioOverlays: 1 }), true);
});

console.log('\nresolveClipGain');

check('an explicit gain always wins', () => {
    assert.strictEqual(resolveClipGain(clip({ gain: 0.4 }), true), 0.4);
    assert.strictEqual(resolveClipGain(clip({ gain: 1 }), true), 1, 'a deliberate full volume survives music');
    assert.strictEqual(resolveClipGain(clip({ gain: 0 }), false), 0);
});

check('a track on the timeline mutes undecided camera audio', () => {
    assert.strictEqual(resolveClipGain(clip(), true), 0);
});

check('with no track, an undecided clip is left alone rather than forced to 1', () => {
    // undefined, not 1 — the composition then omits the prop entirely and Remotion's own default
    // applies, so an untouched post sounds exactly as it did before any of this existed.
    assert.strictEqual(resolveClipGain(clip(), false), undefined);
});

check('an out-of-range stored gain is clamped', () => {
    assert.strictEqual(resolveClipGain(clip({ gain: 5 }), false), 1);
    assert.strictEqual(resolveClipGain(clip({ gain: -1 }), false), 0);
});

console.log('\naudioGainAt');

const gain = (over: Partial<Parameters<typeof audioGainAt>[0]> = {}) =>
    audioGainAt({ frame: 0, durationInFrames: 100, fps: 30, volume: 1, ...over });

check('with no fades the volume is flat', () => {
    for (const frame of [0, 1, 50, 99, 100]) {
        assert.strictEqual(gain({ frame }), 1, `frame ${frame}`);
    }
});

check('a fade in ramps from silence to the set volume', () => {
    // 1s at 30fps = 30 frames.
    assert.strictEqual(gain({ frame: 0, fadeInS: 1 }), 0);
    assert.strictEqual(gain({ frame: 15, fadeInS: 1 }), 0.5);
    assert.strictEqual(gain({ frame: 30, fadeInS: 1 }), 1);
    assert.strictEqual(gain({ frame: 60, fadeInS: 1 }), 1);
});

check('a fade out ramps to silence at the very last frame', () => {
    assert.strictEqual(gain({ frame: 70, fadeOutS: 1 }), 1);
    assert.strictEqual(gain({ frame: 85, fadeOutS: 1 }), 0.5);
    assert.strictEqual(gain({ frame: 100, fadeOutS: 1 }), 0);
});

check('fades scale the set volume rather than overriding it', () => {
    assert.strictEqual(gain({ frame: 15, volume: 0.5, fadeInS: 1 }), 0.25);
    assert.strictEqual(gain({ frame: 50, volume: 0.5, fadeInS: 1 }), 0.5);
});

check('fades longer than the clip are capped at half each, never above the set volume', () => {
    // A 0.5s fade pair on a 10-frame clip would otherwise overlap and multiply past 1.
    for (let frame = 0; frame <= 10; frame++) {
        const g = audioGainAt({ frame, durationInFrames: 10, fps: 30, volume: 1, fadeInS: 5, fadeOutS: 5 });
        assert.ok(g >= 0 && g <= 1, `frame ${frame} gave ${g}`);
    }
    // Halfway is the peak, and it is reached.
    assert.strictEqual(audioGainAt({ frame: 5, durationInFrames: 10, fps: 30, volume: 1, fadeInS: 5, fadeOutS: 5 }), 1);
});

check('the default 0.05s fades barely touch a normal clip', () => {
    // Their whole job is to stop a click at the edges, not to be audible.
    assert.strictEqual(gain({ frame: 0, fadeInS: 0.05 }), 0);
    assert.strictEqual(gain({ frame: 2, fadeInS: 0.05 }), 1, 'back to full within a couple of frames');
});

check('a junk frame or duration cannot produce NaN', () => {
    assert.strictEqual(gain({ frame: -5, fadeInS: 1 }), 0);
    assert.strictEqual(audioGainAt({ frame: 0, durationInFrames: 0, fps: 30, volume: 1 }), 1);
    assert.ok(Number.isFinite(gain({ frame: 999 })));
});

console.log('\nreadVideoEdit / renderableClips');

check('a legacy or absent value reads as no edit', () => {
    assert.strictEqual(readVideoEdit(null), null);
    assert.strictEqual(readVideoEdit({ notClips: 1 }), null);
    assert.deepStrictEqual(renderableClips(null), []);
});

check('renderableClips drops rows with no asset', () => {
    const clips = renderableClips({ clips: [{ id: 'a', assetId: 3 }, { id: 'b', assetId: 0 }] });
    assert.strictEqual(clips.length, 1);
    assert.strictEqual(clips[0].assetId, 3);
});

console.log(`\n${passed} checks passed`);
