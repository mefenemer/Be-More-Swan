// tests/music-ingest.test.ts
// Getting a licensed pack into the library — and, more importantly, refusing to.
//
// The library exists so that every bed under a customer's commercial post has paperwork behind it.
// That makes this script's real job the refusals, not the upload: a row whose licence we cannot state
// is precisely the thing owning the library was meant to prevent, and it would look identical in the
// picker to a track we can prove we own.
//
// Source-text checks, because the script uploads to R2 and writes to a database. What is asserted is
// the ORDER of operations and the refusals — the two things that would be silently wrong.
//
// Run:  npx tsx tests/music-ingest.test.ts

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
const src = readFileSync(join(root, 'scripts/ingest-music-tracks.ts'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

console.log('\nit will not record a track it cannot state the licence for');

check('a missing licence name is a refusal, not a default', () => {
    // ⚠️ The one rule the whole library is for. Defaulting here would write a row that looks exactly
    // like a track we can prove we own.
    assert.ok(src.includes("if (!lic.name) { problems.push"), 'a nameless licence is accepted');
    assert.ok(!/licenceName: .*\|\| ['"]/.test(src), 'a licence name falls back to a placeholder');
});

check('a licence demanding a credit must supply the wording', () => {
    // Recording attributionRequired with no text would produce a track that must be credited and
    // cannot say how — the caller would have to invent the wording, which is the one thing nobody
    // may do with a legal string.
    assert.ok(src.includes('lic.attributionRequired && !lic.attributionText'),
        'a track can require a credit it has no wording for');
});

check('the licence is stated once for the pack, and a track may override it', () => {
    // A per-track licence field on every row invites it being filled in from memory; a pack is bought
    // under one licence. The override exists for a pack that genuinely mixes terms.
    assert.ok(src.includes('{ ...(packLicence || {}), ...(t.licence || {}) }'),
        'the pack licence and the track override are not merged in that order');
});

console.log('\nlength is read, never transcribed');

check('the duration comes from the FILE, not the manifest', () => {
    // ⚠️ The one number that must be exact: the editor draws a bed's bar against it and the renderer
    // sequences against the real audio, so a value a second out means the reviewer times text against
    // a length the renderer does not share. Sixty typed by hand would be wrong somewhere, silently.
    assert.ok(src.includes('mm.parseFile(abs)'), 'the length is no longer measured from the file');
    assert.ok(src.includes('if (!(durationS > 0))'), 'a file reporting no length is accepted');
    // ⚠️ Asserted on the manifest's TYPE, not on the insert. The first version of this checked that
    // no `durationS: t.duration…` appeared anywhere and failed on `durationS: t.durationS` in the
    // insert — where `t` is the validated record whose duration came from the parser. The guarantee
    // worth having is that a manifest cannot state a duration at all.
    const manifestType = src.slice(landmark(src, 'interface ManifestTrack {'),
                                   landmark(src, '/** Host + database of the connection'));
    assert.ok(!/duration/i.test(manifestType), 'a manifest track can declare its own length');
});

check('the parser is a devDependency — it must never reach a function', () => {
    // ESM-only packages crash Netlify functions (ERR_REQUIRE_ESM). This one is only ever loaded by a
    // script run under tsx, so it belongs in devDependencies and nowhere else.
    assert.ok(pkg.devDependencies?.['music-metadata'], 'music-metadata is not a devDependency');
    assert.ok(!pkg.dependencies?.['music-metadata'], 'music-metadata is a runtime dependency');
});

console.log('\nnothing is half-ingested');

check('every track is validated and measured BEFORE anything is uploaded', () => {
    // A half-ingested pack is the worst outcome: some rows in, some objects in R2 with no row, and no
    // way to tell which without listing the bucket.
    assert.ok(landmark(src, 'if (problems.length) {') < landmark(src, "await import('../db/client')"),
        'the database is opened before the pack has been checked');
    assert.ok(landmark(src, 'if (!apply) {') < landmark(src, 'await uploadObject('),
        'the upload happens before the dry-run check');
});

check('the object is uploaded BEFORE its row is written', () => {
    // ⚠️ This order, not the other. A row pointing at bytes that are not there renders silence and
    // looks like a working track; an object with no row is invisible and harmless.
    assert.ok(landmark(src, 'await uploadObject(t.storageKey') < landmark(src, 'db.insert(musicTracks)'),
        'a row can be written for an object that was never uploaded');
});

check('a re-run cannot duplicate a track', () => {
    // Content-addressed keys plus the unique index turn a second ingest of the same pack into a
    // no-op rather than a second copy of every bed under a different name.
    assert.ok(src.includes("createHash('sha256')"), 'the key is not derived from the content');
    assert.ok(src.includes('onConflictDoNothing()'), 'a duplicate row throws instead of being ignored');
});

console.log('\nthe usual protections');

check('dry run by default, and the target is announced', () => {
    assert.ok(src.includes("args.includes('--apply')"), 'it writes without being asked');
    assert.ok(src.includes('describeTarget'), 'it does not say which database it will write to');
    assert.ok(src.includes("flag('url-var') ?? 'NETLIFY_DATABASE_URL'"), 'the target cannot be chosen');
    assert.ok(/never a connection string/.test(src), 'the --url-var convention is not stated where it is read');
});

check('only formats the renderer can play are accepted', () => {
    const allowed = src.slice(landmark(src, 'const ALLOWED'), landmark(src, 'interface ManifestLicence'));
    for (const ext of ['.mp3', '.wav', '.m4a']) {
        assert.ok(allowed.includes(`'${ext}'`), `${ext} is not accepted`);
    }
    assert.ok(src.includes('is not a format the renderer plays'), 'an unplayable file is ingested silently');
});

check('library objects are NOT written under an org prefix', () => {
    // One object, licensed once, referenced by every workspace through its own content_assets row.
    // persistBufferToR2 writes to content/org-{id}/…, which would copy the bytes per tenant.
    assert.ok(src.includes("LIBRARY_PREFIX = 'library/music'"), 'the shared prefix is gone');
    assert.ok(!src.includes('persistBufferToR2('), 'library bytes are being written per organisation');
});

console.log(`\n${passed} checks passed.\n`);
