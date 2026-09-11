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
const pexels = readFileSync(join(root, 'netlify/functions/pexels-search.ts'), 'utf8');

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
    // Order, not adjacency. This asserted the two calls were on consecutive lines and broke the
    // moment the crop frame was added between them — a false failure about a true ordering. What
    // matters is that the cut is computed before the axis that depends on it.
    // Anchored on the comment, which is unique — _pceRenderClips() itself is also called from the
    // measure callback, so the bare call is not a marker.
    const at = only(workspace, "// Clips first: the cut decides how long the piece is", 'workspace.html');
    const open = workspace.slice(at, at + 600);
    const clips = open.indexOf('_pceRenderClips();');
    const timeline = open.indexOf('_rqRenderTimeline(post);');
    assert.notStrictEqual(clips, -1, 'the open path must render the clips');
    assert.notStrictEqual(timeline, -1, 'the open path must render the timeline');
    assert.ok(clips < timeline, 'clips must be rendered before the timeline that depends on them');
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

console.log('\ngetting clips ONTO a post');

check('several videos on a single-item video format are clips, not slides', () => {
    // The composer's rule was "more media than the format takes ⇒ widen the format", which turned a
    // Reel into a Carousel the moment a second clip arrived — throwing away the exact thing the user
    // was assembling. A single-item VIDEO format is the case that must NOT widen.
    const at = only(workspace, 'const videoOnlyFormat =', 'workspace.html');
    const scope = workspace.slice(at, at + 400);
    assert.ok(scope.includes("fmt.m === 'video'"), 'the tell is a video-only format');
    assert.ok(scope.includes('fmt.max === 1'), 'and a single-item one');
    assert.ok(scope.includes('_pceAttachClips('), 'which appends instead of switching format');
    // ...and it must be decided BEFORE the widen branch, or the format switches first.
    const widen = only(workspace, 'The narrowest live format that fits', 'workspace.html');
    assert.ok(at < widen, 'the clip branch must come before the format-widening branch');
});

check('adding clips APPENDS — the media picker still replaces', () => {
    const at = only(workspace, 'async function _pceAppendClipAssets(', 'workspace.html');
    const scope = workspace.slice(at, at + 2000);
    assert.ok(scope.includes('existing.concat('), 'clips are appended to what is already there');
    assert.ok(scope.includes('if (!existing.length)'), 'the base asset is attached once, not re-attached');
    // Uploading is one door into the append, not a second implementation of it.
    const up = only(workspace, 'async function _pceAttachClips(files)', 'workspace.html');
    assert.ok(workspace.slice(up, up + 500).includes('_pceAppendClipAssets('), 'upload reuses the append');
});

check('the panel is shown for a single clip, so there is a way to reach two', () => {
    // It used to hide until there were two clips — but "Add another clip" lives in the panel, so
    // hiding it left no route from one clip to two. A dead end exactly where the feature starts.
    const at = only(workspace, 'function _pceRenderClips(clipsOverride)', 'workspace.html');
    const scope = workspace.slice(at, at + 1200);
    assert.ok(scope.includes('if (!clips.length) {'), 'only an empty cut hides the panel');
    assert.ok(!scope.includes('worthShowing'), 'the two-clip threshold must be gone');
});

check('the add button is wired to the appending path', () => {
    only(workspace, 'window._pceAddClipFiles = function', 'workspace.html');
    assert.ok(workspace.includes('onclick="window._pceAddClipFiles()"'), 'the panel must offer it');
});

check('the library lets you TICK several, and says what will happen to them', () => {
    // Clicking a tile used to attach it immediately, which is why "add several" had nowhere to
    // live: the decision was over before a second could be chosen.
    const at = only(workspace, 'cell.setAttribute(\'data-own-tile\'', 'workspace.html');
    const scope = workspace.slice(at, at + 400);
    assert.ok(scope.includes('window._pceOwnToggle(a.id)'), 'a tile records a choice, it does not act');
    only(workspace, 'id="gp-ai-own-bar"', 'workspace.html');
    only(workspace, 'window._pceOwnAdd()', 'workspace.html');
    only(workspace, 'window._pceOwnReplace()', 'workspace.html');
});

check('Replace is offered only when exactly one is ticked', () => {
    // With several ticked there is no single answer to "replace it with what".
    const at = only(workspace, 'const rep = document.getElementById(\'gp-ai-own-replace\')', 'workspace.html');
    assert.ok(workspace.slice(at, at + 500).includes("rep.classList.toggle('hidden', n !== 1)"));
});

check('Find and Generate ASK before they spend anything', () => {
    // Both end in something landing on the post, and neither can be undone or previewed — so the
    // question has to be settled while the answer can still change what happens.
    const find = only(workspace, 'function gpAiFind() {', 'workspace.html');
    assert.ok(workspace.slice(find, find + 400).includes('_pceAskAddOrReplace('), 'search must ask first');
    const gen = only(workspace, 'async function gpAiGenerate() {', 'workspace.html');
    assert.ok(workspace.slice(gen, gen + 500).includes('_pceAskAddOrReplace('), 'generation must ask first');
    only(workspace, 'id="gp-ai-intent"', 'workspace.html');
});

check('uploading several videos onto a clipable post adds them', () => {
    // Four files is already an unambiguous statement that they are not each meant to replace the
    // last. One file still replaces, which is what one file means.
    const at = only(workspace, 'const allVideo = files.every(', 'workspace.html');
    const scope = workspace.slice(at, at + 400);
    assert.ok(scope.includes('_pceCanAddClip()'), 'only where a cut is possible');
    assert.ok(scope.includes('files.length > 1'), 'several files mean clips');
    assert.ok(scope.includes('_pceAttachClips(files)'), 'and they go through the append');
});

check('intent and selection never outlive the modal', () => {
    // A stale intent would silently add when the next visit meant to replace; a stale selection
    // would offer to act on tiles from a post you have left.
    // The whole function, found by scanning to the next declaration — a fixed character window is
    // how this suite has twice reported a failure that was purely its own measurement.
    const at = only(workspace, 'function _pceCloseMediaPicker()', 'workspace.html');
    const rest = workspace.slice(at + 100);
    const end = rest.search(/\n(function |const |window\.|\/\*\*)/);
    assert.ok(end > 0, 'could not find the end of _pceCloseMediaPicker');
    const scope = workspace.slice(at, at + 100 + end);
    assert.ok(scope.includes('_pceClipAddMode = false'), 'the intent must be cleared on close');
    assert.ok(scope.includes('_pceOwnPicked = []'), 'and so must the selection');
});

console.log('\nthe video step');

check('step 4 stays shut until there is a video to put things ON', () => {
    // _pcePostIsVideo alone is true for a Reel-format draft with nothing attached, so the step
    // opened onto overlay and sound controls for media that did not exist — while its own subtitle
    // said "Add a video first".
    assert.ok(
        workspace.includes('enabled: (post) => _pcePostIsVideo(post) && !!post?.thumbnailUrl }'),
        'the video step must require attached media, not just a video FORMAT',
    );
});

check('the stage panels follow the STRIP, not the post-open path', () => {
    // Attaching a post's first video un-hides the strip but does not reopen the post, so rendering
    // the clips only on open left the panel hidden — and "Add another clip" lives in that panel.
    // _pceRenderLayers is the one function that runs on every media change and owns the strip.
    const at = only(workspace, 'function _pceRenderStagePanels()', 'workspace.html');
    const body = workspace.slice(at, at + 500);
    assert.ok(body.includes('_pceRenderClips()'), 'it must render the cut');
    assert.ok(body.includes('_pceRenderCropFrame()'), 'and the framing');

    // Every exit path of _pceRenderLayers, or the panel survives one state change and not another.
    // The window is the FUNCTION, found by scanning to the next top-level declaration — a fixed
    // character count silently measured only part of a heavily commented function and reported a
    // failure that was purely the measurement's.
    const layersAt = only(workspace, 'function _pceRenderLayers()', 'workspace.html');
    const rest = workspace.slice(layersAt + 200);
    const nextDecl = rest.search(/\n(function |const |window\.)/);
    assert.ok(nextDecl > 0, 'could not find the end of _pceRenderLayers');
    const layers = workspace.slice(layersAt, layersAt + 200 + nextDecl);
    const calls = layers.split('_pceRenderStagePanels()').length - 1;
    assert.strictEqual(calls, 3, `expected all 3 exit paths to render the panels, found ${calls}`);
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
