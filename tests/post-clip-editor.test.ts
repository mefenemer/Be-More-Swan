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
const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');

/** The source between two markers, the first of which must be unique. */
function slice(from: string, to: string): string {
    const a = only(workspace, from, 'workspace.html');
    const b = workspace.indexOf(to, a + 1);
    assert.ok(b > a, `end marker missing after ${from}: ${to}`);
    return workspace.slice(a, b);
}

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

check('there is ONE list, not a clip panel and a timeline panel', () => {
    // They were two panels, each enumerating the same clips — once as things to trim, once as
    // headings over their text — and joining them up was left to the reader. The timed rows now sit
    // inside the clip list. The old host is gone; anything still reaching for it is dead code.
    only(workspace, 'id="pce-clips-block"', 'workspace.html');
    assert.strictEqual(
        workspace.indexOf('getElementById(\'post-review-timeline\')'), -1,
        'something still renders into the retired timeline host — it no longer exists',
    );
    assert.strictEqual(
        workspace.indexOf('<div id="post-review-timeline"'), -1,
        'the retired timeline element is back in the markup',
    );
});

check('a clip is followed by the text that shows on it', () => {
    // The whole point of the merge: clip row, its trim slider, then its text — in that order,
    // inside the same row container.
    const at = only(workspace, "+ _pceTrimTrackHtml(c, i)", 'workspace.html');
    const after = workspace.slice(at, workspace.indexOf("}).join('');", at));
    assert.ok(after.includes('tl.byClip[i] && tl.byClip[i].html'), "the clip's own text is not drawn under it");
    assert.ok(after.includes('tl.byClip[i] && tl.byClip[i].axis'), "the clip's axis is not handed to its block");
    assert.ok(after.includes('No text on this clip'), 'an empty clip says nothing at all');
});

check('sound and orphans come after the clips, not under one of them', () => {
    // Sound plays across the cut, so it belongs to no single clip; an orphaned box belongs to none
    // either, and dropping it would hide text from the person approving the post.
    const at = only(workspace, "const tail = tl.orphans || tl.audio", 'workspace.html');
    const tail = workspace.slice(at, at + 900);
    assert.ok(tail.includes('Not on any clip'), 'orphaned text is not labelled');
    assert.ok(tail.includes('_pceTimedBlock(tl.audio, tl.cutAxis)'),
        'sound is not drawn, or is drawn without the cut axis it plays across');
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
    // ⚠️ Not a fixed character window — this asserted on 1200 chars and broke the moment a comment
    // was added above the bail-out. Scan to a real boundary instead.
    const scope = slice('function _pceRenderClips(clipsOverride)', '_pceMeasureClips(clips);');
    assert.ok(scope.includes('if (!clips.length && !tl.any && !photoText) {'),
        'only an empty cut with nothing timed and no picture hides the panel');
    assert.ok(!scope.includes('worthShowing'), 'the two-clip threshold must be gone');
});

check('the add button is wired to the appending path', () => {
    only(workspace, 'window._pceAddClipFiles = function', 'workspace.html');
    assert.ok(workspace.includes('data-pce-act="add-clip"'), 'the panel must offer it');
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

check('Replace is offered only when there is something to replace, with one ticked', () => {
    // Two failures this closes. "Replace with this" on a post with NO video named something that
    // was not there; and two ticked showed an EMPTY bar, because Add was gated on existing media
    // and Replace on a single selection, so neither survived.
    const at = only(workspace, 'const canReplace =', 'workspace.html');
    const scope = workspace.slice(at, at + 500);
    assert.ok(scope.includes('n === 1'), 'one ticked names a single replacement');
    assert.ok(scope.includes('_pceHasClipToAddTo()'), 'and there must be something to replace');
    assert.ok(scope.includes('!canAdd && !canReplace'), 'an empty bar must not be shown at all');
});

check('Add is offered on an EMPTY post — the first clip becomes the base', () => {
    // _pceCanAddClip is a property of the FORMAT, not of what is attached. Requiring media is what
    // left an empty Reel draft offering only "Replace with this".
    const at = only(workspace, 'function _pceCanAddClip() {', 'workspace.html');
    const scope = workspace.slice(at, at + 320);
    assert.ok(!scope.includes('thumbnailUrl'), 'adding must not require existing media');
    // ...while the question "add or replace" still does.
    const has = only(workspace, 'function _pceHasClipToAddTo() {', 'workspace.html');
    assert.ok(workspace.slice(has, has + 320).includes('thumbnailUrl'));
});

check('the add button never says "Replace" or names a count of one oddly', () => {
    const at = only(workspace, "add.textContent = n === 1", 'workspace.html');
    assert.ok(workspace.slice(at, at + 120).includes("'Add'"), 'one ticked reads simply Add');
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
    // ⚠️ Scan the whole function, not 500 characters — it grew when binding moved ahead of
    // rendering, and a window that stops short is a false failure about a true property.
    const body = slice('function _pceRenderStagePanels() {', '\nfunction _pceRenderLayers()');
    assert.ok(body.includes('_pceRenderClips'), 'it must render the cut');
    assert.ok(body.includes('_pceRenderCropFrame'), 'and the framing');

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

console.log('\nthe timeline axis');

check('the axis is the CUT, not the clip on the canvas', () => {
    // The canvas shows clip one. Measuring it gave a ruler the length of the first clip, so text
    // could only ever be timed onto that one — the rest were off the end of the ruler, not
    // disabled and not explained.
    const at = only(workspace, 'const cut = typeof _pceClipsTotalS', 'workspace.html');
    const scope = workspace.slice(at, at + 260);
    assert.ok(scope.includes('cut != null ? cut'), 'the cut wins when there is one');
    assert.ok(scope.includes('_rqVideoDuration()'), 'and a single clip still measures itself');
});

check('the panel total and the axis are the SAME number', () => {
    // A ruler that disagrees with the clip list puts every box somewhere other than it was dragged.
    only(workspace, 'function _pceClipsTotalS(post)', 'workspace.html');
    const at = only(workspace, 'function _pceClipsTotalS(post)', 'workspace.html');
    const scope = workspace.slice(at, at + 600);
    assert.ok(scope.includes('_pceClipLength(c)'), 'built from the same per-clip length the panel shows');
    assert.ok(scope.includes('return null'), 'and null while any clip is still being measured');
});

check('the overlay clamp measures the cut too', () => {
    // Called with the canvas clip's duration, it pulled every box timed onto clips two-to-four back
    // into the first and told the reviewer they had overrun — destroying the work it exists to save.
    assert.ok(workspace.includes('_pceClipsTotalS(_rqPostCache[_rqReviewPostId] || post) ?? media.duration'),
        'the reconcile must be given the cut length');
});

check('clip boundaries need no marks now that each clip is its own group', () => {
    // They existed because one continuous axis was 36 anonymous seconds and "put this on the third
    // clip" was arithmetic. Each clip now has its own block, so the boundary IS the row break.
    assert.strictEqual(workspace.indexOf('let clipMarks ='), -1, 'the boundary marks are back');
    // What replaced them still must not look draggable.
    const scope = slice('function _pceTimedBlock(inner, axis) {', '/** Read the axis a track or block');
    assert.ok(scope.includes('pointer-events-none'), 'the playhead must not be grabbable');
    assert.ok(!scope.includes('data-tl-seg'), 'and must not look like a track segment');
});

console.log('\npreviewing the cut');

check('the preview is a CLOCK, not a second player', () => {
    // The canvas element already drives the text layer, the sound and the playhead off its own
    // timeupdate. A second player would need its own copy of all three.
    const scope = slice('function _pceCutTime(video) {', '\n/** How long the finished video is');
    // ⚠️ It used to hand the raw element clock back whenever a preview was NOT running — which is
    // the out-of-sync scrubbing: the canvas holds one clip, its currentTime is that clip's own
    // source seconds, and every box is timed against the finished cut. They only agree on an
    // untrimmed first clip, which is why it looked fine until someone scrubbed a cut with a trim.
    assert.ok(!scope.includes('if (!_pcePrev.on) return t'),
        'the element clock is handed back untranslated again while not previewing');
    assert.ok(scope.includes('_pcePrev.on') && scope.includes('video.currentSrc'),
        'the clip the element is holding is not identified');
    assert.ok(scope.includes('_pceClipLength(clips[k])'), 'the earlier clips are not summed');
    assert.ok(scope.includes('Math.min(within, len)'),
        'seeking into trimmed-away footage still reports a second of the finished video');
});

check('overlays, sound and the playhead all read the CUT clock', () => {
    // Any one of them left on video.currentTime would fire clip three\'s text during clip one.
    const ov = only(workspace, 'function _rqApplyOverlayTimes(video, layer, post)', 'workspace.html');
    assert.ok(workspace.slice(ov, ov + 400).includes('_pceCutTime(video)'), 'overlays');
    const au = only(workspace, 'function _pceSyncAudioPreview(video)', 'workspace.html');
    assert.ok(workspace.slice(au, au + 400).includes('_pceCutTime(video)'), 'sound');
    const head = only(workspace, "const dur = _pceCutDuration(video, post);", 'workspace.html');
    assert.ok(head > 0, 'the playhead must scale to the cut, not the clip');
});

check('pressing play on the canvas previews the whole cut', () => {
    // The native control played clip one and stopped — a reasonable thing for a <video> to do, and
    // the wrong answer to "show me the post".
    const at = only(workspace, "media.addEventListener('play', () => {", 'workspace.html');
    const scope = workspace.slice(at, at + 400);
    assert.ok(scope.includes('_pcePreviewStart()'), 'play starts the cut preview');
    assert.ok(scope.includes('_pcePrev.starting || _pcePrev.on'), 'and cannot re-enter itself');
});

check('the canvas is borrowed and returned through ONE door', () => {
    // Two features drive the same <video> — previewing a cut and scrubbing a trim handle. Two
    // independent bits of src bookkeeping would race, and whichever finished last would decide what
    // the post appeared to be attached to for the rest of the session.
    only(workspace, 'function _pceCanvasBorrow()', 'workspace.html');
    only(workspace, 'function _pceCanvasRestore()', 'workspace.html');
    // ⚠️ A boundary slice, not a character window. This was `slice(stop, stop + 400)` and it broke the
    // moment the function grew a comment — the same trap logged five times in this file already.
    const stopFn = slice('window._pcePreviewStop = function () {', '\nfunction _pcePreviewTick(video) {');
    assert.ok(stopFn.includes('_pceCanvasRestore()'), 'preview returns it');
    // The trim drag borrows it for the duration of the drag and hands it back on release; there is
    // no selection to deselect any more.
    // Bounded by the end of the handler, not by a character count. Three times now a fixed window
    // in this suite has reported a failure that was purely its own measurement.
    const endAt = only(workspace, 'if (clips) _pceClipsChanged(clips);   // one save, on release', 'workspace.html');
    const close = workspace.indexOf('\n    };', endAt);
    assert.ok(close > endAt, 'could not find the end of the release handler');
    assert.ok(workspace.slice(endAt, close).includes('_pceCanvasRestore()'), 'the drag returns it');
});

console.log('\ntrimming by eye');

check('dragging a handle scrubs the canvas to that frame', () => {
    // Numbers in a box cannot answer "does it cut before he turns round".
    // Bounded by the RELEASE handler, not by a character count: a fixed window ran past the end of
    // the move handler into the release, which is the one place a save is correct.
    const at = only(workspace, 'if (!_pceTrimDrag.on) return;\n        const track = host.querySelector', 'workspace.html');
    // Searched FORWARD from the move handler — `const end = () => {` is not unique, the crop frame
    // has one of its own.
    const endAt = workspace.indexOf('const end = () => {', at);
    assert.ok(endAt > at, 'the release handler should follow the move handler');
    const scope = workspace.slice(at, endAt);
    assert.ok(scope.includes('_pceCanvasShowFrame('), 'the handle shows its own frame');
    assert.ok(scope.includes('_pceTrimPaint('), 'and moves without rebuilding the row');
    assert.ok(!scope.includes('_pceClipsChanged('), 'a drag must not save on every move');
});

check('the trim saves once, on release', () => {
    const at = only(workspace, 'const end = () => {\n        if (!_pceTrimDrag.on) return;', 'workspace.html');
    assert.ok(workspace.slice(at, at + 500).includes('_pceClipsChanged(clips)'));
});

check('the kept window can never collapse to nothing', () => {
    // A window of a frame or two is never what a drag meant, and renders as a stutter.
    const at = only(workspace, 'const MIN = 0.25;', 'workspace.html');
    const scope = workspace.slice(at, at + 500);
    assert.ok(scope.includes('out - MIN') && scope.includes('+ MIN'), 'both edges respect the floor');
});

check('every clip shows its slider — nothing is behind a tap', () => {
    // Hidden state has caused every failure in this feature. A control you have to discover is one
    // more of it, and "sliders to pick the section" is not a thing you tap to reveal.
    const at = only(workspace, '+ _pceTrimTrackHtml(c, i)', 'workspace.html');
    assert.ok(at > 0, 'the track must be rendered unconditionally');
    assert.ok(!workspace.includes('_pceSelectedClipId'), 'no per-clip selection state should remain');
    assert.ok(!workspace.includes("window._pceSelectClip"), 'and no tap-to-reveal handler');
});

console.log('\ntext, per clip');

check('overlays stay STORED in cut seconds — only the question changes', () => {
    // The renderer times boxes against the finished video, and a box that spans a cut would have
    // nowhere else to live. Storing per-clip would be a migration and a render change for a UI
    // preference.
    // The builder moved into _pceSpansFor so the "before" and "after" of a trim can both be built
    // from explicit clip lists; _pceClipSpans is now the UI wrapper that hides a one-clip post.
    const build = only(workspace, 'function _pceSpansFor(clips)', 'workspace.html');
    const scope = workspace.slice(build, build + 700);
    assert.ok(scope.includes('start: at, end: at + len'), 'spans are cut-relative');
    assert.ok(scope.includes('return null'), 'and no honest span while a clip is still measuring');
    const ui = only(workspace, 'function _pceClipSpans(post)', 'workspace.html');
    assert.ok(workspace.slice(ui, ui + 500).includes('spans.length > 1 ? spans : null'),
        'one clip is not a cut, for the UI');
});

check('moving text to another clip keeps how long it shows for', () => {
    // "The same text, on the next clip" is what the move means — not "the same seconds".
    const at = only(workspace, 'window._pceOverlayToClip = function', 'workspace.html');
    const scope = workspace.slice(at, at + 1100);
    assert.ok(scope.includes('const shown ='), 'its duration is measured before the move');
    assert.ok(scope.includes('to.start +'), 'and re-based onto the new clip');
    assert.ok(scope.includes('Math.min(to.end'), 'clamped inside that clip');
});

check('the text editor itself can choose the clip and the moment', () => {
    // Deciding what a box says and deciding when it shows are the same act of writing, so the
    // controls belong beside the text — not only in a panel behind the modal.
    assert.ok(ioe.includes('function timingRow(ov)'), 'the editor builds a timing row');
    assert.ok(ioe.includes('data-when-track'), 'with a scrub track');
    assert.ok(ioe.includes('data-clip='), 'and clip chips');
    // Fed the SAME spans the When panel uses, or the two disagree about which clip a box is on.
    // ⚠️ The post editor no longer opens this modal — text is edited beside the picture. The
    // component keeps these controls because the newsletter designer still opens it, and because
    // removing a working path is not the same job as stopping using it.
    assert.strictEqual(workspace.indexOf('async function _pceOpenOverlayEditor'), -1,
        'the post editor opens the modal again');
});

check('the editor skips all of it when there is no cut', () => {
    // A still, or one clip, has one answer to "when" — a control offering to choose is noise.
    const at = only(ioe, 'const readSpans = () =>', 'image-overlay-editor.js');
    assert.ok(ioe.slice(at, at + 220).includes('v.length > 1 ? v : null'));
    // The page hands over RAW spans. Folding a one-clip post into null there made "one clip" and
    // "still loading" the same answer, so the editor could not say which and said nothing for both.
    // Whoever passes spans must hand over RAW ones: folding a one-clip post into null makes "one
    // clip" and "still loading" the same answer, and the editor then says nothing for both.
    assert.ok(ioe.includes('typeof spans === \'function\' ? spans() : spans'),
        'the editor must read spans fresh, and unfolded');
    // On a still it renders nothing; on a VIDEO whose clips are still being measured it says so,
    // because rendering nothing is indistinguishable from the feature not existing.
    const tr = only(ioe, 'function timingRow(ov)', 'image-overlay-editor.js');
    // Bounded by the next function, not a character count — this suite has now reported four
    // failures that were purely its own measurement.
    const tEnd = ioe.indexOf('\n    /**', tr + 10);
    assert.ok(tEnd > tr, 'could not find the end of timingRow');
    const scope = ioe.slice(tr, tEnd);
    // Three reasons these controls can be absent, identical on screen: a photo, one clip, or clips
    // still measuring. Rendering nothing for all three is what produced two rounds of "the section
    // has disappeared" — it was correct every time and simply mute about it.
    assert.ok(scope.includes('This is a photo post'), 'a photo says so');
    assert.ok(scope.includes('One clip, so there is nothing to choose between'), 'one clip says so');
    assert.ok(scope.includes('Reading the clips'), 'and a video still measuring says so');
});

check('a second box lands on the clip you were looking at', () => {
    // Adding text while on clip three and having it appear over clip one is what makes the feature
    // look like it only works once.
    // The defaults moved into the shared newOverlay factory; what stays here is the modal's own
    // rule about WHICH clip a new box belongs to.
    const at = only(ioe, 'const ov = newOverlay(onSpan', 'image-overlay-editor.js');
    const before = ioe.slice(Math.max(0, at - 600), at);
    assert.ok(before.includes('const onSpan = readSpans() && sel ? ovSpan(sel) : null'), 'it inherits the selected box\'s clip');
    assert.ok(ioe.slice(at, at + 200).includes('startS: onSpan.start'), 'and starts there');
});

check('the editor still passes timing through untouched when it does not manage it', () => {
    // It always did, deliberately. Adding controls must not turn that into "only what the controls
    // wrote", or a box timed elsewhere would lose its timing on a text edit.
    const at = only(ioe, 'Pass through video timing', 'image-overlay-editor.js');
    const scope = ioe.slice(at, at + 400);
    assert.ok(scope.includes('o.startS != null') && scope.includes('o.endS != null'));
});

check('the stage shows the clip the selected text is on', () => {
    // "Where does this go" cannot be answered against a frame of a different clip.
    const at = only(ioe, 'async function showClipFrame(ov, t)', 'image-overlay-editor.js');
    const scope = ioe.slice(at, at + 1100);
    assert.ok(scope.includes("imgEl.style.display = 'none'"), 'the still backdrop steps aside');
    assert.ok(scope.includes('vidEl.currentTime'), 'and the clip is seeked');
    assert.ok(scope.includes('(clip.inS || 0) + within'), 'cut seconds converted to source seconds');
    assert.ok(scope.includes('vidEl.pause()'), 'paused — a frame to judge against, not playback');
});

check('the slider scrubs that clip as it moves', () => {
    // A slider over a number earns its place only if the start is chosen by SEEING where it starts.
    const at = only(ioe, 'paintWhen(ov);', 'image-overlay-editor.js');
    assert.ok(ioe.slice(at, at + 400).includes('showClipFrame(ov,'), 'the handle shows its frame');
});

check('every way of changing the selection moves the stage with it', () => {
    // Chips, the box list, clicking a box on the stage, and opening the editor: a stage that
    // followed only some of them would be wrong in a way that looks random.
    assert.ok(ioe.split('syncStageToSelection()').length - 1 >= 4, 'all the selection paths sync');
    const clipBtn = only(ioe, "const to = cutNow[Number(b.getAttribute('data-clip'))]", 'image-overlay-editor.js');
    assert.ok(ioe.slice(clipBtn, clipBtn + 700).includes('showClipFrame(ov, ov.startS)'), 'chips too');
});

check('overlays are measured against the VISIBLE backdrop', () => {
    // This measured the <img> unconditionally, which was fine while the <img> was the only backdrop.
    // Once a clip could replace it, the hidden image measured 0x0 — so fontSizePct, a fraction of
    // the backdrop's HEIGHT, resolved to zero and every box rendered as an empty two-pixel square.
    // Dragging broke with it, since it positions against the same rect.
    const at = only(ioe, 'function stageMetrics()', 'image-overlay-editor.js');
    assert.ok(ioe.slice(at, at + 200).includes('backdropEl().getBoundingClientRect()'),
        'it must measure whichever backdrop is on screen');
    const be = only(ioe, 'function backdropEl()', 'image-overlay-editor.js');
    assert.ok(ioe.slice(be, be + 200).includes("vidEl.style.display !== 'none'"), 'chosen by what is shown');
});

check('the clip re-sizes the overlays once it is laid out, not in the same tick', () => {
    // Measuring in the same tick as the swap reads the size the element had BEFORE it was shown.
    assert.ok(ioe.includes('requestAnimationFrame(renderOverlays)'));
});

check('the stage shows only the boxes that belong to the clip on screen', () => {
    // It drew all of them, so four boxes on four different clips looked like four boxes on EVERY
    // clip, stacked on whichever one you were looking at.
    const at = only(ioe, 'function stageOverlays()', 'image-overlay-editor.js');
    const scope = ioe.slice(at, at + 500);
    assert.ok(scope.includes('ovSpan(o).i === here'), 'filtered by the clip a box starts in');
    assert.ok(scope.includes('if (!readSpans()) return state'), 'and unfiltered on a post that is not a cut');
    const ro = only(ioe, 'function renderOverlays()', 'image-overlay-editor.js');
    assert.ok(ioe.slice(ro, ro + 400).includes('of stageOverlays()'), 'the stage must use it');
});

check('a specific box can be picked, including one on another clip', () => {
    // The canvas cannot answer "which am I editing" when the others are not even on screen.
    assert.ok(ioe.includes('data-pick='), 'the side panel lists the boxes');
    const at = only(ioe, "b.getAttribute('data-pick')", 'image-overlay-editor.js');
    const scope = ioe.slice(at - 200, at + 300);
    assert.ok(scope.includes('syncStageToSelection()'), 'picking moves the stage to that box\'s clip');
});

check('the counter says what is on screen when that differs from what exists', () => {
    const at = only(ioe, 'const shown = stageOverlays().length', 'image-overlay-editor.js');
    assert.ok(ioe.slice(at, at + 400).includes("showing this clip's"));
});

console.log('\nthe timeline reads as one thing');

check('text rows sit under the clip they belong to', () => {
    // Two stacks — every clip, then every box — made the reader do the join: which of these five
    // rows is on the clip I just trimmed?
    const at = only(workspace, 'const placed = new Set();', 'workspace.html');
    const scope = workspace.slice(at, at + 1200);
    assert.ok(scope.includes('at.i === sp.i'), 'boxes grouped by the clip they start in');
    assert.ok(scope.includes('byClip[sp.i]'), 'the grouping is not keyed by clip index');
    // The clip heading is the clip's own row now, and the empty case is stated where it is placed.
    assert.ok(workspace.includes('No text on this clip'), 'an empty clip says so');
});

check('a box that cannot be placed is listed, never dropped', () => {
    // After a trim, before re-anchoring catches up, a box can sit past the end. Losing it from the
    // view would look like losing it from the post.
    const at = only(workspace, 'orphans = overlays.filter((_, i) => !placed.has(i))', 'workspace.html');
    assert.ok(workspace.slice(at, at + 200).includes('textRow('), 'orphans are not rendered');
    assert.ok(workspace.includes('Not on any clip'), 'orphans are rendered but never labelled');
});

check('every row states its seconds', () => {
    // A bar without numbers is a shape: you can see one box is later than another, not when either
    // happens. Per clip AND overall, because both answer a different question.
    const at = only(workspace, 'let sub;', 'workspace.html');
    const scope = workspace.slice(at, workspace.indexOf('return row(', at));
    assert.ok(scope.includes('of clip ${sp.i + 1}'), 'the clip reading is gone');
    assert.ok(scope.includes('of the whole cut'), 'the cut reading is gone');
    // ⚠️ A box with no end time runs to the end of the WHOLE video, not of the clip it starts on.
    // "0s → 36.7s of clip 1" was on screen about a 10.7s clip, under a bar covering all four.
    assert.ok(scope.includes('ov.endS == null || ov.endS > sp.end'),
        'a box that runs past its clip is still described as inside it');
    assert.ok(scope.includes('on to the end of the video'), 'nothing says the box carries on past that clip');
    // Audio too.
    assert.ok(workspace.includes('plays for ${fmt(Math.max(0, en - st))}'));
});

console.log('\nhow the text appears');

check('the editor only offers motion on a video', () => {
    // A still's text is flattened into the pixels — offering motion would promise something the
    // published image cannot do.
    const at = only(ioe, 'function animRow(ov)', 'image-overlay-editor.js');
    assert.ok(ioe.slice(at, at + 200).includes("if (!isVideo()) return ''"));
    // The post editor asks the same question of its own panel, which is the surface that has
    // replaced this one for a post.
    const style = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    assert.ok(style.includes('video: _pcePostIsVideo(post)'),
        'the panel beside the picture would offer a still motion it cannot do');
});

check('the panel is collapsible, and remembers what was open', () => {
    // It grew from "text, font, colour" to eight groups; on a laptop the thing you came to change
    // is below the fold.
    const at = only(ioe, 'const openSections =', 'image-overlay-editor.js');
    assert.ok(ioe.slice(at, at + 200).includes('when: true'), 'timing starts open');
    assert.ok(ioe.includes('data-sect-toggle='), 'and the headings toggle');
});

check('the animation reaches the renderer and the fingerprint', () => {
    // Stored but unrendered would be a control that does nothing; rendered but unfingerprinted
    // would let two siblings differing only in motion share one render.
    const po = readFileSync(join(root, 'remotion/PostOverlay.tsx'), 'utf8');
    assert.ok(po.includes('overlayAnimAt(ov.anim'), 'the composition applies it');
    assert.ok(po.includes('useCurrentFrame()'), 'against the box\'s own clock');
    const pr = readFileSync(join(root, 'src/lib/post-render.ts'), 'utf8');
    const fp = pr.indexOf('export function overlaysFingerprint');
    assert.ok(pr.slice(fp, fp + 900).includes('o.anim'), 'and the fingerprint includes it');
});

check('the controls appear when the clips finish measuring, without being poked', () => {
    // Lengths are read off <video> elements, so "is this a cut" is often unanswerable when the modal
    // opens. Waiting for a click would mean the controls appear only if the user happens to poke the
    // panel — which is how this was reported: the section had simply "disappeared".
    const at = only(ioe, 'const watchForSpans = () =>', 'image-overlay-editor.js');
    const scope = ioe.slice(at, at + 500);
    assert.ok(scope.includes('renderSide()'), 'it redraws once the answer exists');
    assert.ok(scope.includes('backdrop.isConnected'), 'and stops when the modal is gone');
    assert.ok(scope.includes('spanWatch > 25'), 'and stops when the answer plainly is not coming');
});

console.log('\nthe crop frame');

check('the crop panel exists and follows the clip list', () => {
    // The crop frame answers "what does this platform keep", which only means something once the
    // cut it crops is decided above it.
    const clips = only(workspace, 'id="pce-clips-block"', 'workspace.html');
    const crop = only(workspace, 'id="pce-crop-block"', 'workspace.html');
    assert.ok(clips < crop, 'the crop frame must come after the list that decides the cut');
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


// ── The clip controls must be FINDABLE, not merely present ──────────────────────────────────────
// "The Shows on clip section has disappeared" was reported three times. The section was rendered
// correctly every time. It was at the BOTTOM of a 300px column, below seven styling rows, in a
// panel that scrolled with the whole modal — so on a laptop it was off-screen, which on the user's
// side is indistinguishable from not existing. These checks pin the two properties that fix cost
// hours to establish: the section is unconditional, and it is above the styling.

console.log('\nthe text editor puts the clip controls where they can be seen');

check('"When it shows" renders for every post — a photo gets an explanation, not silence', () => {
    // sect() drops a section whose body is empty, so timingRow must never return ''. Each of the
    // three reasons the controls are absent has to say which one it is.
    const i = only(ioe, 'function timingRow(ov) {', 'image-overlay-editor.js');
    const body = ioe.slice(i, ioe.indexOf('\n    function ', i + 10));
    assert.ok(!/return\s*''/.test(body), 'timingRow returns an empty string somewhere — that hides the whole section');
    assert.ok(/photo post/i.test(body), 'no message for a still');
    assert.ok(/One clip/i.test(body), 'no message for a single-clip video');
    assert.ok(/Reading the clips/i.test(body), 'no message for clips that have not measured yet');
});

check('both video sections sit above the styling controls', () => {
    const when = only(ioe, "sect('when', 'When it shows'", 'image-overlay-editor.js');
    const anim = only(ioe, "sect('anim', 'How it appears'", 'image-overlay-editor.js');
    const font = only(ioe, '<label>Font</label>', 'image-overlay-editor.js');
    const del = only(ioe, 'class="ioe-btn danger block" data-act="delete"', 'image-overlay-editor.js');
    assert.ok(when < font, '"When it shows" is below the font picker again');
    assert.ok(anim < font, '"How it appears" is below the font picker again');
    assert.ok(when < del && anim < del, 'the sections drifted back to the bottom of the panel');
});

check('the side panel scrolls on its own', () => {
    // Without this the column is as tall as its content and only the modal body scrolls, which
    // drags the picture you are positioning text against off the screen.
    const css = ioe.slice(only(ioe, '.ioe-side{', 'image-overlay-editor.js'));
    const rule = css.slice(0, css.indexOf('}'));
    assert.ok(rule.includes('overflow-y:auto'), '.ioe-side no longer scrolls');
    assert.ok(rule.includes('min-height:0'), 'a flex child needs min-height:0 before overflow does anything');
});

check('the panel rows cannot be squashed to a hairline', () => {
    // THE bug behind three "the section has disappeared" reports. A column flex container shrinks
    // its children rather than scrolling, and .ioe-sect is overflow:hidden — so it collapses to
    // ~1px while the DOM, the text and every assertion about it stay perfectly correct.
    only(ioe, '.ioe-side > *{flex-shrink:0}', 'image-overlay-editor.js');
});

check('every local component script is cache-busted at build time', () => {
    // /src/components/*.js carried no version of any kind, so a tab could keep running an old
    // component under current HTML — a feature "disappearing" with no trace in the deploy.
    const stamper = readFileSync(join(root, 'scripts/stamp-view-version.mjs'), 'utf8');
    only(stamper, 'function stampLocalScripts(', 'stamp-view-version.mjs');
    assert.ok(/src=/.test(stamper), 'the stamper no longer looks at script src attributes');
    assert.ok(stamper.includes("src.includes('?')"), 'manual ?v= pins must be left alone');
    assert.ok(/https\?:/.test(stamper), 'CDN urls must be skipped');
    // And it has to actually run on deploy.
    const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
    assert.ok(/command = "[^"]*build:version/.test(toml), 'build:version dropped out of the Netlify build command');
});


// ── Nothing repaints the list while something in it is being dragged ────────────────────────────
// Reported as "when I try to slide, it seems to extend the slider fully and if I click again it
// disappears". Reproduced in a browser: a repaint during pointerdown detaches the node under the
// pointer, a detached node's getBoundingClientRect() is all zeros, so (clientX - 0) / 0 is Infinity,
// the clamp turns that into the end of the axis — and the mangled start time moves the row under a
// different clip. Both halves of the report, from one missing guard.
//
// This was survivable while the timeline lived in its own element that only _rqRenderTimeline
// touched. Folding the rows into the clip list put them in the path of every repaint of it.

console.log('\na drag is never repainted out from under the pointer');

check('the clip list refuses to repaint mid-drag, and defers instead', () => {
    const at = only(workspace, 'function _pceRenderClips(clipsOverride) {', 'workspace.html');
    const head = workspace.slice(at, at + 400);
    assert.ok(head.includes('if (_pceDragActive())'), 'the list repaints during a drag');
    assert.ok(head.includes('_pceClipsRepaintPending = true'),
        'a repaint refused during a drag must be deferred, not dropped');
});

check('the hold is DERIVED from the drags, never counted', () => {
    // ⚠️ It was a counter. A counter is only as good as its releases: two pointerdowns without two
    // releases leave it stuck above zero for the rest of the session, and _pceRenderClips then
    // silently stops repainting — "Preview the whole cut" never becomes "Stop preview", so both
    // buttons look dead while trimming still appears to work (_pceTrimPaint mutates styles rather
    // than re-rendering). Reading the drag objects makes that state unreachable.
    assert.strictEqual(workspace.indexOf('_pceDragHold'), -1, 'the drag counter is back');
    const fn = slice('function _pceDragActive() {', '/** Run a repaint that a drag deferred.');
    assert.ok(fn.includes('_pceTrimDrag.on'), 'the trim drag is not consulted');
    assert.ok(fn.includes('_rqTlDrag'), 'the timeline drag is not consulted');
});

check('the timeline builds its drag BEFORE the selection repaint', () => {
    // _pceSelect repaints the list. Selecting first means the drag is assembled out of a node that
    // repaint has already detached — which is exactly the state that produced the bug — and it also
    // happens before _pceDragActive() can see the drag at all, so the repaint is not even deferred.
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    const assign = tl.indexOf('_rqTlDrag = {');
    const select = tl.indexOf("_pceSelect('overlays')");
    assert.notStrictEqual(assign, -1);
    assert.notStrictEqual(select, -1);
    assert.ok(assign < select, 'the drag must exist before anything that can repaint the list');
});

check('a drag that never reaches the host still ends', () => {
    // Both drags defer repaints, so one that never ends freezes the panel with no error anywhere.
    // The window runs the SAME end handler, so a stray release still saves what the drag did.
    for (const [from, to] of [
        ['function _rqBindTimeline() {', '\nasync function openPostReview('],
        ['function _pceBindClipTrim() {', '/** Move the lit section'],
    ] as const) {
        const fn = slice(from, to);
        assert.ok(fn.includes("window.addEventListener('pointerup', end)"), `no window safety net in ${from}`);
        assert.ok(fn.includes("window.addEventListener('pointercancel', end)"), `no cancel safety net in ${from}`);
    }
});

check('a dead rect is never read as "dragged to the end"', () => {
    // Belt as well as braces: the failure is silent, and Infinity clamps to a plausible number.
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    assert.ok(tl.includes('d.track.isConnected'), 'a detached track is not detected');
    assert.ok(tl.includes('!(rect.width > 0)'), 'a zero-width rect still divides by zero');
    assert.ok(tl.includes('d.key'), 'nothing lets the drag re-find its own segment');
});

check('the release repaints rather than deferring the repaint it came to do', () => {
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    // ⚠️ Scan to the end of the handler, not a fixed window — this broke once already when the
    // handler grew, which is a false failure about a true ordering.
    const at = tl.indexOf('const end = () => {');
    const end = tl.slice(at, tl.indexOf('\n    };', at));
    assert.ok(end.indexOf('_rqTlDrag = null') < end.indexOf('_rqRenderTimeline('),
        'the drag must be cleared before the repaint, or that repaint is deferred to nothing');
    assert.ok(end.includes('_pceClipsRepaintPending = false'),
        'the deferred repaint should be consumed by this one, not run twice');
});

console.log('\nremoving a text box, and lining it up with the clip it is on');

check('every text row can be deleted from the post editor', () => {
    // It was only possible inside the text editor: open a modal, find the right box among several
    // on several clips, delete it there. It is a layer in a list, and the list deletes.
    const at = only(workspace, 'const del = kind === ', 'workspace.html');
    const del = workspace.slice(at, at + 500);
    assert.ok(del.includes("kind === 'text'"), 'sound rows must not offer a text delete');
    assert.ok(del.includes('data-pce-act="remove-text"'), 'the button is not wired');
    const fn = slice('window._pceOverlayRemove = function (key) {', 'window._pceClipTrim = function');
    assert.ok(fn.includes('window.confirm'), 'typed words deleted with no question asked');
    assert.ok(fn.includes('_rqPersistOverlays('), 'the deletion is never saved');
    assert.ok(fn.includes('_rqRenderCanvasOverlays('), 'the box stays on the picture');
    // Older overlays have no id and are keyed by index — both must resolve, or a row deletes a
    // different box from the one it draws.
    assert.ok(fn.includes('o.id === key'), 'id rows are not resolved');
    assert.ok(fn.includes('Number(key)'), 'index-keyed rows are not resolved');
});

check('a text bar is the same box as the clip slider above it', () => {
    // The label used to sit in a 4rem column to the LEFT of the track, so a text bar started 4.5rem
    // in while the clip's trim slider started at the edge — two bars over the same clip on two
    // different margins, which is the one comparison a timeline exists to make.
    // ⚠️ A boundary, not a 1600-char window — the row markup grew and the window stopped reaching
    // the track, which is a false failure about a true property. Third time this file has done it.
    const row = slice('const within = sub ?', 'const nameInput = (key, label)');
    assert.ok(!row.includes('w-16 shrink-0 truncate'), 'the label is back in a left-hand column');
    assert.ok(!row.includes('ml-[4.5rem]'), 'the seconds line is still indented past the bar');
    assert.ok(row.includes('class="relative flex-1 min-w-0 h-6 rounded bg-gray-100" data-tl-track'),
        'the track no longer fills the row beside its numbers');
    // The block supplies the same px-1 inset _pceTrimTrackHtml uses, so both boxes match.
    const block = slice('function _pceTimedBlock(inner, axis) {', '/** Read the axis a track or block');
    assert.ok(block.includes("'<div class=\"px-1 pb-1\" data-tl-group'"), 'the inset no longer matches the clip slider');
    assert.ok(only(workspace, 'function _pceTrimTrackHtml(clip, index) {', 'workspace.html') > 0);
});

check('the panel is called Timeline', () => {
    const at = only(workspace, "const heading = ", 'workspace.html');
    assert.ok(workspace.slice(at, at + 60).includes("'Timeline'"));
    assert.strictEqual(workspace.indexOf('Clips &amp; timeline'), -1, 'the old heading is back');
});


// ── Dragging a text box onto another clip ───────────────────────────────────────────────────────
// Dragging along the axis already crossed clip boundaries, but only by moving the box to a
// completely different MOMENT. "Same place in clip 3 instead of clip 1" had no gesture at all — it
// meant opening the text editor and picking a chip.

console.log('\nmoving a text box between clips');

check('sideways re-times, downwards drops it on another clip', () => {
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    assert.ok(tl.includes('_rqClipRowAt(ev.clientX, ev.clientY)'), 'nothing looks for a drop target');
    assert.ok(tl.includes('if (drop != null) return;'),
        'the box keeps sliding sideways while it is being dropped somewhere else');
    assert.ok(tl.includes('_rqPaintDropTarget(drop)'), 'the target clip is not shown');
});

check('the drop target is drawn with inline styles, not a utility class', () => {
    // The compiled stylesheet only carries utilities the markup already uses, so a ring- class that
    // appears nowhere else is purged and the highlight simply does not exist — the same way the
    // timeline's segment fills once drew with no colour at all.
    const fn = slice('function _rqPaintDropTarget(index) {', '// Timeline drag: bound ONCE');
    assert.ok(fn.includes('row.style.outline'), 'the highlight is not inline');
    assert.ok(!/class(List)?\.(add|toggle)/.test(fn), 'a purgeable class is being toggled');
});

check('a drop keeps the OFFSET in the clip, not the second in the cut', () => {
    // "Two seconds in, for three seconds" is what the reviewer decided, and it means the same thing
    // on any clip. The absolute second does not.
    const fn = slice('window._pceOverlayToClip = function (index, key) {', '/* The chips, the clip-relative scrub');
    assert.ok(fn.includes('const within ='), 'the offset is not preserved');
    assert.ok(fn.includes('const shown ='), 'the duration is not preserved');
    assert.ok(fn.includes('Math.min(to.end'), 'a box can outlast the clip it was dropped on');
    assert.ok(fn.includes('from.i === to.i'), 'dropping a box on the clip it already lives on is not a no-op');
});

check('a drop saves instead of writing back the timing it had mid-hover', () => {
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    const at = tl.indexOf('const end = () => {');
    const end = tl.slice(at, tl.indexOf('\n    };', at));
    assert.ok(end.includes("kind === 'text' && drop != null"), 'a drop is not distinguished from a re-time');
    assert.ok(end.indexOf('_pceOverlayToClip(drop, key)') < end.indexOf('_rqPersistOverlays('),
        'the ordinary save must not also run after a drop');
});

check('the move-to-clip save looks the post up the way persist does', () => {
    // ⚠️ It passed post.id, while _rqPersistOverlays looks the post up BY that argument — a cache
    // row without an `id` field saved absolutely nothing, silently.
    const fn = slice('window._pceOverlayToClip = function (index, key) {', '/* The chips, the clip-relative scrub');
    assert.ok(fn.includes('_rqPersistOverlays(postId)'), 'still persisting against the wrong id');
    assert.ok(!fn.includes('_rqPersistOverlays(post.id)'), 'post.id is back');
    assert.ok(fn.includes('_rqRenderCanvasOverlays('), 'the picture is not updated');
});


// ── The "when" slider under the canvas ──────────────────────────────────────────────────────────
// Reported as "if I move the slider to the left it jumps to another clip". It did. The panel works
// out which clip the box is on by asking which clip its START second falls in, and that was
// recomputed on every pointermove — so dragging the start handle past the clip's own beginning
// silently re-resolved to the PREVIOUS clip and reinterpreted the whole track against it.

console.log('\nthe per-clip when slider is gone, and its job moved onto the row');

check('the When panel under the canvas no longer exists', () => {
    // Its three parts each had a home already: the chips are the drag onto another clip's row, the
    // scrub is the text bar now that a row shares its clip's axis, and Start/End sit on the row.
    // A second copy of a control is a second place to disagree — and this copy was the one with the
    // clip-jumping bug.
    for (const gone of ['insp-overlay-timing', 'insp-overlay-clips', 'insp-overlay-scrub',
                        'insp-overlay-start', 'insp-overlay-end', '_pceBindOverlayScrub',
                        '_pceRenderOverlayClipUi', '_pceOvtDrag']) {
        assert.strictEqual(workspace.indexOf(gone), -1, `${gone} is back`);
    }
    // But the thing the drag-and-drop calls must survive the cull.
    only(workspace, 'window._pceOverlayToClip = function (index, key) {', 'workspace.html');
});

check('start and end are typed on the row, in the clip\'s own seconds', () => {
    const parts = slice('function _rqTimelineParts(post) {', 'function _pceTimedBlock(inner, axis)');
    assert.ok(parts.includes("data-tl-num=\"${edge}\""), 'the row has no number fields');
    assert.ok(parts.includes('const src = (t) => Math.round((ax.inS + (t - ax.start)) * 10) / 10;'),
        'the fields are not shown in the clip\'s own seconds');
    assert.ok(parts.includes("item.endS == null ? '' : src(end)"),
        'an unset end must read blank, not as the value it happens to have');
    // The clip's own in/out too, beside its slider.
    const trim = slice('function _pceTrimTrackHtml(clip, index) {', '\n/** Write the cut back to the post.');
    assert.ok(trim.includes('data-pce-act="clip-trim"'), 'the clip row has no typed in/out');
});

check('the wording is editable on the row', () => {
    const parts = slice('function _rqTimelineParts(post) {', 'function _pceTimedBlock(inner, axis)');
    assert.ok(parts.includes('data-tl-text='), 'no inline text field');
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    assert.ok(tl.includes("hasAttribute('data-tl-text')"), 'nothing listens to it');
    // ⚠️ Delegated, because the rows are replaced wholesale on every repaint — a listener bound to
    // the input dies with the first redraw, and a control that works once is worse than one that
    // never worked.
    assert.ok(tl.includes("host.addEventListener('input'"), 'the canvas does not keep up as you type');
    assert.ok(tl.includes('_rqRenderCanvasOverlays(post)'), 'the picture is never repainted');
});

console.log('\nthe preview says why it cannot start');

check('every abort path states a reason instead of returning silently', () => {
    // A button that does nothing, with no message, is indistinguishable from a broken button — and
    // the abort runs through _pcePreviewStop, which takes the label back before it has finished
    // changing, so even the flicker is invisible.
    const fn = slice('window._pcePreviewStart = async function () {', '\nwindow._pcePreviewStop');
    assert.ok(fn.includes('not a video player'), 'no message when the canvas has no video element');
    assert.ok(fn.includes('has no playable file'), 'no message when a clip has no url');
    assert.ok(fn.includes('clips.findIndex((c) => !c || !c.url)'),
        'a missing url is still discovered inside the seat, which aborts through _pcePreviewStop');
    const seat = slice('async function _pcePreviewSeat(i) {', '\nwindow._pcePreviewStart');
    assert.ok(seat.includes('_pcePrevMsg ='), 'the seat still fails silently');
    assert.ok(seat.includes("would not start playback"), 'a refused play() is swallowed');
});

check('the reason is rendered where the button is', () => {
    const at = only(workspace, '+ (_pcePrevMsg', 'workspace.html');
    assert.ok(workspace.slice(at, at + 200).includes('_rqEsc(_pcePrevMsg)'), 'the message is not escaped');
});

check('the message is declared before the functions that set it', () => {
    // _pcePreviewSeat sets it and is defined above _pcePreviewStart; a `let` below both would be a
    // ReferenceError the first time a preview failed, which is the worst possible moment.
    assert.ok(only(workspace, "let _pcePrevMsg = '';", 'workspace.html')
        < only(workspace, 'async function _pcePreviewSeat(i) {', 'workspace.html'),
        '_pcePrevMsg is declared after a function that assigns it');
});


// ── One clip, one axis ──────────────────────────────────────────────────────────────────────────
// ⚠️ THE bug behind "the text keeps jumping to another clip", diagnosed by the user: a text bar was
// drawn against the WHOLE CUT while the trim slider directly above it was drawn against that clip's
// own length. Same box, same width, two different scales — in a four-clip cut, clip one's slider
// spanned 10.7s and the text bar under it spanned 36.8s. A nudge that looked like a third of the
// clip was a whole clip's worth of time. Making the two boxes the same WIDTH first made it worse:
// they then looked like one axis while still being two.

console.log('\na text bar is measured in the same seconds as the clip above it');

check('every row carries the axis it is drawn in', () => {
    const parts = slice('function _rqTimelineParts(post) {', 'function _pceTimedBlock(inner, axis)');
    assert.ok(parts.includes('const cutAxis = { full: dur, inS: 0, outS: dur, start: 0 };'),
        'sound has no axis of its own, so one conversion cannot serve both');
    assert.ok(parts.includes('data-ax-full="${ax.full}"'), 'the track does not publish its axis');
    assert.ok(parts.includes('const clipAxis = (i) =>'), 'text rows have no per-clip axis');
});

check("a clip's text axis IS its trim slider's axis", () => {
    // Both must come from _pceTrimAxis, or they can drift apart again without anything failing.
    const parts = slice('function _rqTimelineParts(post) {', 'function _pceTimedBlock(inner, axis)');
    const at = parts.indexOf('const clipAxis = (i) =>');
    const fn = parts.slice(at, parts.indexOf('\n    const textRow', at));
    assert.ok(fn.includes('_pceTrimAxis(clip)'), 'the text axis is derived some other way');
    assert.ok(fn.includes('full: t.len'), 'the text axis does not span the clip source');
    assert.ok(fn.includes('inS') && fn.includes('outS'), 'the kept window is not carried');
    assert.ok(only(workspace, 'function _pceTrimAxis(c) {', 'workspace.html') > 0);
});

check('a sideways drag cannot leave the clip — by arithmetic, not by rule', () => {
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    assert.ok(tl.includes('const ax = d.axis;'), 'the drag still works in the cut axis');
    assert.ok(tl.includes('const lo = ax.start;'), 'no lower bound from the row axis');
    assert.ok(tl.includes('const hi = ax.start + (ax.outS - ax.inS);'), 'no upper bound from the row axis');
    assert.ok(tl.includes('Math.min(ax.outS, Math.max(ax.inS,'), 'the pointer is not clamped into the kept window');
    assert.ok(tl.includes('Math.min(hi - len, d.s0 + delta)'), 'a body drag can still overrun the clip');
    assert.ok(tl.includes('* ax.full'), 'the drag delta is still scaled by the whole cut');
});

check('an unbounded box seeds from its own block, not the whole video', () => {
    // Drawn to the end of its clip; seeded from the cut it would stretch to the whole video the
    // instant it was nudged.
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    assert.ok(tl.includes('a.start + (a.outS - a.inS)'), 'e0 still falls back to the cut duration');
});

check('the playhead is placed in each block\'s own axis, and hidden outside it', () => {
    const fn = slice('function _rqPaintPlayheads(t, dur) {', '\n/**');
    assert.ok(fn.includes("head.style.display = 'none'"), 'the line is drawn even outside the clip');
    assert.ok(fn.includes('(ax.inS + (t - ax.start)) / ax.full'), 'still positioned by a cut percentage');
    // And nothing sets them all to one value any more.
    assert.strictEqual(workspace.indexOf("heads.forEach((h) => { h.style.left = at; })"), -1,
        'a single percentage is being applied to every playhead again');
});

check('the seconds under a text bar are the clip\'s own, matching the slider above', () => {
    const parts = slice('function _rqTimelineParts(post) {', 'function _pceTimedBlock(inner, axis)');
    const at = parts.indexOf('const textRow = (ov, i, axis)');
    const fn = parts.slice(at, parts.indexOf('\n    // Each box belongs', at));
    assert.ok(fn.includes('const src = (t) => ax.inS + (t - ax.start);'),
        'the label is not converted into the clip\'s own seconds');
    assert.ok(fn.includes('of the whole cut'), 'the cut reading is gone — both answers are wanted');
    assert.ok(fn.includes('on to the end of the video'),
        'a box with no end time must say it runs past this clip');
});


// ── Nothing may sit on top of the clip list ─────────────────────────────────────────────────────
// The canvas was made position:sticky so the timeline could scroll under it. Two things went wrong
// at once: the pane is taller than the room it was given, so content scrolled BEHIND it rather than
// under it; and a sticky box with a background and a z-index covers whatever passes below — which
// ate the clicks on Preview, Stop and the clip reorder arrows. Reported as "perhaps there is a
// hidden overlay stopping the click". There was.

console.log('\nthe canvas does not cover the controls');

check('the preview pane is not stuck over the panel below it', () => {
    assert.strictEqual(workspace.indexOf('position:sticky'), -1,
        'a sticky canvas is back — it covers the clip list and eats its clicks');
    const at = only(workspace, 'id="post-review-body"', 'workspace.html');
    const el = workspace.slice(workspace.lastIndexOf('<', at), workspace.indexOf('>', at) + 1);
    assert.ok(!/max-height|z-index/.test(el),
        'the canvas is capped or layered again; seeing both at once is a layout problem, not a scroll trick');
});

check('the clip reorder arrows are still wired', () => {
    only(workspace, 'window._pceClipMove = function (index, dir) {', 'workspace.html');
    const at = only(workspace, "title=\"Move earlier\" aria-label=\"Move clip '", 'workspace.html');
    assert.ok(workspace.slice(at, at + 400).includes('data-pce-act="clip-up"'), 'the up arrow lost its handler');
});

check('the home-screen meta tag is not the deprecated one alone', () => {
    // Chrome warns on the apple- prefix; iOS Safari has never read the unprefixed name. Both, or
    // the app stops opening full screen from an iPhone home screen and nothing says why.
    only(workspace, '<meta name="mobile-web-app-capable" content="yes">', 'workspace.html');
    only(workspace, '<meta name="apple-mobile-web-app-capable" content="yes">', 'workspace.html');
});


// ── The picture and the clip list, side by side ─────────────────────────────────────────────────
// Every control in the clip list changes something you can only judge by looking at the canvas, so
// on a cut the two have to be on screen together. Sticking the canvas to the top of the scroller was
// the wrong answer — it covered the list and ate its clicks. Side by side is the right one, and it
// needs the room: at max-w-4xl, once the rail has taken its 288px, splitting what is left leaves the
// video about 200px wide.

console.log('\nthe stage splits into two columns on a cut');

check('the two columns exist and wrap the right things', () => {
    const row = only(workspace, 'id="pce-stage-row"', 'workspace.html');
    const media = only(workspace, 'id="pce-stage-media"', 'workspace.html');
    const side = only(workspace, 'id="pce-stage-side"', 'workspace.html');
    const canvas = only(workspace, 'id="post-review-body"', 'workspace.html');
    const strip = only(workspace, 'id="pce-stage-strip"', 'workspace.html');
    assert.ok(row < media && media < canvas, 'the canvas is not inside the media column');
    assert.ok(canvas < side && side < strip, 'the clip list is not inside the side column');
});

check('only a video post gets the wide, split stage', () => {
    // A photo has a caption and a picture and nothing with a duration; the extra 256px would be
    // margin, and a dialog that changes size for no gain is just unsettling.
    assert.ok(workspace.includes('_pceSetStageWide(true, _pcePostIsVideo(post));'),
        'the split is not gated on the post being a video');
    const fn = slice('function _pceSetStageWide(wide, sideBySide) {', '/**\n * Put the clip list beside');
    assert.ok(fn.includes("'max-w-6xl'"), 'the wider width is not applied');
    assert.ok(fn.includes("toggle('max-w-4xl', wide && !sideBySide)"),
        'a photo post must keep the narrower stage');
});

check('it stacks again on a narrow window, and never splits below 1024px', () => {
    const fn = slice('function _pceApplyStageSplit() {', "window.addEventListener('resize'");
    assert.ok(fn.includes('window.innerWidth >= _PCE_SPLIT_MIN_PX'), 'no width floor');
    assert.ok(fn.includes("row.style.display = split ? 'flex' : 'block'"), 'the row never goes back to one column');
    assert.ok(workspace.includes("window.addEventListener('resize', () => _pceApplyStageSplit());"),
        'resizing the window does not re-decide the layout');
});

check('the columns are laid out inline, not with utility classes', () => {
    // ⚠️ A layout class that appears nowhere else can be purged out of the compiled stylesheet, and
    // then the columns silently stack with nothing to say why.
    const fn = slice('function _pceApplyStageSplit() {', "window.addEventListener('resize'");
    assert.ok(fn.includes('media.style.flex') && fn.includes('side.style.flex'),
        'the columns are sized by classes that may not exist in the compiled CSS');
});


// ── The text editor's controls, in the post editor ──────────────────────────────────────────────
// Changing a word, a font or a colour meant opening a modal, finding the box among several on
// several clips, changing it there and coming back. The controls now sit under the clip list, beside
// the row that selected them — and they are the SAME controls, not a second set.

console.log('\nthe style controls are shared, not copied');

check('one builder, rendered by both surfaces', () => {
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    for (const fn of ['function textRowHtml(', 'function lookRowsHtml(', 'function animRowsHtml(',
                      'function wireStyleControls(', 'function styleControls(']) {
        assert.notStrictEqual(ioe.indexOf(fn), -1, `${fn} is missing`);
    }
    assert.ok(/window\.ImageOverlayEditor = \{[^}]*\bstyleControls\b[^}]*\};/.test(ioe),
        'the shared controls are not exported');
    // The modal must RENDER FROM them rather than carry its own copy — two control sets is how the
    // font list and the animation list each drifted, silently, in this same file.
    const side = ioe.slice(ioe.indexOf('function renderSide()'), ioe.indexOf('function wireSide('));
    assert.ok(side.includes('${textRowHtml(ov,'), 'the modal writes its own text row');
    assert.ok(side.includes('${lookRowsHtml(ov)}'), 'the modal writes its own style rows');
    assert.ok(!side.includes('<label>Font</label>'), 'a second copy of the font row is back');
    // ⚠️ renderOverlays is ABOVE wireSide in the file, so slicing to it gives an empty string —
    // which passes every content assertion in it. Scan to the end of the function instead.
    const wStart = ioe.indexOf('function wireSide(');
    const wire = ioe.slice(wStart, ioe.indexOf('\n    function ', wStart + 10));
    assert.ok(wire.includes('wireStyleControls(side, ov,'), 'the modal wires its own listeners again');
});

check('the animation list is generated, not hand-copied', () => {
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    assert.ok(ioe.includes('window.OverlayAnims'), 'the editor no longer reads the generated list');
    assert.ok(ioe.includes('OA.OPTIONS.map'), 'it is not built from the generated options');
});

check('exactly one thing handles an animation click', () => {
    // Both the modal and the shared wiring bound [data-anim] for a moment; the two wrote different
    // values ('none' vs undefined) and both repainted.
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    const handlers = ioe.split("querySelectorAll('[data-anim]')").length - 1;
    assert.strictEqual(handlers, 1, `${handlers} handlers bind [data-anim]`);
});

console.log('\nand they are mounted under the clip list');

check('the panel exists, and is mounted rather than written out', () => {
    only(workspace, 'id="pce-text-style"', 'workspace.html');
    const fn = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    // Mounted into `body`, not `host`: the panel now carries a header above the controls naming the
    // box being styled and what is on offer, and mounting over `host` would wipe it.
    assert.ok(fn.includes('window.ImageOverlayEditor.styleControls(body, {'),
        'the post editor builds its own controls instead of mounting the shared ones');
    assert.ok(fn.includes('_pceSuggestOverlayText('), 'the assistant is not offered here');
    assert.ok(fn.includes('video: _pcePostIsVideo(post)'),
        'a still would be offered motion it cannot do');
});

check('it remounts on a change of SELECTION, not on every repaint', () => {
    // ⚠️ The panel holds a textarea and a colour picker. Rebuilding it under the caret loses what is
    // being typed; rebuilding it while the picker is open closes the picker.
    const fn = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    assert.ok(fn.includes('if (_pceStyleMountedFor === ov.id) return;'),
        'the panel is rebuilt on every repaint');
    // ...but editing the wording on the ROW has to invalidate it, or the textarea goes stale.
    const tl = slice('function _rqBindTimeline() {', '\nasync function openPostReview(');
    assert.ok(tl.includes('_pceStyleMountedFor = null;'),
        'editing the row leaves the panel showing the old wording');
});

check('a slider repaints the picture; a commit saves and repaints the list', () => {
    const fn = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    const change = fn.slice(fn.indexOf('onChange:'), fn.indexOf('onCommit:'));
    // ⚠️ With `true`. Without it the call ends by repainting the clip list, which is exactly how the
    // row's own field lost the caret on every letter — the same mistake, one function along.
    assert.ok(change.includes('_rqRenderCanvasOverlays(post, true)'),
        'dragging a slider rebuilds the list under the caret');
    assert.ok(!change.includes('_rqPersistOverlays'), 'a save per pointermove');
    const commit = fn.slice(fn.indexOf('onCommit:'));
    assert.ok(commit.includes('_rqPersistOverlays('), 'nothing is ever saved');
});


// ── Positioning a box, without the modal ────────────────────────────────────────────────────────

console.log('\na box can be dragged on the post editor\'s own canvas');

check('the drag gesture is shared, not written twice', () => {
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    only(ioe, 'function attachPositionDrag(node, ov, getRect, hooks) {', 'image-overlay-editor.js');
    // The modal keeps only what the MODAL does about a grab — moving its stage to that box's clip.
    const modal = ioe.slice(ioe.indexOf('function attachDrag(node, ov) {'),
                            ioe.indexOf('function markSelected('));
    assert.ok(modal.includes('attachPositionDrag(node, ov, stageMetrics'), 'the modal drags its own way');
    assert.ok(!modal.includes('ov.x = clamp('), 'a second copy of the positioning maths');
});

check('a cancelled drag detaches its listeners', () => {
    // ⚠️ The original removed pointermove on pointerup only. A drag the browser cancels — a touch
    // becoming a scroll, the node being removed — left the move listener attached for the life of
    // the node, still writing positions.
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    const fn = ioe.slice(ioe.indexOf('function attachPositionDrag('), ioe.indexOf('// ══ Shared controls'));
    assert.ok(fn.includes("removeEventListener('pointercancel', up)"), 'pointercancel leaks the move listener');
    assert.ok(fn.includes("addEventListener('pointercancel', up)"), 'a cancelled drag never ends');
});

check('a click selects without writing a position', () => {
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    const fn = ioe.slice(ioe.indexOf('function attachPositionDrag('), ioe.indexOf('// ══ Shared controls'));
    assert.ok(fn.includes('hooks.onDrop(ov, moved)'), 'the drop is not told whether anything moved');
    const canvas = slice('function _rqRenderCanvasOverlays(post, canvasOnly) {', '\n/**');
    assert.ok(canvas.includes('if (!moved) return;'), 'a plain click saves a position that did not change');
});

check('the canvas does not repaint under a drag', () => {
    // Third surface, same rule as the clip list and the timeline: repainting replaces the node the
    // pointer is holding, and the drag then writes positions nothing can see.
    const canvas = slice('function _rqRenderCanvasOverlays(post, canvasOnly) {', '\n/**');
    assert.ok(canvas.includes('if (_rqOvDragId && _pcePointerHeld) return;'), 'the layer repaints mid-drag');
    assert.ok(canvas.includes('_rqOvDragId = null;'), 'the guard is never released');
});

check('wireSide does not reach for a helper it no longer declares', () => {
    // ⚠️ Slimming wireSide removed its `const q`, and one caller below it was left behind. The
    // function threw on every render — so the delete button, the box chips and the when-slider were
    // never wired — while the panel still LOOKED complete, because innerHTML was already set.
    // Inspecting the DOM for presence proves nothing about whether the wiring ran.
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    const start = ioe.indexOf('function wireSide(');
    const body = ioe.slice(start, ioe.indexOf('\n    function ', start + 10));
    const usesQ = /[^.\w]q\(/.test(body);
    const declaresQ = /const q = /.test(body);
    assert.ok(!usesQ || declaresQ, 'wireSide calls q() without declaring it');
});


// ── Adding text to one clip ─────────────────────────────────────────────────────────────────────
// Adding a box meant opening the text editor, where a new one landed on whichever clip happened to
// be selected — "put a line on clip three" was two steps and a guess.

console.log('\nevery clip can be given a line of its own');

check('each clip carries its own add button', () => {
    const at = only(workspace, 'data-pce-act="add-text" data-pce-i=', 'workspace.html');
    assert.ok(at > 0);
    const row = workspace.slice(at - 600, at + 200);
    assert.ok(row.includes('tl.isVideo'), 'a photo post would be offered timed text it cannot have');
});

check("⚠️ the button exists on a post with NO text yet", () => {
    // The parts builder returns early when nothing is timed, and the button is drawn from what it
    // returns — so a bare early return meant the FIRST box could never be added. Same dead end
    // "Add another clip" had when it hid itself until there were two clips.
    const parts = slice('function _rqTimelineParts(post) {', 'function _pceTimedBlock(inner, axis)');
    assert.ok(parts.includes('return Object.assign({}, none, { isVideo });'),
        'isVideo does not survive the empty case, so the first line of text is unreachable');
});

check('the defaults come from one factory, shared with the modal', () => {
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    only(ioe, 'function newOverlay(opts) {', 'image-overlay-editor.js');
    assert.ok(ioe.includes('newOverlay };'), 'the factory is not exported');
    // The modal's own + Add text must go through it, or a box added one way looks different from a
    // box added the other.
    const addAt = only(ioe, 'const ov = newOverlay(onSpan', 'image-overlay-editor.js');
    assert.ok(addAt > 0, 'the modal still builds its own overlay');
    assert.strictEqual(ioe.indexOf('{ ...DEFAULTS, id: uid()'), -1, 'a second copy of the defaults');
});

check('a new box is visible immediately, and never longer than its clip', () => {
    const fn = slice('window._pceAddTextToClip = function (index, text) {', '\nwindow._pceClipMove');
    assert.ok(fn.includes('Math.min(_PCE_NEW_TEXT_S, sp.len)'),
        'a three-second default would outlast a two-second clip');
    assert.ok(fn.includes('_pceSelectedOverlayId = ov.id'), 'the new box is not selected');
    assert.ok(fn.includes('_pceStyleMountedFor = null'), 'the style panel stays on the previous box');
    assert.ok(fn.includes('_rqPersistOverlays('), 'the new box is never saved');
    assert.ok(fn.includes('.select()'), 'the placeholder is not selected, so typing appends to it');
});

check('startS of zero is stored as absent', () => {
    // The first second of the video is what "no start" MEANS; writing the default onto the row is
    // noise the renderer then has to ignore.
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    const fn = ioe.slice(ioe.indexOf('function newOverlay(opts) {'), ioe.indexOf('/**\n   * Drag a box'));
    assert.ok(fn.includes('if (opts.startS) ov.startS = opts.startS;'), 'a zero start is written out');
    assert.ok(fn.includes('if (opts.endS != null)'), 'a zero end would be dropped');
});


// ── A still's text, and the end of the modal ────────────────────────────────────────────────────

console.log('\na photo post edits its text in the same place');

check('a still gets a Text list and an add button', () => {
    const scope = slice('function _pceRenderClips(clipsOverride)', '_pceMeasureClips(clips);');
    assert.ok(scope.includes('const photoText ='), 'a photo post has no text list');
    assert.ok(scope.includes('_pcePostHasPicture()'), 'the list is not gated on there being a picture');
    assert.ok(scope.includes('data-pce-act="add-text-still"'), 'no way to add the first box');
    // ⚠️ Rendered into THIS host on purpose: every field in the panel is wired by delegation from
    // #pce-clips-block, so a list built anywhere else looks identical and responds to nothing.
    assert.ok(scope.includes('data-tl-text='), 'the wording is not editable on the row');
    assert.ok(scope.includes('data-pce-act="remove-text"'), 'no way to remove a box');
});

check('a still is offered no timing at all', () => {
    const fn = slice('window._pceAddTextToClip = function (index, text) {', '\nwindow._pceClipMove');
    assert.ok(fn.includes('index == null ? null : _pceSpansFor'),
        'a photo would be handed clip spans it does not have');
});

check('the post editor no longer opens the text modal', () => {
    assert.strictEqual(workspace.indexOf('async function _pceOpenOverlayEditor'), -1, 'the opener is back');
    assert.strictEqual(workspace.indexOf('ImageOverlayEditor.open('), -1, 'the page opens the modal again');
    // ⚠️ The COMPONENT keeps open(): the newsletter designer still uses it, and not using a path is
    // not the same job as deleting it.
    const ioe = readFileSync(join(root, 'src/components/image-overlay-editor.js'), 'utf8');
    assert.ok(/window\.ImageOverlayEditor = \{[^}]*\bopen\b/.test(ioe), 'open() was removed from the component');
    const nl = readFileSync(join(root, 'src/components/newsletter-designer.js'), 'utf8');
    assert.ok(nl.includes('ImageOverlayEditor.open('), 'the newsletter designer lost its editor');
});

check('the bake still has its backdrop', () => {
    // Removing the opener must not take the publish path with it: a photo's text is flattened into
    // a new asset on approval, and that is a different call.
    assert.ok(workspace.includes('ImageOverlayEditor.bake('), 'the bake is gone');
    assert.ok(workspace.includes('const bakeFrom = await _pceCorsCleanImageUrl(base);'),
        'the bake no longer resolves a CORS-clean backdrop');
});


// ── The assistant writes a line for one clip ────────────────────────────────────────────────────

console.log('\nthe assistant can write a line per clip');

check('every clip offers it, and only one runs at a time', () => {
    const at = only(workspace, 'data-pce-act="suggest-text" data-pce-i=', 'workspace.html');
    assert.ok(at > 0, 'no per-clip suggest button');
    const scope = workspace.slice(at - 200, at + 700);
    assert.ok(scope.includes("_pceClipAi.busy === i ? 'Thinking"), 'the pressed button does not say it is working');
    assert.ok(scope.includes("_pceClipAi.busy != null ? ' disabled'"), 'a second request can be started on top of the first');
});

check('a failure creates nothing, and says why under that clip', () => {
    // A box that appears and then sits empty because the call failed is worse than the button
    // appearing to do nothing — now there is rubbish to tidy up.
    const fn = slice('window._pceSuggestTextForClip = async function (index) {', "/** True when the canvas is showing a still");
    const order = fn.indexOf('await _pceSuggestOverlayText') < fn.indexOf('_pceAddTextToClip(index, text)');
    assert.ok(order, 'the box is created before the wording arrives');
    // Through _pceClipSay now, which tags the clip AND writes the banner.
    assert.ok(fn.includes('_pceClipSay(index,'), 'a failure is silent');
    const say = slice('function _pceClipSay(index, msg) {', '\nconst _pceClipAi =');
    assert.ok(say.includes('_pceClipAi.at = index'), 'the message is not tied to the clip it belongs to');
});

check('the request says which beat it is, and what the others already say', () => {
    const fn = slice('function _pceClipBriefFor(index) {', '/**\n * Ask the assistant for a line');
    assert.ok(fn.includes('spans.length < 2'), 'a single clip would be told it is "clip 1 of 1"');
    assert.ok(fn.includes('at.i !== index'), 'the clip\'s own wording would be listed as something to avoid');
    assert.ok(fn.includes('index: index + 1'), 'the brief is zero-based, which reads as an off-by-one to the model');
    // And the panel's own Suggest/Improve asks the same question for the box's clip.
    const style = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    assert.ok(style.includes('_pceClipBriefFor('), 'the panel still asks for a whole-post hook');
});

check('a suggestion lands as the box\'s wording, not as the placeholder', () => {
    const fn = slice('window._pceAddTextToClip = function (index, text) {', '\nwindow._pceClipMove');
    assert.ok(fn.includes('text ? { text } : {}'), 'the suggested wording is dropped');
});


// ── Hiding a clip or a box while you work ───────────────────────────────────────────────────────

console.log('\nhiding is a preview filter, never an edit');

check('nothing about hiding is saved, or survives the post', () => {
    // ⚠️ A hidden flag that persisted would be a way to publish a video missing a clip without ever
    // being told. "Does this line work? let me see it without" is a question about the next ten
    // seconds, not an edit.
    const fn = slice('const _pceHidden = { postId: null', 'const _pcePrev = { on: false');
    assert.ok(fn.includes('_pceHidden.clips.clear()'), 'hiding follows you to the next post');
    assert.ok(!/fetch\(/.test(fn), 'hiding is being sent somewhere');
    const toggle = slice('window._pceToggleHidden = function (kind, id) {', '/** "2 clips and 1 text"');
    assert.ok(!toggle.includes('_rqPersistOverlays'), 'toggling saves the post');
    assert.ok(!toggle.includes('splice('), 'toggling removes something');
    assert.ok(workspace.includes('_pceHiddenReset('), 'the state is never reset on open');
});

check('while anything is hidden, the panel says so and says it standing', () => {
    // A preview quietly missing a clip is a preview of a video that does not exist, and the
    // reviewer approves against what they can see.
    assert.ok(workspace.includes('hidden while you edit \\u2014 the published video still has everything.'),
        'the note is missing or no longer says the published video is intact');
    const sum = slice('function _pceHiddenSummary() {', '/** The next clip the preview should play');
    assert.ok(sum.includes("' clip'") && sum.includes("' text box'"),
        'the note counts without saying what kind of thing is missing');
});

check('the preview skips a hidden clip, and still counts it', () => {
    // ⚠️ The offset must keep counting the skipped clip: a box on a later clip is timed against the
    // real cut, and shifting the clock would show it at a second that does not exist.
    const fn = slice('function _pceNextVisibleClip(from) {', 'const _pcePrev = { on: false');
    assert.ok(fn.includes('!_pceClipHidden(clips[i].id)'), 'the search does not skip hidden clips');
    const tick = slice('function _pcePreviewTick(video) {', '/** Seconds this clip contributes');
    assert.ok(tick.includes('_pceNextVisibleClip(_pcePrev.i + 1)'), 'the preview plays hidden clips anyway');
    const seat = slice('async function _pcePreviewSeat(i) {', '\nwindow._pcePreviewStart');
    assert.ok(seat.includes('_pcePrev.offset += _pceClipLength(clips[k])'),
        'the offset no longer counts every earlier clip, so later text is timed wrong');
});

check('hiding every clip refuses to preview, and says why', () => {
    const fn = slice('window._pcePreviewStart = async function () {', '\nwindow._pcePreviewStop');
    assert.ok(fn.includes('Every clip is hidden'), 'an all-hidden preview fails silently');
    assert.ok(fn.indexOf('const first = _pceNextVisibleClip(0)') < fn.indexOf('_pcePrev.on = true'),
        'the preview turns itself on before finding out there is nothing to play');
});

check('a hidden box is filtered from the canvas, not removed from the post', () => {
    const canvas = slice('function _rqRenderCanvasOverlays(post, canvasOnly) {', '\n/**');
    assert.ok(canvas.includes('overlays.filter((ov) => !_pceTextHidden(ov && ov.id))'),
        'hidden text is still painted');
    assert.ok(canvas.includes('render(layer, shown,'), 'the filtered list is not the one painted');
});

check('hiding the clip that is playing moves on rather than stopping on it', () => {
    const fn = slice('window._pceToggleHidden = function (kind, id) {', '/** "2 clips and 1 text"');
    assert.ok(fn.includes('_pceNextVisibleClip(_pcePrev.i + 1)'),
        'hiding the clip on screen leaves it on screen');
});


// ── Dragging a clip into a new position ─────────────────────────────────────────────────────────

console.log('\nclips can be dragged, and bring their text with them');

check('the drag goes through the same path the arrows do', () => {
    // Which is what makes the text come along for free: _pceClipsChanged re-anchors every box onto
    // its own clip BY ID, so a clip that moves takes its wording and keeps how long it shows.
    const fn = slice('const clipRowEl = (i) =>', '\n    host.addEventListener(\'pointerup\', end);');
    assert.ok(fn.includes('_pceClipsChanged(clips)'), 'the reorder writes the cut some other way');
    assert.ok(fn.includes('clips.splice(from, 1)') && fn.includes('clips.splice(to, 0, moved)'),
        'the reorder is not a move');
    // And the re-anchor it depends on must still match by id rather than position.
    const re = slice('function _pceReanchorOverlays(post, oldSpans, newClips) {', '/** The clip a moment');
    assert.ok(re.includes('sp.clip.id === from.clip.id'),
        'text would follow the POSITION rather than the clip, so a reorder would strand it');
});

check('a grip, not the whole row', () => {
    // The row also holds a trim slider, two number fields, an editable line of text and five
    // buttons. A drag that started anywhere would fight all of them.
    const at = only(workspace, "data-clip-drag=\"' + i + '\"", 'workspace.html');
    assert.ok(at > 0, 'no drag handle');
    const fn = slice('const clipRowEl = (i) =>', '\n    host.addEventListener(\'pointerup\', end);');
    assert.ok(fn.includes("closest('[data-clip-drag]')"), 'the drag starts anywhere in the row');
    // The arrows stay: a list that can ONLY be reordered by dragging cannot be reordered at all
    // without a mouse.
    only(workspace, 'window._pceClipMove = function (index, dir) {', 'workspace.html');
});

check('the list does not repaint under a reorder', () => {
    // Fourth surface with this rule. A repaint replaces the row being dragged, and the drag then
    // reads a rect of zeros.
    const fn = slice('function _pceDragActive() {', '/** Run a repaint that a drag deferred.');
    assert.ok(fn.includes('_pceClipDrag.from != null'), 'a clip drag does not hold off repaints');
});

check('a cancelled drag changes nothing', () => {
    const fn = slice('const endClipDrag = () => {', '    host.addEventListener(\'pointerup\', endClipDrag);');
    assert.ok(fn.includes('if (to == null || to === from)'), 'dropping a clip on itself reorders it');
    assert.ok(fn.includes('_pceFlushClipsRepaint()'), 'a cancelled drag leaves the deferred repaint pending');
});

check('the drag puts back the row\'s own dim, not a blank one', () => {
    // ⚠️ A hidden clip is dimmed too. Clearing the opacity outright after a cancelled drag would
    // leave it looking shown while it is still hidden, until something else repainted the list.
    const fn = slice('const clearClipDrop = () => {', '    host.addEventListener(\'pointerdown\', (ev) => {');
    assert.ok(fn.includes('_pceClipHidden(clip.id)'), 'the hidden dim is cleared by a drag');
});

check('a release that never reaches the panel still ends the drag', () => {
    const fn = slice('const endClipDrag = () => {', '    host.addEventListener(\'pointerup\', end);');
    assert.ok(fn.includes("window.addEventListener('pointerup', endClipDrag)"), 'no window safety net');
    assert.ok(fn.includes("window.addEventListener('pointercancel', endClipDrag)"), 'no cancel safety net');
});


// ── Folding a column away ───────────────────────────────────────────────────────────────────────

console.log('\neither column folds down to its handle');

check('both columns have a handle, and it is the thing that stays', () => {
    // ⚠️ A pane that collapses to NOTHING cannot be brought back, and "where did the timeline go"
    // is a worse problem than the space it was taking. Same rule the clips panel learned when
    // hiding itself left no way to add a second clip.
    const fn = slice('function _pceApplyColumnFold() {', '\nwindow.addEventListener(\'resize\'');
    assert.ok(fn.includes("steps.style.display = shut ? 'none' : ''"), 'the rail folds its handle away too');
    assert.ok(fn.includes("strip.style.display = shut ? 'none' : ''"), 'the side folds its handle away too');
    assert.ok(fn.includes("rail.style.width = shut ? '2rem' : ''"), 'a folded rail takes no less room');
    assert.ok(fn.includes("side.style.width = shut ? '2rem' : '22rem'"), 'a folded side takes no less room');
    // The handle has to say which way it goes.
    assert.ok(fn.includes("btn.title = shut ? 'Show the setup steps'"), 'the rail handle does not change its label');
    assert.ok(fn.includes("btn.title = shut ? 'Show the timeline'"), 'the side handle does not change its label');
});

check('the fold is offered only where there is a column to fold', () => {
    const fn = slice('function _pceApplyColumnFold() {', '\nwindow.addEventListener(\'resize\'');
    assert.ok(fn.includes("const offer = split && !strip.classList.contains('hidden')"),
        'the side handle shows on a stacked layout, where it folds nothing useful');
    // ⚠️ And a column folded while split must not stay folded once the layout stacks — that would
    // hide the timeline with no handle left to bring it back.
    assert.ok(fn.includes('const shut = offer && _pceColumnShut.side'),
        'a folded side survives the layout stacking, stranding the timeline');
});

check('the fold is remembered for the session, and not beyond it', () => {
    // It is a preference about how someone wants to work, so re-folding on every post would be the
    // editor forgetting what it was just told. Stored beyond the tab it would have them open the
    // editor tomorrow with a column missing and no memory of hiding it.
    const decl = slice('const _pceColumnShut = { rail: false, side: false };', 'function _pceSetStageSplit(on) {');
    assert.ok(!/localStorage|sessionStorage/.test(decl), 'the fold is persisted beyond the tab');
    assert.ok(!workspace.includes('_pceColumnShut.rail = false;'), 'opening a post re-folds the rail');
});

check('it does not revive the old two-pane layout', () => {
    // tests/post-editor-single-surface.test.ts keeps that deleted. These names avoid its vocabulary
    // on purpose so that check keeps meaning what it meant.
    // Comments may name them — that is the record of what went and why. Only live code counts.
    for (const gone of ['_pceTogglePane', '_pceApplyPanes', 'pce-left-reopen', 'pce-right-reopen']) {
        const live = workspace.split('\n')
            .filter(l => l.includes(gone) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
        assert.deepStrictEqual(live, [], `${gone} is back as live code`);
    }
    only(workspace, 'window._pceFoldColumn = function (which) {', 'workspace.html');
});


// ── Five things found by using it ───────────────────────────────────────────────────────────────

console.log('\nthe panel cannot be wedged by a drag that never ended');

check('a drag is only a drag while a pointer is held', () => {
    // ⚠️ Three separate drags defer this panel's repaints, and any one left set wedges the list for
    // the rest of the session — at which point "+ Add text" adds and saves a box that never
    // appears, which is indistinguishable from a dead button. Reported exactly that way. Patching
    // each leak as it turned up had already failed twice; the question is asked the other way round
    // now, so a leak cannot wedge anything.
    const fn = slice('function _pceDragActive() {', '/** Run a repaint that a drag deferred.');
    assert.ok(fn.includes('if (!_pcePointerHeld)'), 'the guard still trusts the drag state alone');
    assert.ok(fn.includes('_pceTrimDrag.on = false') && fn.includes('_rqTlDrag = null')
        && fn.includes('_pceClipDrag.from = null'), 'a stale drag is detected but not cleared');
    // And the flag itself must be set from events nothing can swallow.
    assert.ok(workspace.includes("document.addEventListener('pointerdown', () => { _pcePointerHeld = true; }, true)"),
        'the held flag is not set in the capture phase, so a stopPropagation hides it');
    assert.ok(workspace.includes("window.addEventListener('blur', () => { _pcePointerHeld = false; })"),
        'a pointer released over another window would leave it held forever');
});

check('adding text says when it cannot', () => {
    const fn = slice('window._pceAddTextToClip = function (index, text) {', '\nwindow._pceClipMove');
    assert.ok(fn.includes('_pceClipSay(index,'), 'a bail-out is still a bare return');
    assert.ok(fn.includes('did not refresh'),
        'a box added into a list that never repainted still looks like a dead button');
});

console.log('\nthe phantom caret, the handles, and the height');

check('an empty timed block has no playhead', () => {
    // A 1px black line down a block whose only content is "No text on this clip" reads as a stray
    // text caret sitting in the sentence — and it MOVED on reorder, because each block is drawn in
    // its own clip's axis. Reported as "the cursor for each text section seems to move after I drag
    // and drop a clip".
    const fn = slice('function _pceTimedBlock(inner, axis) {', '/** Read the axis a track or block');
    assert.ok(fn.includes("const timed = inner.indexOf('data-tl-row=') !== -1"),
        'the playhead is drawn whether or not there is anything to point at');
    assert.ok(fn.includes('timed\n            ?'), 'the playhead is not gated on there being rows');
});

check('both fold handles sit on the edge nearest the picture', () => {
    // One beside the canvas and one out at the far edge of the window reads as two different
    // controls rather than a matched pair.
    const bar = only(workspace, 'id="pce-side-bar"', 'workspace.html');
    assert.ok(workspace.slice(bar, bar + 120).includes('justify-start'),
        'the timeline handle is back on the far edge');
});

check('the card narrows so the video fits, rather than being cropped', () => {
    // ⚠️ Capping the media letterboxes it inside the host; cropping changes the frame. Either way
    // the overlay layer is inset-0 over the HOST and every box is a FRACTION of that box, so the
    // moment the media stops filling the host exactly, every piece of text drifts away from where
    // it was dragged AND from where Remotion bakes it. Narrowing scales all three together.
    const fn = slice('function _pceFitCanvasToView() {', "\nwindow.addEventListener('resize', () => _pceFitCanvasToView());");
    assert.ok(fn.includes('card.style.maxWidth'), 'something other than the card is being resized');
    assert.ok(!/object-cover|object-contain|clip-path/.test(fn), 'the media is being cropped or letterboxed');
    assert.ok(fn.includes('widthForCap < 448'), 'a landscape clip would be stretched past a post\'s width');
    assert.ok(fn.includes('if (!(natW > 0) || !(natH > 0)) return;'),
        'a media element that has not reported its shape would divide by zero');
    // It has to run before the boxes are measured against the media's height.
    const paint = slice('const paint = () => {', 'const nodes = window.ImageOverlayEditor.render');
    assert.ok(paint.includes('_pceFitCanvasToView()'),
        'the boxes are sized for a frame that is about to change width');
});


// ── The page admits when it breaks ──────────────────────────────────────────────────────────────

console.log('\na script error is not allowed to be invisible');

check('uncaught errors and rejections reach the screen', () => {
    // ⚠️ This editor fails SILENTLY: an exception in a click handler stops that handler and nothing
    // else, so the button looks dead and the only record is a console nobody has open. Three rounds
    // of "this does nothing" have now been spent on code that worked everywhere it could be run.
    only(workspace, 'id="post-review-script-alert"', 'workspace.html');
    const fn = slice('(function _rqReportScriptErrors() {', '\n// ── Post formats');
    assert.ok(fn.includes("window.addEventListener('error'"), 'uncaught errors are still silent');
    assert.ok(fn.includes("window.addEventListener('unhandledrejection'"), 'rejected promises are still silent');
    assert.ok(fn.includes('if (!ev || !ev.message) return;'),
        'a 404 on an image would be reported as a script error');
    assert.ok(fn.includes('seen >= MAX'), 'one error in a repaint loop would fill the page');
});

check('the rail can still add text', () => {
    // ⚠️ Removing "Add or edit text" with the modal left the step called "Text on the video" with
    // nothing to press. Adding lives in the timeline per clip now, but a step that offers no way to
    // do the thing it is named after is a dead end.
    only(workspace, 'window._pceAddTextHere()', 'workspace.html');
    const fn = slice('window._pceAddTextHere = function () {', 'window._pceAddTextToClip = function (index, text) {');
    assert.ok(fn.includes('clips.length ? 0 : null'),
        'a still would be handed a clip index it does not have');
});


console.log('\nand a reason cannot be swallowed by the thing it explains');

check('why-it-did-not-happen reaches the banner, not only the panel', () => {
    // ⚠️ The per-clip message is drawn BY the clip list. When the thing that failed IS the clip
    // list refusing to repaint, the explanation is swallowed by the same fault it is explaining,
    // and the button goes on looking dead. The banner is outside the panel.
    const fn = slice('function _pceClipSay(index, msg) {', '\nconst _pceClipAi =');
    assert.ok(fn.includes("getElementById('post-review-script-alert')"), 'the reason only goes to the panel');
    assert.ok(fn.indexOf('el.classList.remove') < fn.indexOf('_pceRenderClips()'),
        'the banner is written after the repaint that may never happen');
    // The assistant's failures go the same way.
    const ai = slice('window._pceSuggestTextForClip = async function (index) {', '/** True when the canvas is showing a still');
    assert.ok(ai.includes('_pceClipSay(index,'), 'a refused suggestion is still panel-only');
});

check('opening a post shows a busy pointer', () => {
    // It fetches the post, resolves its media and lays out the mock-up; on a cut that is seconds,
    // and the only sign anything was happening was the modal eventually appearing.
    const fn = slice('function _rqSetBusyCursor(on) {', 'async function _rqOpenPostReview(postId, opts = {}) {');
    assert.ok(fn.includes('document.documentElement'), 'a per-element cursor would be overridden');
    assert.ok(fn.includes('finally {'), 'a failed open would leave the page stuck looking busy');
    // The create path starts it before the fetch: its own button is dismissed before the slow half.
    const dest = slice('async function pceConfirmDestinations() {', '\n// Scheduling choice');
    assert.ok(dest.includes('_rqSetBusyCursor(true)'), 'starting a post shows nothing while it works');
    assert.ok(dest.includes('_rqSetBusyCursor(false)'), 'the busy pointer is never cleared');
});


// ── Every button in the panel goes through one listener ─────────────────────────────────────────
// ⚠️ "+ Add text does nothing, and no error appears" survived THREE rounds of fixes to what the
// handlers do — because the handlers were never being reached. The pattern only became visible
// once enough of the panel existed to compare: everything driven by pointer events (trimming,
// dragging a text bar, reordering a clip) worked throughout, and everything driven by an inline
// onclick attribute did not. Delegation is how this panel's text fields and number boxes were
// already bound, on this same element.

console.log('\nthe panel has no inline handlers left');

check('the clip panel builds no onclick attributes', () => {
    const render = slice('function _pceRenderClips(clipsOverride)', '\n/**\n * The style controls for whichever');
    assert.ok(!/onclick=/.test(render), 'the clip list still writes inline handlers');
    const row = slice('const within = sub ?', 'const nameInput = (key, label)');
    assert.ok(!/onclick=/.test(row), 'a text row still writes inline handlers');
    const trimFn = slice('function _pceTrimTrackHtml(clip, index) {', '\n/** Write the cut back to the post.');
    assert.ok(!/onchange=/.test(trimFn), 'the trim numbers still write an inline handler');
});

check('one dispatcher covers every action the panel offers', () => {
    const tl = slice('const PCE_ACTS = {', '\nfunction _pceBindClipTrim() {');
    for (const act of ['add-text', 'add-text-still', 'suggest-text', 'clip-up', 'clip-down',
                       'clip-remove', 'hide-clip', 'hide-text', 'remove-text', 'add-clip',
                       'preview-start', 'preview-stop']) {
        assert.ok(tl.includes(`'${act}'`), `no handler for ${act}`);
    }
    assert.ok(tl.includes("ev.target.closest('[data-pce-act]')"), 'the dispatcher is not delegated');
    assert.ok(tl.includes('el.disabled'), 'a disabled button would still fire');
    // ⚠️ And an exception inside an action must not become another dead button.
    assert.ok(tl.includes('catch (err)') && tl.includes('_pceClipSay('),
        'a throwing action fails silently, which is the same bug by another route');
});

check('every action the markup emits has a handler, and vice versa', () => {
    // A typo in either direction is a button that renders and does nothing — the exact failure
    // this change exists to end.
    const emitted = new Set(Array.from(workspace.matchAll(/data-pce-act="([a-z-]+)"/g), m => m[1]));
    // clip-trim is a change handler, not a click action.
    emitted.delete('clip-trim');
    const tl = slice('const PCE_ACTS = {', '\nfunction _pceBindClipTrim() {');
    const handled = new Set(Array.from(tl.matchAll(/^\s*'([a-z-]+)':/gm), m => m[1]));
    for (const a of emitted) assert.ok(handled.has(a), `${a} is emitted but has no handler`);
    for (const a of handled) {
        // preview-start/stop are emitted through a ternary rather than literal attributes.
        if (a === 'preview-stop' || a === 'preview-start') continue;
        assert.ok(emitted.has(a), `${a} is handled but never emitted`);
    }
});


console.log('\nthe click diagnostic is opt-in and only watches');

check('?pcedebug does nothing unless it is asked for', () => {
    const fn = slice('(function _pceClickDiagnostics() {', '\n// ── Post formats');
    assert.ok(fn.includes("get('pcedebug') === '1'"), 'the flag is not read');
    assert.ok(fn.includes("location.hash.indexOf('pcedebug')"),
        'a query parameter alone does not survive this page rewriting its own URL');
    assert.ok(fn.includes('if (!on) return;'), 'the diagnostic runs for everyone');
    // It must not change behaviour — capture phase, no preventDefault, no stopPropagation.
    assert.ok(!/preventDefault|stopPropagation/.test(fn), 'the diagnostic interferes with the click');
    assert.ok(fn.includes('n >= MAX'), 'a running commentary would fill the banner');
    // Bound directly when the document is already parsed: this script runs at the end of the body.
    assert.ok(fn.includes("document.readyState === 'loading'"),
        'waiting for DOMContentLoaded here would wait forever');
});


console.log('\nthe panel binds from the path that renders it');

check("the buttons do not depend on the canvas having painted", () => {
    // ⚠️ THE BUG. The dispatcher was bound by _rqBindTimeline, which is called from exactly one
    // place — inside _rqRenderCanvasOverlays, AFTER two early returns: no overlay layer on the
    // mock-up, or a box mid-drag on the canvas. Take either and the panel still renders and its
    // POINTER handlers still bind (trimming works, dragging a clip works) while its CLICK handler
    // never attaches. Buttons that render and do nothing, with no error anywhere.
    // ⚠️ AND THEN it was bound by _pceBindClipTrim, which is latched on the panel element's own
    // dataset and reached only once that element exists — with the latch set BEFORE the work, so one
    // throw in the binder killed the panel for the rest of the page's life. Three homes, three
    // versions of "the buttons do nothing", all the same shape: aliveness that depended on timing.
    // It now lives on `document`, bound at load by an IIFE, depending on nothing.
    const once = slice('(function _pceBindPanelActionsOnce() {', '\n})();');
    for (const ev of ['pointerdown', 'pointerup', 'click', 'change']) {
        assert.ok(once.includes(`document.addEventListener('${ev}'`),
            `${ev} is bound to something that can be missing, replaced or unreached`);
    }
    assert.ok(!once.includes('host.addEventListener'),
        'the dispatcher still binds to the panel, so it needs the panel to exist first');
    // Capture on every one: a handler between the button and the document can stop a bubbling
    // event, and there is no auditing every one of those from here.
    assert.strictEqual(once.split(', true);').length - 1, 4,
        'a listener bubbles, so anything in the panel can still swallow it before it arrives');
    const trim = slice('function _pceBindClipTrim() {', '\nfunction _pceBindClipTrimOn(host) {');
    assert.ok(trim.indexOf('_pceBindClipTrimOn(host)') < trim.indexOf("dataset.trimBound = '1'"),
        'the latch is set before the work again, so one throw disables the drags permanently');
    const panels = slice('function _pceRenderStagePanels() {', '\nfunction _pceRenderLayers()');
    assert.ok(panels.includes('_pceBindClipTrim'), 'the panel binder is not called on render');
    assert.ok(panels.includes('_rqBindTimeline'),
        'dragging a text bar still depends on the canvas path having painted');
    // ⚠️ And binding must come BEFORE rendering. _pceRenderClips writes the panel's innerHTML and
    // then keeps working; anything that throws after that write leaves the buttons on screen with
    // every binder below it unreached — a panel that looks complete and responds to nothing.
    assert.ok(panels.indexOf("step('bindClipTrim'") < panels.indexOf("step('renderClips'"),
        'rendering runs before binding again, so a throw mid-render disables the panel');
    assert.ok(panels.includes('catch (err)'), 'one panel failing can still take the others down');
});

check('a canvas drag cannot wedge the layer, or the binders behind it', () => {
    // Same leak class as _pceDragActive, on the surface I had not applied it to — and this one
    // takes _rqBindTimeline down with it, because that call sits below the guard.
    const canvas = slice('function _rqRenderCanvasOverlays(post, canvasOnly) {', '\n/**');
    assert.ok(canvas.includes('if (_rqOvDragId && _pcePointerHeld) return;'),
        'a leaked canvas drag still stops the layer repainting for good');
    assert.ok(canvas.includes('if (_rqOvDragId) _rqOvDragId = null;'), 'the stale drag is never cleared');
});


console.log('\na failure message has to be somewhere it can be read');

check('failures toast, they do not only fill a banner', () => {
    // ⚠️ The banner sits at the TOP of the modal's scroller, and the clip list is what you scroll
    // DOWN to reach. Every explanation added over several rounds rendered faithfully, above the top
    // of the viewport, where it could never be read — and "no banner appears" was reported three
    // times before I worked out it was true and mine.
    const say = slice('function _pceClipSay(index, msg) {', '\nconst _pceClipAi =');
    assert.ok(say.includes('window.showToast?.('), 'a reason still only goes where nobody is looking');
    const step = slice('function _pceRenderStagePanels() {', '\nfunction _pceRenderLayers()');
    assert.ok(step.includes('window.showToast?.('), 'a failed panel step is still silent on screen');
    const err = slice('(function _pceClickDiagnostics() {', '\n// ── Post formats');
    assert.ok(err.includes('window.showToast?.('), 'the diagnostic cannot be read without scrolling');
});

check('an upstream AI failure is not dressed up as "try again"', () => {
    const fn = readFileSync(join(root, 'netlify/functions/suggest-overlay-text.ts'), 'utf8');
    const tail = fn.slice(fn.indexOf("console.error('[suggest-overlay-text] error:'"));
    assert.ok(/credit balance\|quota\|billing/.test(tail), 'an exhausted balance is not recognised');
    assert.ok(tail.includes('this is at our end, not yours'),
        'the writer is still told to retry a failure that will never clear');
    assert.ok(tail.includes('json(503'), 'an upstream outage is still reported as a generic failure');
});


console.log('\nthe buttons answer to a pointer, like everything else that works here');

check('pointerup drives them too, not click alone', () => {
    // ⚠️ Evidence, not caution: in the session where these are dead, the DRAGS in this same panel
    // work — trim, text bar, clip grip — and those are pointerdown/move/up on this exact element.
    // Pointer events reach this container and carry the right target; `click` specifically does
    // not. The buttons should not be the only controls here depending on the one mechanism that
    // has never worked.
    const fn = slice('(function _pceBindPanelActionsOnce() {', '\n})();');
    assert.ok(fn.includes("document.addEventListener('pointerup'"), 'the buttons still need a click');
    // Click is KEPT: a keyboard Enter fires click and no pointer event at all.
    assert.ok(fn.includes("document.addEventListener('click', fire, true)"),
        'dropping click trades a mouse problem for a keyboard one');
    assert.ok(fn.includes('now - lastAt < 400'), 'one press would run the action twice');
});

check('a drag that ends over a button does not press it', () => {
    // Releasing a clip you were reordering on top of "+ Add text" would otherwise add text.
    const fn = slice('(function _pceBindPanelActionsOnce() {', '\n})();');
    assert.ok(fn.includes("closest('[data-pce-act]')) || under(ev);"), 'the press start is not recorded');
    // ⚠️ Resolved the SAME way at both ends. A covered button records a press of `null` and is then
    // rejected on release for not matching itself — the fallback would work on click and never on
    // pointerup, which is the half-working version of this bug.
    assert.strictEqual(fn.split('|| under(ev)').length - 1, 2,
        'press and release resolve the control differently');
    assert.ok(fn.includes("if (ev.type === 'pointerup' && pressedEl !== el) return;"),
        'a release anywhere fires whatever it lands on');
});

console.log('\nstyling opens because you asked, not because something got selected');

check('an intent opens it, and a selection does not', () => {
    // ⚠️ It keyed off `_pceSelectedOverlayId`, which nothing ever cleared — and selection is a side
    // effect of half the things you can do here: grabbing a box on the canvas, dragging a text bar,
    // adding text. So once any text had been touched, Wording / How it looks / How it appears stayed
    // open for the session, including the moment you pressed Stop, which merely repaints.
    const fn = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    assert.ok(fn.includes('_pceTextEditing ? overlays.find('),
        'the panel still opens for whatever happens to be selected');
    assert.ok(!fn.includes('_pceSelectedOverlayId ? overlays.find('), 'the old selection key is back');
    // A deleted box cannot go on being edited.
    assert.ok(fn.includes('if (!ov) _pceTextEditing = null;'), 'a removed box leaves the intent set');
});

check('watching the cut closes it; adding text opens it', () => {
    const start = slice('window._pcePreviewStart = async function () {', '\nwindow._pcePreviewStop');
    assert.ok(start.includes('_pceCloseTextLook()'), 'previewing leaves the styling open over the video');
    const stop = slice('window._pcePreviewStop = function () {', '\nfunction _pcePreviewTick(video) {');
    assert.ok(stop.includes('_pceCloseTextLook()'), 'pressing Stop still opens the styling panel');
    // The one moment the offer is certainly wanted — and how the Aa button gets noticed.
    const add = slice('window._pceAddTextToClip = function (index, text) {', '\nwindow._pceClipMove = function (index, dir) {');
    assert.ok(add.includes('_pceTextEditing = ov.id;'), 'a box you just made does not open its styling');
});

check('every text row has a door to it, and says what is behind it', () => {
    // Without this the feature would have no way in at all, now that a selection no longer opens it.
    assert.ok(workspace.includes("data-pce-act=\"style-text\""), 'no row offers styling');
    assert.ok(workspace.includes('title="Emojis, font, colour, size and animation"'),
        'the button does not say what it does, which is the question being asked');
    // The panel names the box it is styling and what is on offer; "Wording / How it looks / How it
    // appears" describe themselves only once you are already reading them.
    const fn = slice('function _pceRenderTextStyle() {', '\n// ── The crop frame');
    assert.ok(fn.includes('Emojis, font, colour, size and how it animates in.'),
        'the panel opens without saying what it can do');
    assert.ok(fn.includes("data-pce-act=\"close-text-look\""), 'there is no way to close it');
    // A toggle, because the button reads as one.
    const acts = slice('const PCE_ACTS = {', '\n};');
    assert.ok(acts.includes("'style-text'") && acts.includes("'close-text-look'"),
        'the new controls have no handler');
    assert.ok(acts.includes('window._pceEditingTextId() === key ? null : key'),
        'pressing Aa twice does not close what it opened');
});

console.log('\nthe caret survives, and so do the text rows');

check('typing paints the picture without rebuilding the row it is typed in', () => {
    // ⚠️ _rqRenderCanvasOverlays does two jobs, and a keystroke only wants the first — it ends by
    // repainting the clip list. The input handler called it under a comment reading "the picture keeps
    // up; the list waits for the caret", which described the intent and not the call. Every letter
    // rebuilt the field being typed in: "I can add text but only one letter at a time".
    const canvas = slice('function _rqRenderCanvasOverlays(post, canvasOnly) {', '\n/**');
    assert.ok(canvas.includes('if (canvasOnly) return;'), 'there is no canvas-only paint to ask for');
    assert.ok(canvas.indexOf('if (canvasOnly) return;') < canvas.indexOf('_pceRenderClips()'),
        'the canvas-only path still repaints the list');
    const input = workspace.slice(workspace.indexOf("host.addEventListener('input', (ev) => {"));
    const body = input.slice(0, input.indexOf('});'));
    assert.ok(body.includes("data-tl-text"), 'that is not the text field\'s input handler any more');
    assert.ok(body.includes('_rqRenderCanvasOverlays(post, true)'),
        'a keystroke still triggers a full repaint');
});

check('a repaint under the caret puts it back', () => {
    // A belt for those braces: the list holds a text field and two number boxes per row and is
    // repainted by eleven callers. One of them repainting while a field has focus is a matter of time,
    // and it reads as the field rejecting input rather than as a repaint.
    const memo = slice('function _pceFocusMemo() {', '\nfunction _pceFocusRestore(m) {');
    // Re-found by IDENTIFYING ATTRIBUTE, never by node identity — the node is gone by then.
    for (const a of ['data-tl-text', 'data-tl-num', 'data-pce-act']) {
        assert.ok(memo.includes(`'${a}'`), `${a} fields lose the caret on a repaint`);
    }
    const outer = slice('function _pceRenderClips(clipsOverride) {', '\nlet _pceRenderingClips = false;');
    assert.ok(outer.includes('const focus = _pceFocusMemo();'), 'nothing remembers where the caret was');
    assert.ok(outer.includes('_pceFocusRestore(focus)'), 'nothing puts it back');
    assert.ok(outer.indexOf('_pceFocusRestore(focus)') > outer.indexOf('_pceRenderingClips = false;'),
        'the restore runs before the render is marked finished');
    const restore = slice('function _pceFocusRestore(m) {', '\nfunction _pceRenderClipsInner(');
    assert.ok(restore.includes('m.memo.selectionStart'),
        'the selection is read off the new node, which has not got one yet');
    assert.ok(restore.includes('preventScroll: true'), 'restoring focus scrolls the modal');
});

check('the text rows come from the post, not from what is painted', () => {
    // ⚠️ `isVideo` read only the canvas — "is there a video element in the preview right now" — and
    // previewing the cut swaps that element's source clip by clip. A repaint mid-swap saw no video, so
    // overlays came back EMPTY: "when I watch the whole video, it then hides any text layers".
    const parts = slice('function _rqTimelineParts(post) {', '\n/**');
    assert.ok(parts.includes('_pcePostIsVideo(post) ||'),
        'the panel still decides a post is not a video because the picture moved');
    assert.ok(parts.includes("const overlays = isVideo ?"), 'the overlay source changed shape');
    // ⚠️ The other half, and the reason it was still broken after the first fix: this branch measures
    // the <video> on the canvas, and previewing points that element at ONE CLIP at a time. Mid-preview
    // it has no duration, so every row was thrown away — and `none` sets isVideo false, which took
    // every "+ Add text" button with it.
    assert.ok(parts.includes('if (isVideo && !(cutLen > 0) && !_rqVideoDurationKnown())'),
        'a busy canvas still empties the panel');
    assert.ok(parts.includes('return Object.assign({}, none, { isVideo, any: true,'),
        'the bail-out still reports a video post as not a video');
});

console.log('\na render cannot land inside another render');

check('the panel refuses to repaint while it is already repainting', () => {
    // ⚠️ THE BUG, and the browser named it:
    //   NotFoundError: Failed to set the 'innerHTML' property on 'Element':
    //   The node to be removed is no longer a child of this node.
    // innerHTML removes the old children one at a time, and removing a node dispatches events. A
    // handler that renders this panel again runs inside that loop, replaces the children, and the
    // outer write then reaches for a node that has gone — so the write dies half-done and everything
    // after it (unhiding, the playheads, the style panel) never runs.
    const outer = slice('function _pceRenderClips(clipsOverride) {', '\nlet _pceRenderingClips = false;');
    assert.ok(outer.includes('if (_pceRenderingClips) { _pceClipsRepaintPending = true; return; }'),
        'a render can still begin inside another one');
    assert.ok(outer.includes('finally {'), 'a throw mid-render leaves the flag set and the panel frozen');
    assert.ok(/requestAnimationFrame\(\(\) => \{ try \{ _pceRenderClips\(\)/.test(outer),
        'the collided repaint is dropped, or runs nested on the same stack');
    // The deferred run must not fire under a pointer either — that is the older guard beside it.
    assert.ok(outer.includes('if (_pceClipsRepaintPending && !_pceDragActive())'),
        'a deferred repaint can still tear the node out from under a drag');
});

check('a measurement repaints on the next frame, not on its own stack', () => {
    // _pceMeasureClips is called BY the render, so a clip that fails fast fires its error handler
    // while the panel's innerHTML write is still running. That is how the nesting happened.
    const soon = slice('function _pceRepaintClipsSoon() {', '\nfunction _pceMeasureClips(clips) {');
    assert.ok(soon.includes('requestAnimationFrame('), 'the repaint still runs on the caller\'s stack');
    assert.ok(soon.includes('if (_pceRepaintSoonQueued) return;'),
        'four failing clips queue four repaints of the same list');
});

console.log('\nthe panel says when it cannot be clicked');

check('a covered button is still pressed, through the stack at that point', () => {
    // Capture on document guarantees the handler RUNS; it cannot fix ev.target. With something over
    // the panel the target is that something, and closest() walks up its ancestry and never reaches
    // the button. elementsFromPoint returns the whole stack, so the press can be honoured anyway.
    const fn = slice('(function _pceBindPanelActionsOnce() {', '\n})();');
    assert.ok(fn.includes('document.elementsFromPoint(ev.clientX, ev.clientY)'),
        'a covered control is still silently dropped');
    assert.ok(fn.includes('!host.contains(hit)'), 'it would press a control outside the panel');
    // Gated on the panel's rect: a stray click anywhere else must not cost a stack walk.
    assert.ok(fn.includes('ev.clientX < box.left || ev.clientX > box.right'),
        'every click on the page pays for this');
    assert.ok(fn.includes("if (what !== coverSaid)"), 'the coverer is named on every click, not once');
});

check('it hit-tests its own first button and names whatever is in front', () => {
    // ⚠️ Four wrong diagnoses in, the decisive report was that the DevTools element picker would not
    // land on these buttons either. A click that never arrives can be a hundred things; a picker
    // that cannot reach an element is one of two, and both are answerable from the page itself
    // rather than guessed at from here. So the panel asks, on the machine that has the bug.
    const fn = slice('function _pceCheckPanelReachable() {', '\nfunction _pceClipSay(');
    assert.ok(fn.includes('document.elementFromPoint('), 'the panel still cannot tell if it is covered');
    assert.ok(fn.includes('btn.contains(at) || at.contains(btn)'),
        'a hit on the button\'s own icon or label would be reported as a blocker');
    assert.ok(fn.includes('if (!(r.width > 0) || !(r.height > 0)) return;'),
        'an unlaid-out panel reports a phantom blocker');
    assert.ok(fn.includes('if (what === _pceCoverWarned) return;'),
        'one cause would toast on every repaint');
    assert.ok(fn.includes('window.showToast'), 'the finding goes only where nobody is looking');
    // ⚠️ Both of these were flaws in the first version, and it duly reported "blocked by null" on a
    // healthy panel: it hit-tested clip 1's "move earlier", which is disabled by definition, at a
    // point below the fold, where elementFromPoint returns null for anything at all.
    assert.ok(fn.includes("'[data-pce-act]:not([disabled])'"),
        'it still hit-tests a disabled control, which proves nothing');
    assert.ok(fn.includes('x > (window.innerWidth || 0) || y > (window.innerHeight || 0)'),
        'a button below the fold is still reported as blocked');
    // ⚠️ And the second false positive: the point was inside the viewport but scrolled up UNDER the
    // modal's sticky header, so the hit-test found the header and the check called it a blocker.
    // Every ancestor that clips has to agree the point is inside it.
    assert.ok(fn.includes('for (let a = btn.parentElement; a; a = a.parentElement)'),
        'a button scrolled under the modal header is still reported as covered');
    assert.ok(fn.includes("st.overflow === 'visible' && st.overflowX === 'visible'"),
        'a non-clipping ancestor is treated as if it clipped');
    // It has to run AFTER layout — a rect read in the same tick as the innerHTML write is the rect
    // the panel had before it changed.
    const render = slice('function _pceRenderClipsInner(host, clipsOverride) {', '\n/**');
    assert.ok(/requestAnimationFrame\(\(\) => \{ try \{ _pceCheckPanelReachable\(\)/.test(render),
        'the check runs inside the render, against a stale rect, or not at all');
});

console.log(`\n${passed} checks passed`);
