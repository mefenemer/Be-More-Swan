// tests/music-picker.test.ts
// The Sound layer's music picker, and the endpoint behind it.
//
// The picker's job is to make a licensed bed as easy to add as a voice note. Its RISK is different
// from a voice note's: a track offered here that we may not use produces a post which publishes
// perfectly and breaches a licence on the customer's account. Nothing about that shows up in a
// preview or a render, so the withholding has to be provable.
//
// Source-text checks, because the endpoint needs a session and a database and the picker needs a
// browser. What is asserted is where the decisions are made and in what order.
//
// Run:  npx tsx tests/music-picker.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(import.meta.dirname, '..');
const fn = readFileSync(join(root, 'netlify/functions/music-library.ts'), 'utf8');
const ws = readFileSync(join(root, 'workspace.html'), 'utf8');

console.log('\nthe endpoint withholds what we may not offer');

check('the licence rules come from the shared module, not a second WHERE clause', () => {
    // A SQL filter duplicating expiry and attribution would be a second answer to "may we offer
    // this", and the two would drift. The rules are pure and tested; this reads them.
    assert.ok(fn.includes('usableTracks(') && fn.includes('offerableTo('),
        'the endpoint decides offerability on its own');
    assert.ok(fn.includes("from '../../src/lib/music-library'"), 'the shared rules are not imported');
});

check('a track demanding a credit is NOT offered while nothing can surface one', () => {
    // ⚠️ Not offered with a warning — not offered. Unlike a Pexels credit, which this product offers
    // as a courtesy, a licence that demands attribution is a condition of use.
    // ⚠️ CODE only. The first version counted every occurrence and found three — the third being the
    // comment that explains the rule. A source scan reads prose as happily as it reads calls, and a
    // count is the check most easily fooled by its own documentation.
    const code = fn.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.strictEqual(code.split('creditsEnabled: false').length - 1, 2,
        'the credits rule is applied in only one of list and select');
});

check('offerability is re-checked at SELECT, not trusted from the list', () => {
    // ⚠️ The picker's list may be minutes old. A licence that lapsed, or a track withdrawn, between
    // the page loading and the click must not be attachable because it was on screen.
    const sel = fn.slice(landmark(fn, 'async function select('), fn.length);
    assert.ok(sel.includes('usableTracks([track], new Date())'), 'select trusts the list it was given');
    assert.ok(sel.includes('json(409'), 'a withdrawn track is attached rather than refused');
    assert.ok(landmark(fn, 'const [ok] = offerableTo') < landmark(fn, 'db.insert(contentAssets)'),
        'the asset row is created before offerability is checked');
});

console.log('\none object, one row per workspace');

check('the workspace gets its own content_assets row pointing at the shared object', () => {
    // audio_overlays point at content_assets.id and resolveAudioTracks scopes those rows to the
    // organisation — a hard tenant check, because the renderer runs with full R2 credentials and no
    // tenant context. The row is the workspace's permission to reference the object.
    assert.ok(fn.includes('storageKey: track.storageKey'), 'the bytes are copied per workspace');
    assert.ok(fn.includes("assetType: 'audio'"), 'the asset is not typed as audio');
    assert.ok(fn.includes('organisationId,'), 'the asset row is not scoped to a workspace');
});

check('picking the same track twice does not make two rows', () => {
    // Four posts using one bed would otherwise be four rows pointing at one object, and deleting any
    // of them would look like it should remove the file.
    assert.ok(fn.includes('eq(contentAssets.providerAssetId, String(track.id))'),
        'there is no find-before-create on the provider id');
    assert.ok(landmark(fn, 'const [existing]') < landmark(fn, 'db.insert(contentAssets)'),
        'it inserts before looking for an existing row');
});

check('a caller must name a post in its own workspace', () => {
    const sel = fn.slice(landmark(fn, 'async function select('), fn.length);
    assert.ok(sel.includes('eq(scheduledPosts.organisationId, organisationId)'),
        'a post id from another workspace would be accepted');
});

console.log('\nthe picker');

check('its handlers are bound to document, once, at load', () => {
    // ⚠️ The lesson from the clip panel, which had three homes for its buttons and failed the same
    // way each time: a binder reached from a render path is one an early return can skip, and the
    // symptom is a control that draws perfectly and does nothing.
    const once = ws.slice(landmark(ws, '(function _pceBindMusicOnce() {'), landmark(ws, 'async function _pceOpenMusicLibrary()'));
    assert.ok(once.includes("document.addEventListener('click'"), 'the picker binds to something that can be missing');
    assert.ok(!once.includes('host.addEventListener'), 'it binds to the panel, so it needs the panel to exist');
    assert.ok(once.includes(', true);'), 'the listener bubbles, so anything in the panel can swallow it');
});

check('a track with no preview is still offered', () => {
    // ⚠️ A failed presign loses the audition, not the right to use the bed. Hiding it would make a
    // workspace's own licensed music vanish because a signature could not be minted.
    assert.ok(fn.includes('.catch(() => null)'), 'a failed presign takes the track down with it');
    assert.ok(ws.includes('Preview unavailable'), 'the picker has no state for a track it cannot play');
});

check('auditioning one track stops the other', () => {
    const prev = ws.slice(landmark(ws, 'function _pceToggleMusicPreview(id) {'), landmark(ws, 'function _pceStopMusicPreview()'));
    assert.ok(prev.includes('_pceStopMusicPreview();'), 'two beds can play at once, which tells you nothing about either');
    // One element per track, kept — a fresh Audio() per press re-downloads the file every listen.
    assert.ok(prev.includes('_pceMusicPreviewEls[key]'), 'every press re-downloads the track');
});

check('adding a track ends exactly where an upload ends', () => {
    // Same clip shape, same selection, same measure, same save — so a library bed times, fades,
    // previews and renders through code that knows nothing about the library.
    const add = ws.slice(landmark(ws, 'async function _pceAddLibraryTrack(trackId) {'), landmark(ws, 'async function _pceRemoveAudio(index)'));
    for (const step of ['post.audio.push(clip)', '_pceMeasureAudio(post)', '_pceRefreshAudioInspector()', '_pcePersistAudio(postId)']) {
        assert.ok(add.includes(step), `the library path skips ${step}`);
    }
    assert.ok(add.includes('post.audio.length >= 10'), 'the ten-clip ceiling is not enforced on this path');
});

console.log(`\n${passed} checks passed.\n`);
