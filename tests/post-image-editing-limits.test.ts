// tests/post-image-editing-limits.test.ts
//
// The two things that stopped a customer editing an Instagram post on 2026-09-02, both reported as
// "it worked before". Neither was a regression — both were long-standing and only met the right
// picture: a 4284×5712, 6,400,655-byte phone photo.
//
//   1. "Your Instagram post needs an image" — on a post that plainly had one. The approve gate
//      tested `thumbnailUrl`, which is not "is anything attached" but "did we manage to presign a
//      preview". get-social-drafts resolves that inside `catch { /* ignore */ }`, so one failed
//      presign turned into an accusation the reviewer could not act on, while the canvas beside it
//      carried on showing the picture.
//   2. "Image is too large to edit in the browser" — get-post-image 413'd anything over 4 MB,
//      because base64 inflates ~33% against Netlify's response cap. That is a real ceiling for the
//      inline path, but it was being reported as a dead end rather than routed around.
//
// NOT COVERED: a live browser, real CORS headers on the media bucket, and the presign itself.
// These pin the contract between the two sides.
//
// Run:  npx tsx tests/post-image-editing-limits.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const WS     = readFileSync(new URL('../workspace.html', import.meta.url), 'utf8');
const DRAFTS = readFileSync(new URL('../netlify/functions/get-social-drafts.ts', import.meta.url), 'utf8');
const IMG    = readFileSync(new URL('../netlify/functions/get-post-image.ts', import.meta.url), 'utf8');

/** A marker that is missing (-1) or duplicated silently tests the wrong slice of the file. */
function at(hay: string, needle: string, label: string): number {
    const i = hay.indexOf(needle);
    assert.notEqual(i, -1, `marker not found (${label}): ${needle}`);
    assert.equal(hay.indexOf(needle, i + 1), -1, `marker is not unique (${label}): ${needle}`);
    return i;
}

// ── 1. "Needs an image" ─────────────────────────────────────────────────────────────────────────

check('the server sends whether media is ATTACHED, not just whether a preview resolved', () => {
    at(DRAFTS, 'hasMedia: Array.isArray(contentAssetIds) && contentAssetIds.length > 0,', 'drafts');
});

check('hasMedia is derived from the id list, never from thumbnailUrl', () => {
    // Deriving it from the resolved URL would reintroduce the exact bug: the preview and the
    // attachment are different facts with different failure modes.
    const i = at(DRAFTS, 'hasMedia:', 'drafts');
    const line = DRAFTS.slice(i, DRAFTS.indexOf('\n', i));
    assert.ok(!line.includes('thumbnailUrl'), 'hasMedia must not be computed from thumbnailUrl');
});

check('the approve gate tests hasMedia', () => {
    at(WS, 'const igNoImg = targets.filter(t => t.platform === \'instagram\' && !_igHasImage(t));', 'workspace');
    at(WS, 'const _igHasImage = t => (t.hasMedia !== undefined ? t.hasMedia : !!t.thumbnailUrl);', 'workspace');
});

check('a post cached before this deploy is not blocked by a field it cannot have', () => {
    // `hasMedia === undefined` must fall back, not read as false — otherwise the first load after a
    // deploy refuses every Instagram post in the cache.
    const igHasImage = (t: any) => (t.hasMedia !== undefined ? t.hasMedia : !!t.thumbnailUrl);
    assert.equal(igHasImage({ thumbnailUrl: 'https://x/y.jpg' }), true,  'old cached row with a preview');
    assert.equal(igHasImage({ thumbnailUrl: null }),              false, 'old cached row with nothing');
    assert.equal(igHasImage({ hasMedia: true, thumbnailUrl: null }), true, 'attached but preview failed → allowed');
    assert.equal(igHasImage({ hasMedia: false, thumbnailUrl: 'https://x/y.jpg' }), false, 'hasMedia wins when present');
});

check('an unpreviewable image warns instead of blocking', () => {
    // approve-post re-resolves media server-side and is the real gate, so refusing here would be a
    // second opinion with less information than the first.
    at(WS, 'We could not load a preview of this image, so check it before it goes out.', 'workspace');
});

// ── 2. The 4 MB ceiling ─────────────────────────────────────────────────────────────────────────

check('an oversized image is no longer a dead end', () => {
    assert.ok(!IMG.includes('statusCode: 413'), 'get-post-image still refuses large images outright');
    at(IMG, "inlineSkipped: 'too_large'", 'get-post-image');
});

check('the direct URL rides along even when the image DID inline', () => {
    // Two call sites return a body; both must carry directUrl, or the fast path exists only for
    // the images that least need it.
    const bodies = IMG.split('directUrl: image.url').length - 1;
    assert.equal(bodies, 2, `expected directUrl on both response paths, found ${bodies}`);
});

check('the client proves CORS-cleanliness by loading, not by baking and catching', () => {
    const i = at(WS, 'async function _pceCorsCleanImageUrl(base) {', 'workspace');
    const body = WS.slice(i, i + 900);
    assert.ok(body.includes("img.crossOrigin = 'anonymous';"), 'the direct branch must set crossOrigin');
    assert.ok(body.includes('img.onerror'), 'a blocked load must fall back, not throw');
    assert.ok(body.includes('base.dataUrl'), 'the inline path must remain the fallback');
});

check('BOTH editor paths resolve the backdrop the same way', () => {
    // The bake path is the one that matters most: an image the editor opened but approval could not
    // bake would fail at the last step, after the reviewer had done the work.
    at(WS, 'let backdrop = base.isVideo ? null : await _pceCorsCleanImageUrl(base);', 'workspace');
    at(WS, 'const bakeFrom = await _pceCorsCleanImageUrl(base);', 'workspace');
    assert.ok(!WS.includes('ImageOverlayEditor.bake(base.dataUrl'), 'the bake path still uses the capped inline URL');
});

check('the refusal, when it comes, names the size and a way out', () => {
    const i = at(WS, 'function _pceNoBackdropMessage(base) {', 'workspace');
    const body = WS.slice(i, i + 600);
    assert.ok(body.includes('1048576'), 'the message should state the real size in MB');
    assert.ok(/under 4 MB/.test(body), 'the message should say what would work');
});

console.log(`\n${passed} passed\n`);
