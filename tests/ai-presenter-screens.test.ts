// tests/ai-presenter-screens.test.ts
// The AI presenter over the owner's screen recordings (docs/video-producer-screen-walkthrough-plan.md §11.7, A3):
// screens in the brief only with a presenter, covers on presenter scenes (never "screen only"), the planner's
// walkthrough instruction, the build and timeline, and the form, Change form and chat wiring.
//
// Run:  npx tsx tests/ai-presenter-screens.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readBrief, timelineCovers, timesOf } from '../src/utils/video-producer';
import { enforceStoryboard, presenterBlock, type Scene, type VideoBrief } from '../src/lib/storyboard';
import { applyCovers } from '../src/lib/scene-cover';
import { videoSceneCard, videoSceneRequestFromUiElement } from '../src/utils/chat-video-scene';
import { screenRefusal } from '../src/lib/presenters';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('the brief: screen recordings only beside a presenter, never as footage', () => {
    const r = readBrief({ message: 'A tour of our booking system for new clients', presenter: { id: 'amara' }, screenAssetIds: [21, '21', 22] });
    assert.ok('brief' in r && JSON.stringify(r.brief.screenAssetIds) === '[21,22]' && !r.brief.footageAssetIds);
    const none = readBrief({ message: 'A tour of our booking system for new clients', screenAssetIds: [21] });
    assert.ok('brief' in none && !none.brief.screenAssetIds, 'no presenter, no screens');
});

const brief = (o: Partial<VideoBrief> = {}): VideoBrief => ({ purpose: 'promo', lengthS: 30, message: 'x', voiceover: true, allowAi: 'stock_only', presenter: { id: 'amara' }, screenAssetIds: [21], ...o });
const screens = [{ id: 21, name: 'booking-system.webm', durationS: 90 }];
const p = (cover?: Record<string, unknown>) => ({ beat: 'value', voiceover: 'A line to say.', source: 'ai_presenter', targetS: 5, ...(cover ? { cover } : {}) });

check('the storyboard: a presenter scene may sit in a bubble or beside a window over a screen, never hidden', () => {
    const { storyboard, changes } = enforceStoryboard({ title: 't', caption: 'c', scenes: [
        p(), p({ layout: 'bubble', source: 'own_video', assetId: 21, inS: 10 }), p({ layout: 'window', source: 'own_video', assetId: 21, inS: 40, corner: 'tr' }),
        p({ layout: 'cover', source: 'own_video', assetId: 21 }), p({ layout: 'bubble', source: 'own_video', assetId: 99 }), p(),
    ] }, brief(), [], screens);
    const c = storyboard.scenes.map((s) => s.cover ?? null);
    assert.strictEqual(c[0], null);
    assert.deepStrictEqual(c[1], { layout: 'bubble', source: 'own_video', assetId: 21, inS: 10 });
    assert.deepStrictEqual(c[2], { layout: 'window', source: 'own_video', assetId: 21, inS: 40, corner: 'tr' });
    assert.strictEqual(c[3]?.layout, 'bubble', '"screen only" becomes a bubble: the presenter is never hidden');
    assert.strictEqual(c[4], null, 'a video that isn\'t one of the brief\'s screens');
    assert.ok(changes.some((x) => /never hidden|bubble, not hidden/.test(x)) && changes.some((x) => /isn't one of your chosen videos/.test(x)));
    assert.ok(storyboard.scenes.every((s) => s.source === 'ai_presenter'), 'with screens, the key-moment limit doesn\'t apply');
    const own = enforceStoryboard({ title: 't', caption: 'c', scenes: [p({ layout: 'bubble', source: 'own_video', assetId: 21 }), p(), p()] }, brief({ screenAssetIds: undefined }), [], screens);
    assert.strictEqual(own.storyboard.scenes[0].cover, undefined, 'no screens on the brief: no screen cover');
});

check('the planner: open and close full frame, the presenter in a bubble over each recording in order', () => {
    const block = presenterBlock(brief(), screens);
    assert.ok(block.startsWith('PRESENTER WITH SCREEN RECORDINGS: Amara'));
    assert.ok(block.includes('id 21 "booking-system.webm" (90 s)') && block.includes('"layout": "bubble"') && block.includes('Never "layout": "cover"'));
    assert.ok(!presenterBlock(brief(), []).startsWith('PRESENTER WITH SCREEN'), 'no recordings measured: the ordinary presenter instruction');
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('const own = [...asOwnVideos(footage), ...screens];') && vp.includes('footageBlock: footagePlannerBlock(footage), acceptedEdits, declinedEdits, screens,'),
        'screens reach the rules and the presenter instruction, never the footage list');
});

check('the build and timeline: a presenter clip splits at the screen\'s edges and sits in the bubble', () => {
    const scenes = [
        { id: 's1', beat: 'hook', voiceover: 'Hi', source: 'ai_presenter', targetS: 3 },
        { id: 's2', beat: 'value', voiceover: 'Look', source: 'ai_presenter', targetS: 5, cover: { layout: 'bubble', source: 'own_video', assetId: 21, inS: 12 } },
    ] as unknown as Scene[];
    const covers = timelineCovers(scenes, { s1: 101, s2: 102, 's2~cover': 21 }, timesOf(scenes, [3, 5]), () => 90);
    assert.deepStrictEqual(covers.map((c) => [c.id, c.startS, c.endS, c.inS, c.layout, c.fit]), [['vp_cover_s2', 3, 8, 12, 'bubble', 'contain']]);
    const laid = applyCovers([{ id: 'vp_s1', assetId: 101, inS: 0, outS: 3 }, { id: 'vp_s2', assetId: 102, inS: 0, outS: 5 }], covers);
    assert.deepStrictEqual(laid.map((c) => c.layout ?? 'full'), ['full', 'bubble'], 'the presenter\'s clip becomes the bubble');
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("if (!cover || (scene.source !== 'own_video' && scene.source !== 'ai_presenter')) continue;"));
});

check('create checks screens are their own and asks for the same permission tick', () => {
    const fn = read('netlify/functions/video-projects.ts');
    // The rules themselves, called (review of #725): permission, their own uploads, measured.
    const mine = [{ id: 21, durationS: 90 }, { id: 22, durationS: null }];
    assert.strictEqual(screenRefusal([], false, []), null, 'no screens, nothing to check');
    assert.strictEqual(screenRefusal([21], false, mine)?.status, 400, 'no permission tick');
    assert.strictEqual(screenRefusal([21, 77], true, mine)?.status, 404, 'a video that isn\'t theirs (another workspace\'s, or gone)');
    assert.strictEqual(screenRefusal([22], true, mine)?.status, 409, 'never measured');
    assert.strictEqual(screenRefusal([21], true, mine), null);
    assert.ok(fn.includes("const refused = screenRefusal(screenIds, (body.brief as Record<string, unknown> | undefined)?.footageConsent === true, await ownVideos(db, orgId, screenIds));"));
    assert.ok(fn.includes('const enforced = enforceStoryboard(sb, brief, await libraryPictures(db, orgId), [...asOwnVideos(footage), ...screens]);'), 'edit_scene keeps a presenter\'s screen');
});

check('the form, the Change form and the chat offer it', () => {
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes('<div data-vid-screens class="hidden') && ui.includes('name="screenConsent"'));
    assert.ok(ui.includes("screenAssetIds: fd.getAll('screenIds').map(Number), footageConsent: !!fd.get('screenConsent')"));
    assert.ok(ui.includes("if (s.source !== 'own_video' && s.source !== 'ai_presenter') return '';") && ui.includes("COVER_LAYOUT.filter(([k]) => k !== 'cover')"));
    const sb = { title: 't', caption: 'c', scenes: [{ id: 's1', beat: 'hook', voiceover: 'Hi', source: 'ai_presenter', targetS: 3 }] } as unknown as Parameters<typeof videoSceneCard>[1];
    const card = videoSceneCard(videoSceneRequestFromUiElement({ type: 'video_scene_edit', projectId: 4, scene: 1, layout: 'bubble', screenVideo: 21, screenStartS: 5 })!, sb, { ownVideoIds: [21] });
    assert.deepStrictEqual(card?.patch.cover, { layout: 'bubble', source: 'own_video', assetId: 21, inS: 5 }, 'the chat can set it on a presenter scene');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('...((project.brief as { screenAssetIds?: number[] } | null)?.screenAssetIds ?? [])'));
});

check('review of #725: unmeasured screens are refused and never lift the limit; a demoted scene loses its screen; hints speak of the presenter', () => {
    // A screen with no length: not used, the owner told, and the key-moment limit stays.
    const r = enforceStoryboard({ title: 't', caption: 'c', scenes: Array.from({ length: 5 }, () => p({ layout: 'bubble', source: 'own_video', assetId: 21 })) }, brief(), [], []);
    assert.ok(r.changes.some((x) => /has no length yet/.test(x)));
    assert.strictEqual(r.storyboard.scenes.filter((s) => s.source === 'ai_presenter').length, 3, 'no measured screen: the 3-scene limit applies');
    assert.ok(r.storyboard.scenes.filter((s) => s.source === 'stock_video').every((s) => !s.cover), 'a scene switched to stock keeps no screen');
    const fn = read('netlify/functions/video-projects.ts');
    assert.strictEqual(screenRefusal([22], true, [{ id: 22, durationS: 0 }])?.status, 409);
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes(".filter((x) => Number(x.durationS) > 0);"), 'the form lists only measured recordings');
    assert.ok(ui.includes("bubble: 'The screen fills the frame and the presenter appears in a round bubble in a corner, still talking.'"));
});

console.log(`\nai-presenter-screens: ${passed} passed`);
