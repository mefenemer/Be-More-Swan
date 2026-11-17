// tests/scene-cover.test.ts
// Walkthrough layouts (docs/video-producer-screen-walkthrough-plan.md §3, Phases 1–2): a screen shown with or
// instead of the presenter while they keep talking — the cover model, its place on the timeline, the presenter's
// clips split at its edges, the storyboard rules that keep it, the chat card, and the composition that draws it.
//
// Run:  npx tsx tests/scene-cover.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    applyCovers, bubbleBox, captionLiftPct, cornerOf, coverWindow, readSceneCover, seriesClock, windowBox, type TimelineCover,
} from '../src/lib/scene-cover';
import { enforceStoryboard, type Scene, type VideoBrief } from '../src/lib/storyboard';
import { assetsForShape, timelineCovers, timesOf } from '../src/utils/video-producer';
import { coverFromRequest, videoSceneCard, videoSceneRequestFromUiElement } from '../src/utils/chat-video-scene';
import type { VideoClip } from '../src/lib/video-edit';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const own = new Map([[11, 60], [12, 120]]);   // presenter take, screen recording (seconds)
const ctx = { own, library: new Set([90]) };

check('readSceneCover keeps a good screen and drops what isn\'t theirs', () => {
    assert.deepStrictEqual(readSceneCover({ layout: 'bubble', source: 'own_video', assetId: 12, inS: 8 }, ctx), { layout: 'bubble', source: 'own_video', assetId: 12, inS: 8 });
    assert.strictEqual(readSceneCover({ layout: 'bubble', source: 'own_video', assetId: 99 }, ctx), null, 'not one of the brief\'s videos');
    assert.strictEqual(readSceneCover({ layout: 'bubble', source: 'product_photo', assetId: 5 }, ctx), null, 'not in the library');
    assert.strictEqual(readSceneCover({ layout: 'sideways', source: 'own_video', assetId: 12 }, ctx), null);
    assert.strictEqual(readSceneCover({ layout: 'bubble', source: 'ai_video' }, ctx), null, 'AI never: a cover must not spend');
    // A start past the end is pulled back to leave a second; the default corner isn't stored; size only on a bubble.
    assert.strictEqual(readSceneCover({ layout: 'cover', source: 'own_video', assetId: 12, inS: 500 }, ctx)!.inS, 119);
    assert.strictEqual(readSceneCover({ layout: 'bubble', source: 'stock_video', keywords: 'laptop', corner: 'br' }, ctx)!.corner, undefined);
    assert.strictEqual(readSceneCover({ layout: 'bubble', source: 'stock_video', corner: 'tl', size: 'small' }, ctx)!.corner, 'tl');
    assert.strictEqual(readSceneCover({ layout: 'window', source: 'stock_video', size: 'small' }, ctx)!.size, undefined);
    assert.strictEqual(readSceneCover({ layout: 'cover', source: 'stock_video', corner: 'tl' }, ctx)!.corner, undefined, 'screen only has no corner');
    assert.strictEqual(cornerOf({ layout: 'bubble' }), 'br');
    assert.strictEqual(cornerOf({ layout: 'window' }), 'bl');
});

check('coverWindow sits inside its scene and needs half a second', () => {
    assert.deepStrictEqual(coverWindow({}, 10, 6), { startS: 10, endS: 16 });
    assert.deepStrictEqual(coverWindow({ fromS: 2, toS: 4 }, 10, 6), { startS: 12, endS: 14 });
    assert.deepStrictEqual(coverWindow({ fromS: 2, toS: 40 }, 10, 6), { startS: 12, endS: 16 });
    assert.strictEqual(coverWindow({ fromS: 5.8 }, 10, 6), null);
});

check('applyCovers splits the presenter\'s pieces at a cover\'s edges and lays each piece out', () => {
    // Two tightened pieces of the presenter's file: 0–4 s (out 0–4) and 4–10 s (out 4–10).
    const clips: VideoClip[] = [
        { id: 'vp_s1_1', assetId: 11, inS: 1, outS: 5, gain: 1 },
        { id: 'vp_s1_2', assetId: 11, inS: 7, outS: 13, gain: 1 },
    ];
    const out = applyCovers(clips, [{ startS: 2, endS: 6, layout: 'bubble', corner: 'tr', size: 'small' }]);
    assert.deepStrictEqual(out.map((c) => [c.inS, c.outS, c.layout ?? 'full', c.corner ?? '', c.size ?? '']), [
        [1, 3, 'full', '', ''], [3, 5, 'bubble', 'tr', 'small'],   // first piece: 0–2 full, 2–4 bubble
        [7, 9, 'bubble', 'tr', 'small'], [9, 13, 'full', '', ''],  // second: 4–6 bubble, 6–10 full
    ]);
    assert.ok(new Set(out.map((c) => c.id)).size === out.length, 'ids stay unique');
    // Screen only: hidden (still heard). A window leaves the presenter alone.
    assert.strictEqual(applyCovers(clips, [{ startS: 0, endS: 10, layout: 'cover' }]).every((c) => c.layout === 'hidden' && c.gain === 1), true);
    assert.deepStrictEqual(applyCovers(clips, [{ startS: 0, endS: 10, layout: 'window' }]), clips);
    // A still is never split.
    const still: VideoClip = { id: 'card', assetId: 5, kind: 'image', holdS: 3 };
    assert.deepStrictEqual(applyCovers([still], [{ startS: 0, endS: 2, layout: 'bubble' }]), [still]);
});

const brief: VideoBrief = { purpose: 'promo', lengthS: 60, message: 'A tour of our booking system', voiceover: false, allowAi: 'stock_only', footageAssetIds: [11, 12], shape: '16:9' };
const footage = [{ id: 11, name: 'me.mp4', durationS: 60 }, { id: 12, name: 'screen.webm', durationS: 120 }];

check('enforceStoryboard keeps a cover on an own-video scene, and only there', () => {
    const { storyboard, changes } = enforceStoryboard({ title: 't', caption: 'c', scenes: [
        { beat: 'hook', voiceover: '', source: 'own_video', assetId: 11, inS: 0, outS: 8, targetS: 8, cover: { layout: 'bubble', source: 'own_video', assetId: 12, inS: 30 } },
        { beat: 'value', voiceover: '', source: 'own_video', assetId: 11, inS: 8, outS: 20, targetS: 12, cover: { layout: 'bubble', source: 'own_video', assetId: 77 } },
        { beat: 'cta', voiceover: 'Book now', source: 'brand_card', targetS: 3, cover: { layout: 'cover', source: 'stock_video' } },
    ] }, brief, [], footage);
    assert.deepStrictEqual(storyboard.scenes[0].cover, { layout: 'bubble', source: 'own_video', assetId: 12, inS: 30 });
    assert.strictEqual(storyboard.scenes[1].cover, undefined);
    assert.ok(changes.some((c) => /Scene 2: that screen isn't one of your chosen videos/.test(c)));
    assert.strictEqual(storyboard.scenes[2].cover, undefined, 'a branded card has no presenter to cover');
});

check('timelineCovers: output seconds, never past the file, screen recordings shown whole', () => {
    const scenes: Scene[] = [
        { id: 's1', beat: 'hook', voiceover: '', source: 'own_video', assetId: 11, inS: 0, outS: 8, targetS: 8 },
        { id: 's2', beat: 'value', voiceover: '', source: 'own_video', assetId: 11, inS: 8, outS: 20, targetS: 12, cover: { layout: 'bubble', source: 'own_video', assetId: 12, inS: 115 } },
        { id: 's3', beat: 'value', voiceover: '', source: 'own_video', assetId: 11, inS: 20, outS: 26, targetS: 6, cover: { layout: 'window', source: 'stock_photo', keywords: 'calendar', corner: 'tr' } },
    ];
    const times = timesOf(scenes, [8, 12, 6]);
    const covers = timelineCovers(scenes, { s1: 11, s2: 11, 's2~cover': 12, s3: 11, 's3~cover': 300 }, times, (id) => (id === 12 ? 120 : undefined));
    assert.deepStrictEqual(covers, [
        // Starts 115 s into a 120 s file: stops after 4.95 s instead of asking for frames past the end.
        { id: 'vp_cover_s2', assetId: 12, kind: 'video', startS: 8, endS: 12.95, inS: 115, layout: 'bubble', corner: 'br', fit: 'contain' },
        { id: 'vp_cover_s3', assetId: 300, kind: 'image', startS: 20, endS: 26, layout: 'window', corner: 'tr', fit: 'cover', motion: 'push_in' },
    ] satisfies TimelineCover[]);
    // A cover with no made asset is skipped (the build fails earlier with a message instead).
    assert.deepStrictEqual(timelineCovers(scenes, { s2: 11 }, times, () => 120), []);
});

check('another shape keeps their own screen and finds stock again', () => {
    const sb = { title: 't', caption: 'c', scenes: [
        { id: 's1', beat: 'hook', voiceover: '', source: 'own_video', assetId: 11, targetS: 8, cover: { layout: 'bubble', source: 'own_video', assetId: 12 } },
        { id: 's2', beat: 'value', voiceover: '', source: 'own_video', assetId: 11, targetS: 8, cover: { layout: 'cover', source: 'stock_video', keywords: 'desk' } },
    ] } as unknown as Parameters<typeof assetsForShape>[0];
    const kept = assetsForShape(sb, { s1: 11, 's1~cover': 12, s2: 11, 's2~cover': 400 });
    assert.strictEqual(kept['s1~cover'], 12);
    assert.strictEqual(kept['s2~cover'], undefined);
});

check('the chat card sets, moves and removes a layout on their own footage only', () => {
    const scenes = [
        { id: 's1', beat: 'hook', voiceover: 'Hi', source: 'own_video', assetId: 11, inS: 0, outS: 8, targetS: 8 },
        { id: 's2', beat: 'value', voiceover: 'Look', source: 'stock_video', targetS: 4 },
        { id: 's3', beat: 'value', voiceover: '', source: 'own_video', assetId: 11, inS: 8, outS: 14, targetS: 6, cover: { layout: 'bubble', source: 'own_video', assetId: 12, inS: 4 } },
    ];
    const sb = { title: 't', caption: 'c', scenes } as unknown as Parameters<typeof videoSceneCard>[1];
    const req = (o: Record<string, unknown>) => videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 7, ...o })!;
    const mine = { ownVideoIds: [11, 12] };
    const set = videoSceneCard(req({ scene: 1, layout: 'bubble', screenVideo: 12, screenStartS: 30, corner: 'tl' }), sb, mine)!;
    // A video that isn't one of THIS video's own is never offered (edit_scene would drop it).
    assert.strictEqual(videoSceneCard(req({ scene: 1, layout: 'bubble', screenVideo: 99 }), sb, mine), null);
    assert.strictEqual(videoSceneCard(req({ scene: 1, layout: 'bubble', screenVideo: 12 }), sb), null, 'no list, no own screen');
    assert.deepStrictEqual(set.patch.cover, { layout: 'bubble', source: 'own_video', assetId: 12, inS: 30, corner: 'tl' });
    assert.strictEqual(videoSceneCard(req({ scene: 2, layout: 'bubble', screenVideo: 12 }), sb, mine), null, 'not on stock');
    assert.strictEqual(videoSceneCard(req({ scene: 1, layout: 'bubble' }), sb), null, 'a new layout needs something on the screen');
    assert.deepStrictEqual(videoSceneCard(req({ scene: 3, layout: 'cover' }), sb)!.patch.cover, { layout: 'cover', source: 'own_video', assetId: 12, inS: 4 });
    assert.strictEqual(videoSceneCard(req({ scene: 3, layout: 'presenter' }), sb)!.patch.cover, null);
    assert.deepStrictEqual(coverFromRequest({ projectId: 7, scene: 3, summary: null, screenSearch: 'laptop' }, scenes[2].cover as never),
        { layout: 'bubble', source: 'stock_video', keywords: 'laptop' });
});

check('covers follow the Series clock, not absolute seconds (no black frames at a screen\'s end — review of #705)', () => {
    // Three pieces of 1.01 s at 30 fps: each is rounded UP to 31 frames, so piece 3 starts at frame 62, not 61.
    const pieces = [{ seconds: 1.01, frames: 31 }, { seconds: 1.01, frames: 31 }, { seconds: 1.01, frames: 31 }];
    const clock = seriesClock(pieces, 30);
    assert.strictEqual(clock(0), 0);
    assert.strictEqual(clock(2.02), 62, 'a cover starting at piece 3 starts exactly where piece 3 does');
    assert.strictEqual(Math.round(2.02 * 30), 61, '(absolute seconds would have been a frame early)');
    assert.strictEqual(clock(3.03), 93, 'and ends with the last piece');
    assert.strictEqual(clock(1.5), 31 + 15, 'inside a piece: its start frame plus the seconds into it');
    assert.strictEqual(clock(99), 93);
    // Tightened own-sound footage: 40 short pieces drift far more — still exact at every piece edge.
    const many = Array.from({ length: 40 }, () => ({ seconds: 0.51, frames: 16 }));
    assert.strictEqual(seriesClock(many, 30)(0.51 * 30), 16 * 30);
    const src = read('remotion/PostOverlay.tsx');
    assert.ok(src.includes('const { from, durationInFrames: frames } = coverRange(c);') && !/behind\.map[\s\S]{0,120}overlayFrameRange/.test(src));
});

check('a screen that can\'t be found leaves the presenter full frame and says so, never fails the build', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('note: coverNote }') && vp.includes('couldn’t be found, so'));
    assert.ok(!vp.includes('’s screen` }))'), 'no longer added to the build\'s missing-scene error');
});

check('geometry: the bubble and window sit in their corner, and bottom captions step above them', () => {
    const b = bubbleBox(1920, 1080, 'br');
    assert.strictEqual(b.size, Math.round(1080 * 0.26));
    assert.ok(b.left + b.size < 1920 && b.top + b.size < 1080 && b.left > 1920 / 2 && b.top > 1080 / 2);
    assert.ok(bubbleBox(1920, 1080, 'tl', 'small').size < b.size);
    const w = windowBox(1920, 1080, 'bl');
    assert.ok(w.left < 100 && w.top + w.height < 1080 && Math.abs(w.width / w.height - 16 / 9) < 0.02);
    assert.ok(captionLiftPct(1920, 1080, { kind: 'bubble', corner: 'br' }) > 0);
    assert.strictEqual(captionLiftPct(1920, 1080, { kind: 'bubble', corner: 'tr' }), 0);
    assert.strictEqual(captionLiftPct(1920, 1080, null), 0);
});

check('the composition draws covers behind, windows in front, the bubble, and a hidden presenter as sound', () => {
    const src = read('remotion/PostOverlay.tsx');
    const behindAt = src.indexOf('{behind.map((c) =>');
    const seriesAt = src.indexOf('? <Series>');
    const windowsAt = src.indexOf('{windows.map((c) =>');
    assert.ok(behindAt > 0 && seriesAt > behindAt && windowsAt > seriesAt, 'screens behind the presenter, windows over them');
    assert.ok(/c\.layout === 'hidden'\s*\n\s*\? <Audio src=\{c\.src\} volume=\{c\.gain\}/.test(src), 'screen only keeps the presenter\'s sound');
    assert.ok(src.includes(': c.layout === \'bubble\'') && src.includes('? bubble(c)'));
    assert.ok(src.includes('<OffthreadVideo src={c.src} muted'), 'a screen is always silent');
    assert.ok(src.includes('lift={lift.length ? lift : undefined}'));
    // The worker hands the composition its covers, and layouts survive clip resolution.
    assert.ok(read('src/utils/video-render.ts').includes('...(covers.length ? { covers } : {}),'));
    assert.ok(read('src/lib/post-render.ts').includes("clip.layout === 'bubble' || clip.layout === 'hidden'"));
});

check('the Change form and edit_scene carry the layout; a new screen is found again', () => {
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.indexOf('${coverGroupHtml(v, s)}') > ui.indexOf('name="outS" type="number"') && ui.includes('${coverGroupHtml(v, s)}') && ui.includes("...(source === 'own_video' ? coverPatch(fd) : {}),"));
    assert.ok(ui.includes("['bubble', 'Screen + bubble'], ['cover', 'Screen only'], ['window', 'Presenter + window']"));
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes("if ('cover' in patch) {") && fn.includes('delete assets[`${scene.id}~cover`]'));
});

console.log(`\nscene-cover: ${passed} passed`);
