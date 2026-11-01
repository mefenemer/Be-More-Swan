// tests/video-producer.test.ts
// Video Producer Phase 5 — still scenes on the timeline, assembly, the project endpoints.
//
// What goes wrong silently if these drift:
//   · the post editor's save dropping `kind`, turning a still into a "video" clip pointing at a
//     picture — the renderer then skips it and the scene vanishes from the published video
//   · a storyboard that OPENS on a picture rendering as a single still (the timeline ignored)
//   · a build spending before the hold, or a stuck build keeping the customer's credits
//   · the on-screen text and the captions fighting for the same part of the frame
// No network, no database.
//
// Run:  npx tsx tests/video-producer.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitiseVideoEdit, editHasStills, editChangesMedia, MAX_STILL_HOLD_S } from '../src/lib/video-edit';
import { renderFingerprint } from '../src/lib/post-render';
import { readBrief, sceneClips, sceneOverlays, buildTasks, onScreenFontPct, VIDEO_DESTINATIONS } from '../src/utils/video-producer';
import { enforceStoryboard, type VideoBrief } from '../src/lib/storyboard';
import { captionLayout } from '../src/lib/captions';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

check('a still scene survives the save sanitiser, bounded, without video-only fields', () => {
    const e = sanitiseVideoEdit({ clips: [
        { id: 's1', assetId: 4, kind: 'image', holdS: 99, motion: 'pan_left', inS: 2, gain: 0.5 },
        { id: 's2', assetId: 5, kind: 'image', motion: 'spin' },
        { id: 'c1', assetId: 6, inS: 1, outS: 3 },
    ] })!;
    assert.deepStrictEqual(e.clips[0], { id: 's1', assetId: 4, kind: 'image', holdS: MAX_STILL_HOLD_S, motion: 'pan_left' });
    assert.deepStrictEqual(e.clips[1], { id: 's2', assetId: 5, kind: 'image', holdS: 3 });
    assert.strictEqual(e.clips[2].kind, undefined);
});

check('an edit with a still always needs a render, and is recognised as one', () => {
    const one = { clips: [{ id: 's', assetId: 1, kind: 'image', holdS: 3 }] };
    assert.ok(editHasStills(one) && editChangesMedia(one));
    assert.ok(!editHasStills({ clips: [{ id: 'c', assetId: 1 }] }));
});

check('changing a still’s hold or movement changes the render fingerprint', () => {
    const base = { baseAssetId: 1, hasTimelineAudio: false, targetRatio: '9:16', framePosition: null, imageOverlays: [], audioOverlays: [] };
    const a = renderFingerprint({ ...base, videoEdit: { clips: [{ id: 's', assetId: 4, kind: 'image', holdS: 3, motion: 'push_in' }] } } as never);
    const b = renderFingerprint({ ...base, videoEdit: { clips: [{ id: 's', assetId: 4, kind: 'image', holdS: 4, motion: 'push_in' }] } } as never);
    const c = renderFingerprint({ ...base, videoEdit: { clips: [{ id: 's', assetId: 4, kind: 'image', holdS: 3, motion: 'pan_left' }] } } as never);
    assert.notStrictEqual(a, b); assert.notStrictEqual(a, c);
});

check('the renderer, composition and editor all know a still', () => {
    const pr = read('src/lib/post-render.ts');
    assert.ok(pr.includes("base.kind === 'video' || editHasStills(videoEdit)"), 'a storyboard opening on a picture must still render its timeline');
    assert.ok(pr.includes("type !== (clip.kind === 'image' ? 'image' : 'video')"), 'a clip must be the kind of asset it claims');
    const worker = read('netlify/functions/render-post-video-background.ts');
    assert.ok(worker.includes('const firstIsVideo = useTimeline && timeline[0].kind !== \'image\''), 'the old-bundle fallback must never send a picture as videoSrc');
    const root_ = read('remotion/Root.tsx');
    assert.ok(root_.includes("if (clip.kind === 'image') {"), 'a still is sized by its hold, never measured as a video');
    const tsx = read('remotion/PostOverlay.tsx');
    assert.ok(tsx.includes("c.kind === 'image'") && tsx.includes('<MovingStill src={c.src}'), 'the timeline draws a still as a moving picture');
    const html = read('workspace.html');
    const persist = html.slice(html.indexOf('async function _pcePersistVideoEdit('), html.indexOf('function _pceClipsChanged('));
    assert.ok(persist.includes("if (c.kind === 'image') {") && persist.includes("out.kind = 'image';"), 'the editor save must keep a still a still');
    assert.ok(html.includes("if (c && c.kind === 'image') return c.holdS != null ? c.holdS : 3;"), 'a still’s length is its hold');
    const trig = read('netlify/functions/trigger-post-render.ts');
    assert.ok(trig.includes("hasVideo: base.kind === 'video' || editHasStills(videoEdit)"), 'a still-scene post must be rendered on approve');
});

check('a brief is read safely: length, AI allowance and platforms fall back to sane values', () => {
    const r = readBrief({ message: 'Our autumn menu has arrived', lengthS: 45, allowAi: 'lots', platforms: ['instagram', 'tiktok', 'YouTube', 'instagram'] });
    assert.ok('brief' in r);
    if ('brief' in r) {
        assert.strictEqual(r.brief.lengthS, 30);
        assert.strictEqual(r.brief.allowAi, 'stock_and_ai');
        assert.deepStrictEqual(r.brief.platforms, ['instagram', 'youtube']);
        assert.strictEqual(r.brief.voiceover, true);
    }
    assert.ok('error' in readBrief({ message: 'hi' }));
    assert.deepStrictEqual(VIDEO_DESTINATIONS, { instagram: 'ig_reel', youtube: 'yt_short', facebook: 'fb_reel' });
});

const brief: VideoBrief = { purpose: 'promo', lengthS: 15, message: 'x', voiceover: true, allowAi: 'ai_first' };
const { storyboard } = enforceStoryboard({ scenes: [
    { beat: 'hook', voiceover: 'Hi', source: 'stock_photo', onScreenText: 'NEW', targetS: 3 },
    { beat: 'value', voiceover: 'Look', source: 'ai_video', prompt: 'cafe', targetS: 6 },
    { beat: 'cta', voiceover: 'Come', source: 'brand_card', targetS: 6 },
] }, brief);

check('scenes become the timeline in order: stills held, clips trimmed to their scene', () => {
    const clips = sceneClips(storyboard.scenes, { s1: 11, s2: 12, s3: 13 }, [3, 5, 4]);
    assert.strictEqual(clips[0].kind, 'image');
    assert.strictEqual(clips[0].holdS, 3);
    assert.ok(clips[0].motion);
    assert.deepStrictEqual({ ...clips[1] }, { id: 'vp_s2', assetId: 12, inS: 0, outS: 5 });
    assert.strictEqual(clips[2].kind, 'image');
    assert.strictEqual(sceneClips(storyboard.scenes, { s1: 11 }, [3, 5, 4]).length, 1, 'an unsourced scene is left out, never rendered empty');
});

check('on-screen text is timed to its scene and sits clear of the captions', () => {
    const ov = sceneOverlays(storyboard.scenes, [3, 5, 4]);
    assert.strictEqual(ov.length, 1);
    assert.deepStrictEqual([ov[0].startS, ov[0].endS], [0, 3]);
    // Captions are drawn upward from bottomPct; overlays sit in the upper third.
    assert.ok(ov[0].y < 1 - captionLayout(1920).bottomPct / 100 - 0.2);
    // A branded card shows its words as the card's headline — never overlaid a second time.
    const card = { ...storyboard.scenes[0], id: 'c1', source: 'brand_card' as const, onScreenText: 'Pop in this week' };
    assert.strictEqual(sceneOverlays([card], [3]).length, 0);
});

check('a build holds the task weights it will record: AI clip 20, AI image 1, voiceover 1', () => {
    assert.strictEqual(buildTasks(storyboard, brief), 20 + 1);
    assert.strictEqual(buildTasks(storyboard, { ...brief, voiceover: false }), 20);
});

check('the endpoint gates before planning, moderates, holds before building, and the worker is idempotent', () => {
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.indexOf('tierCanGenerateVideo(') < fn.indexOf("action === 'create'"), 'the plan gate runs before anything is created');
    assert.ok(fn.includes("orgHasAssistantFeature(db, orgId, 'ai_video_generation')"));
    assert.ok(fn.includes('enforcePromptModeration('));
    const build = fn.slice(fn.indexOf("action === 'build'"));
    assert.ok(build.indexOf('holdBuild(') < build.indexOf("status: 'building'"), 'credits are held before the build starts');
    assert.ok(fn.includes('eq(videoProjects.organisationId, orgId)'), 'every project read is tenant-scoped');
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("if (!p || p.status !== 'planning') return;") && vp.includes("if (!p || p.status !== 'building' || !p.storyboard) return;"), 'a duplicate wake must not plan or build twice');
    assert.ok(vp.includes("creditHold: 0, note: 'This took too long"), 'the sweep zeroes the hold in the claiming update');
    assert.ok(vp.includes("status: 'pending_approval'"), 'a finished video goes to review, never straight out');
});

check('the SQL file and the Drizzle mirror agree on the table', () => {
    const sql = read('db/z-video-producer.sql');
    const schema = read('db/schema.ts');
    for (const col of ['scene_assets', 'voiceover_asset_id', 'scheduled_post_id', 'credit_hold', 'credits_spent', 'crosspost_group_id']) {
        assert.ok(sql.includes(col) && schema.includes(`"${col}"`), col);
    }
    assert.ok(sql.includes("CHECK (status IN ('draft', 'planning', 'planned', 'building', 'built', 'failed', 'cancelled'))"));
});

check('stock is searched portrait first (9:16 video), any shape only when portrait finds nothing', () => {
    const vp = readFileSync(join(root, 'src/utils/video-producer.ts'), 'utf8');
    assert.match(vp, /searchUniqueVideos\(db, orgId, context, \{ \.\.\.opts, orientation: 'portrait' \}\)\)\.candidates\)\s*\?\? longEnough\(\(await searchUniqueVideos\(db, orgId, context, opts\)\)\.candidates\)/);
    assert.match(vp, /searchUniqueImages\(db, orgId, context, \{ \.\.\.opts, orientation: 'portrait' \}\)/);
    const px = readFileSync(join(root, 'src/utils/pexels.ts'), 'utf8');
    assert.match(px, /\.\.\.\(orientation \? \{ orientation \} : \{\}\)/, 'sent to Pexels');
    assert.match(px, /\$\{orientation \? `\|\$\{orientation\}` : ''\}/, 'part of the cache key');
});

check('on-screen text shrinks to fit one line of a 9:16 frame', () => {
    assert.strictEqual(onScreenFontPct('New this autumn'), 0.05);
    const long = 'Yellow flame? Get it checked';
    const pct = onScreenFontPct(long);
    assert.ok(pct < 0.05);
    assert.ok(long.length * 0.5 * pct <= 0.9 * 9 / 16 + 1e-9, 'fits ~90% of the frame width');
    assert.strictEqual(onScreenFontPct('x'.repeat(200)), 0.028, 'never unreadably small');
    assert.strictEqual(sceneOverlays([{ ...storyboard.scenes[0], id: 'l', source: 'stock_video' as const, onScreenText: long }], [3])[0].fontSizePct, pct);
});

check('a stock clip is only used when it covers its scene; otherwise the scene becomes a moving still', () => {
    const vp = readFileSync(join(root, 'src/utils/video-producer.ts'), 'utf8');
    assert.match(vp, /const need = scene\.targetS \+ 0\.3;/);
    assert.match(vp, /cs\.find\(\(x\) => \(x\.duration \?\? 0\) >= need\)/, 'unknown length counts as too short');
    assert.match(vp, /return photo \? \{ \.\.\.photo, asStill: true \} : null;/);
    assert.match(vp, /storyboard\.scenes\[i\] = \{ \.\.\.scene, source: 'stock_photo'/, 'the storyboard says what it became, so the timeline holds it');
    const px = readFileSync(join(root, 'src/utils/pexels.ts'), 'utf8');
    assert.match(px, /Number\(v\?\.duration\) > 0 \? \{ duration: Number\(v\.duration\) \}/);
    assert.match(px, /durationS: candidate\.duration/);
});

console.log(`\n${passed} checks passed`);
