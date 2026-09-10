// tests/post-clip-editor.test.ts
// Phase 5 of docs/video-editing-plan.md: the clip list in the post editor.
//
// A source scan, because workspace.html has no build step and no module boundary — typecheck sees
// none of it. The things asserted here are the ones that fail SILENTLY: a panel that renders but
// saves to the wrong endpoint, a cut that never reaches the server, or clips drawn below the
// timeline whose axis they are supposed to determine.
//
// ⚠️ Every marker below is asserted to exist AND to be unique before anything is measured against
// it. A stale marker makes indexOf return -1, which slices an empty string, which passes every
// content assertion in it — this suite has been fooled that way before.
//
// Run:  npx tsx tests/post-clip-editor.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(import.meta.dirname, '..');
const workspace = readFileSync(join(root, 'workspace.html'), 'utf8');
const drafts = readFileSync(join(root, 'netlify/functions/get-social-drafts.ts'), 'utf8');
const saveFn = readFileSync(join(root, 'netlify/functions/save-post-video-edit.ts'), 'utf8');

/** Index of a marker that must appear exactly once. Throws rather than returning -1. */
function only(hay: string, needle: string, where: string): number {
    const first = hay.indexOf(needle);
    assert.notStrictEqual(first, -1, `marker missing in ${where}: ${needle}`);
    assert.strictEqual(hay.indexOf(needle, first + 1), -1, `marker not unique in ${where}: ${needle}`);
    return first;
}

console.log('\nthe panel exists and is wired');

check('the clips block is in the stage strip', () => {
    only(workspace, 'id="pce-clips-block"', 'workspace.html');
});

check('clips are drawn ABOVE the timeline, because the cut decides its axis', () => {
    const clips = only(workspace, 'id="pce-clips-block"', 'workspace.html');
    const timeline = only(workspace, 'id="post-review-timeline"', 'workspace.html');
    assert.ok(clips < timeline, 'the clip list must precede the timeline in the DOM');
});

check('opening a post renders the clips before the timeline', () => {
    const call = workspace.indexOf('_pceRenderClips();\n    _rqRenderTimeline(post);');
    assert.notStrictEqual(call, -1, 'the open path must render clips, then the timeline');
});

check('every mutation goes through one handler that saves AND redraws', () => {
    for (const fn of ['window._pceClipMove', 'window._pceClipRemove', 'window._pceClipTrim']) {
        only(workspace, fn + ' = function', 'workspace.html');
    }
    // A mutation that redrew without persisting would look like it worked and be gone on reopen.
    const body = workspace.slice(only(workspace, 'function _pceClipsChanged(', 'workspace.html'));
    const scope = body.slice(0, body.indexOf('\n}'));
    assert.ok(scope.includes('_pcePersistVideoEdit('), 'the mutation handler must persist');
    assert.ok(scope.includes('_rqRenderTimeline('), 'the timeline axis must follow the cut');
});

check('the cut is saved to its own endpoint, not the overlay one', () => {
    const persist = workspace.slice(only(workspace, 'async function _pcePersistVideoEdit(', 'workspace.html'));
    const scope = persist.slice(0, persist.indexOf('\n}\n'));
    assert.ok(scope.includes('/.netlify/functions/save-post-video-edit'), scope.slice(0, 200));
    assert.ok(!scope.includes('save-post-overlays'), 'the cut and the text design are separate saves');
});

console.log('\nseeding');

check('an unedited post seeds its cut from the video already attached', () => {
    const fn = workspace.slice(only(workspace, 'function _pceClips(post)', 'workspace.html'));
    const scope = fn.slice(0, fn.indexOf('\n}\n'));
    assert.ok(scope.includes('post.videoEdit'), 'a stored cut must win');
    assert.ok(scope.includes('post.slides'), 'multi-attachment posts seed from slides');
    assert.ok(scope.includes('post.mediaAssetIds'), 'a single video seeds from its asset id');
});

check('the server sends both of the things seeding needs', () => {
    assert.ok(drafts.includes('mediaAssetIds: slideIds'), 'attached asset ids');
    assert.ok(drafts.includes('videoEdit: (() => {'), 'the stored cut, with resolved clip urls');
});

console.log('\nthe read cannot empty the review queue');

check('video_edit is NOT named in the main draft select', () => {
    // Naming it there means one missing column renders the whole queue empty — the worst possible
    // failure for a column only video posts care about.
    const mainSelect = drafts.slice(0, only(drafts, 'const audioAssets = new Map', 'get-social-drafts.ts'));
    assert.ok(!mainSelect.includes('videoEdit: scheduledPosts.videoEdit'),
        'video_edit must be read separately, behind its own try/catch');
});

check('the separate read swallows a missing column', () => {
    const at = only(drafts, '[get-social-drafts] video edit lookup skipped', 'get-social-drafts.ts');
    const before = drafts.slice(0, at);
    assert.ok(before.lastIndexOf('} catch') > before.lastIndexOf('videoEdits.set'),
        'the lookup must be inside the catch it warns from');
});

console.log('\nthe save endpoint');

check('it verifies every clip belongs to the caller org', () => {
    assert.ok(saveFn.includes('contentAssets.organisationId, orgId'),
        'an unchecked asset id is a cross-tenant read that ends up published');
});

check('it defaults to the whole cross-post group', () => {
    // The opposite of save-post-overlays. Nobody should trim the same four clips once per platform.
    assert.ok(saveFn.includes('applyToGroup: body.applyToGroup !== false'), 'the cut is shared by default');
});

console.log('\nthe crop frame');

check('the crop panel exists and precedes the timeline', () => {
    const crop = only(workspace, 'id="pce-crop-block"', 'workspace.html');
    const timeline = only(workspace, 'id="post-review-timeline"', 'workspace.html');
    assert.ok(crop < timeline);
});

check('opening a post renders AND binds it', () => {
    assert.notStrictEqual(workspace.indexOf('_pceRenderCropFrame();\n    _pceBindCropFrame();'), -1);
});

check('the server decides whether this platform re-frames, not the browser', () => {
    // A second implementation of reframeRatioFor in workspace.html would drift from the renderer,
    // and the entire point of drawing the crop is that it is honest about what will publish.
    assert.ok(drafts.includes('reframeRatioFor(d.platform, d.formatKey, master)'));
    assert.ok(!workspace.includes('reframeRatioFor'), 'the browser must not re-derive the re-frame');
});

check('a trim carries the framing through — it must not wipe it', () => {
    // save-post-video-edit REPLACES the whole object, so a save that omits frames silently discards
    // every crop the reviewer set, and nothing reports it until the post publishes mis-framed.
    const at = only(workspace, 'const carriedFrames =', 'workspace.html');
    const scope = workspace.slice(at, at + 400);
    assert.ok(scope.includes('edit.frames = carriedFrames'));
});

check('only the overflowing axis can hold an offset', () => {
    // An offset on the axis that already fits changes no pixel but DOES change the render
    // fingerprint, which would split siblings that produce identical files into two renders.
    const at = only(workspace, 'win.movableX ? next.offsetX : 0', 'workspace.html');
    assert.ok(at > 0);
});

console.log('\nthe crop window maths');

// The same function the panel uses, lifted out of the page so the geometry can be checked without
// a browser. Kept in step by the assertion below that the page still contains this exact formula.
function cropWindow(sourceAspect: number, ratio: string, offsetX: number, offsetY: number) {
    const [w, h] = ratio.split(':').map(Number);
    const rt = w / h;
    const wFrac = sourceAspect > rt ? rt / sourceAspect : 1;
    const hFrac = sourceAspect > rt ? 1 : sourceAspect / rt;
    return {
        wFrac, hFrac,
        left: ((offsetX + 1) / 2) * (1 - wFrac),
        top: ((offsetY + 1) / 2) * (1 - hFrac),
    };
}

check('a 16:9 source in a 4:5 frame loses WIDTH, and can slide sideways', () => {
    const win = cropWindow(16 / 9, '4:5', 0, 0);
    assert.ok(win.wFrac < 1, 'width must be cropped');
    assert.strictEqual(win.hFrac, 1, 'height fits exactly');
    assert.ok(Math.abs(win.left - (1 - win.wFrac) / 2) < 1e-9, 'centred at offset 0');
});

check('a 9:16 source in a 4:5 frame loses HEIGHT, and can slide up and down', () => {
    const win = cropWindow(9 / 16, '4:5', 0, 0);
    assert.strictEqual(win.wFrac, 1, 'width fits exactly');
    assert.ok(win.hFrac < 1, 'height must be cropped');
});

check('offset -1 pins the window to the top/left edge, +1 to the bottom/right', () => {
    const top = cropWindow(9 / 16, '4:5', 0, -1);
    const bottom = cropWindow(9 / 16, '4:5', 0, 1);
    assert.ok(Math.abs(top.top) < 1e-9);
    assert.ok(Math.abs(bottom.top - (1 - bottom.hFrac)) < 1e-9);
});

check('a source already at the target ratio crops nothing', () => {
    const win = cropWindow(4 / 5, '4:5', 0, 0);
    assert.ok(Math.abs(win.wFrac - 1) < 1e-9);
    assert.ok(Math.abs(win.hFrac - 1) < 1e-9);
});

check('the page still uses this exact formula', () => {
    only(workspace, 'const wFrac = sourceAspect > rt ? rt / sourceAspect : 1;', 'workspace.html');
    only(workspace, 'const hFrac = sourceAspect > rt ? 1 : sourceAspect / rt;', 'workspace.html');
});

console.log(`\n${passed} checks passed`);
