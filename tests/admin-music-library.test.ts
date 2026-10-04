// tests/admin-music-library.test.ts
// Admin → Music Library: the screen that can take a track out of what every workspace is offered.
//
// Pinned here: it only ever WITHDRAWS (never deletes — a post that already carries a track must keep
// it), a withdrawal needs a reason and is audit-logged, it is admin-gated, and the creator of a
// community track is visible to admins without that ever reaching the library customers browse.
//
// Run:  npx tsx tests/admin-music-library.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackKind, jobIdFrom, cleanTags } from '../netlify/functions/admin-music-library';
import { COMMUNITY_MUSIC_PREFIX } from '../src/lib/music-library';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const fn = read('netlify/functions/admin-music-library.ts');
const admin = read('admin.html');
const libraryFn = read('netlify/functions/music-library.ts');

console.log('\nthe helpers');

check('a track is community or curated by WHERE its file lives', () => {
    assert.strictEqual(trackKind(`${COMMUNITY_MUSIC_PREFIX}/abc.mp3`), 'community');
    assert.strictEqual(trackKind('library/music/0f3c.mp3'), 'curated');
    // A look-alike prefix must not pass.
    assert.strictEqual(trackKind('library/music/community-pack.mp3'), 'curated');
});

check('the job id comes only from the exact provenance form', () => {
    assert.strictEqual(jobIdFrom('media_generation_jobs:482'), 482);
    assert.strictEqual(jobIdFrom('invoice 12345'), null);
    assert.strictEqual(jobIdFrom('media_generation_jobs:12; drop'), null);
    assert.strictEqual(jobIdFrom(null), null);
});

check('tags are cleaned into the vocabulary the picker filters on', () => {
    assert.deepStrictEqual(cleanTags(' Chill , LO-FI, chill,,  '), ['chill', 'lo-fi']);
    assert.deepStrictEqual(cleanTags(['Upbeat', 'upbeat ', 'Fast']), ['upbeat', 'fast']);
    assert.strictEqual(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 12);
});

console.log('\nwhat it may and may not do');

check('it never deletes — a withdrawal only stops a track being offered', () => {
    assert.ok(!/db\.delete\(/.test(fn), 'a row is deleted');
    assert.ok(!/DeleteObject/.test(fn), 'a file is deleted');
    assert.ok(fn.includes('set({ isActive, updatedAt: new Date() })'));
    // ...and "not offered" is real: the customer-facing library honours is_active on BOTH paths.
    assert.ok(libraryFn.includes('usableTracks('), 'the picker ignores withdrawal');
});

check('a withdrawal needs a reason, and every change is audit-logged', () => {
    assert.ok(fn.includes("if (!isActive && !reason) return json(400"), 'a withdrawal without a why');
    assert.ok((fn.match(/audit\(/g) || []).length >= 2, 'a change goes unrecorded');
    assert.ok(fn.includes("action: 'music_library_curation'"));
    assert.ok(read('src/utils/admin-audit.ts').includes("| 'music_library_curation'"));
});

check('only an admin with platform_config can see or change it', () => {
    assert.ok(fn.includes("hasPermission(row?.role, 'platform_config')"));
    const handler = fn.slice(fn.indexOf('export default withLambda'));
    assert.ok(handler.indexOf('requireAdmin(event)') < handler.indexOf("event.httpMethod === 'GET'"), 'the list is readable before the check');
});

check('a community track\'s creator is shown to admins — and not to the library', () => {
    assert.ok(fn.includes('creator: jobId != null ?'), 'admins cannot see who shared it');
    // The customer-facing list must not grow a creator or prompt field.
    assert.ok(!/creator|prompt|organisationId:\s*j/.test(libraryFn.slice(libraryFn.indexOf('const out = await Promise.all'), libraryFn.indexOf("return json(200, { tracks: out"))),
        'the public library leaks who made a track or what they asked for');
});

console.log('\nthe screen');

check('the view is reachable: nav entry, label, loader and markup', () => {
    assert.ok(admin.includes("{ view: 'music-library',"), 'no nav entry');
    assert.ok(admin.includes("'music-library': 'Music Library'"), 'no page title');
    assert.ok(admin.includes("if (view === 'music-library')       loadMusicLibrary();"), 'never loads');
    assert.ok(admin.includes('<section id="view-music-library" class="admin-view hidden'));
});

check('withdrawing asks first, in the house dialog, and says posts keep the track', () => {
    const w = admin.slice(admin.indexOf('async function mlWithdraw(id) {'), admin.indexOf('async function mlRestore(id) {'));
    assert.ok(w.includes('window.promptModal('), 'no question asked');
    assert.ok(!/\bconfirm\(|\bprompt\(/.test(w.replace(/promptModal\(/g, '')), 'the browser\'s own dialog');
    assert.ok(w.includes('their posts keep it'));
});

check('buttons are coloured by intent', () => {
    const r = admin.slice(admin.indexOf('function _mlRender('), admin.indexOf('function mlTogglePlay('));
    assert.ok(r.includes('btn-destructive') && r.includes('btn-primary') && r.includes('btn-secondary'));
});

console.log(`\n${passed} checks passed`);
