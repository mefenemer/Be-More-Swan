// tests/post-media-retention.test.ts
// Media attached to a post must eventually be reclaimed from R2 — and nothing else must be.
//
// Run:  npx tsx tests/post-media-retention.test.ts
//
// Three bugs lived here at once, all silent, all in code that looked plausible:
//
//   1. content-retention.ts deleted from AWS S3 (S3_BUCKET_NAME / AWS_ACCESS_KEY_ID). Nothing else
//      in this codebase uses those variables — every storage path is Cloudflare R2 — so the physical
//      delete early-returned on every run for as long as the file existed.
//   2. It stamped purgedAt and nulled storageKey ANYWAY. The row then claimed the bytes were gone
//      while the R2 object remained, and since the key was the only record of where that object
//      lived, it became permanently unreclaimable. Every 6 hours, on every asset reaching retention.
//   3. archive-cleanup.ts and reject-post.ts "released" media by soft-deleting `workspace_assets`
//      using `content_assets` ids, filtered on asset_type='social_image'. Two tables, two independent
//      id sequences. It reclaimed nothing — and on an id collision it soft-deleted a real, unrelated
//      workspace upload instead. (asset_type DOES hold 'social_image'; storage-request-upload.ts
//      writes it from the client. The trap was never that the filter couldn't match.)
//
// What makes these worth a test rather than a comment: every one of them fails by doing nothing
// observable. No throw, no log, no user-visible symptom — just storage growing and, in case 3, the
// occasional unexplained missing image. Static assertions are the only cheap alarm.

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Strips comments before matching. Every one of these files documents the bug it used to have, by
 * name — asserting against raw source would flag the explanation as the offence.
 */
const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const readCode = (rel: string) => stripComments(read(rel));

console.log('\nPost media retention\n');

// ── 1. The reclaimer must point at the storage this app actually uses ───────────────────────────
check('content-retention deletes from R2, not from an unconfigured S3', () => {
    const src = readCode('netlify/functions/content-retention.ts');

    for (const dead of ['S3_BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_REGION']) {
        assert.ok(!src.includes(dead),
            `content-retention.ts reads ${dead}, which nothing in this app sets — the physical delete will silently do nothing. Use the R2_* variables every other storage path uses.`);
    }
    assert.ok(src.includes('R2_BUCKET_NAME') && src.includes('R2_ENDPOINT'),
        'content-retention.ts must delete from R2 (R2_ENDPOINT + R2_BUCKET_NAME)');
});

// A cheap proxy for "the whole app agrees on one object store": the env var every other storage
// path uses. If a second bucket variable appears, someone has introduced a second backend and this
// file's assumptions need re-checking.
check('R2 is the only object store any storage path targets', () => {
    const fnDir = path.join(ROOT, 'netlify/functions');
    const offenders = fs.readdirSync(fnDir)
        .filter(f => f.endsWith('.ts'))
        .filter(f => /S3_BUCKET_NAME|process\.env\.AWS_ACCESS_KEY_ID/.test(stripComments(fs.readFileSync(path.join(fnDir, f), 'utf8'))));
    assert.deepStrictEqual(offenders, [],
        `these target AWS S3 rather than R2, so their storage operations are no-ops: ${offenders.join(', ')}`);
});

// ── 2. purgedAt means the bytes are gone ────────────────────────────────────────────────────────
check('purgedAt is only stamped on a confirmed physical delete', () => {
    const src = readCode('netlify/functions/content-retention.ts');

    // The ids handed to the purge UPDATE must come from the filtered set, never straight from the
    // due list. This is the exact line that made the old version destructive.
    assert.ok(/const ids = purgeable\.map/.test(src),
        'the purge UPDATE must be driven by the confirmed-deleted subset (`purgeable`), not by every asset that was due');
    assert.ok(!/const ids = due\.map/.test(src),
        'content-retention stamps purgedAt on every DUE asset again — an asset whose R2 object survived will lose its storageKey and become unreclaimable');

    // And the subset must actually be derived from the delete result.
    assert.ok(/deletedKeys\.has\(/.test(src),
        'purgeable must be computed from the set of keys R2 confirmed deleted');

    // An unconfigured/failed delete must defer, not succeed by omission.
    assert.ok(/return deleted;/.test(src) && /R2 not configured/.test(src),
        'when R2 is unconfigured the delete helper must return no confirmed keys so the assets retry next run');
});

// ── 3. The two id spaces must never be mixed ────────────────────────────────────────────────────
// content_assets.id and workspace_assets.id are independent sequences. A query that takes ids from
// one and filters the other is wrong however its other conditions are written, and the failure mode
// is either silence or the deletion of an unrelated row.
check('no file uses content_assets ids against workspace_assets', () => {
    const dirs = ['netlify/functions', 'src/utils'];
    const offenders: string[] = [];
    for (const dir of dirs) {
        const abs = path.join(ROOT, dir);
        for (const f of fs.readdirSync(abs).filter(n => n.endsWith('.ts'))) {
            const code = stripComments(fs.readFileSync(path.join(abs, f), 'utf8'));
            if (/workspaceAssets/.test(code) && /contentAssetIds?/.test(code)) {
                offenders.push(`${dir}/${f}`);
            }
        }
    }
    assert.deepStrictEqual(offenders, [],
        `these mix content_assets ids with workspace_assets queries — independent id sequences, so this either does nothing or hits an unrelated asset: ${offenders.join(', ')}`);
});

// ── 4. A departing post must hand its media over ────────────────────────────────────────────────
check('every path that destroys posts releases their media first', () => {
    const src = read('netlify/functions/archive-cleanup.ts');
    assert.ok(src.includes('releasePostMedia'),
        'archive-cleanup hard-deletes posts but no longer releases their media — the R2 objects leak');

    // Ordering is load-bearing: scheduled_post_assets cascades on post delete, so after the delete
    // there is no way left to discover which assets the posts held.
    const release = src.indexOf('releasePostMedia(db');
    const destroy = src.indexOf('db.delete(scheduledPosts)');
    assert.ok(release !== -1 && destroy !== -1, 'expected both the release call and the post delete');
    assert.ok(release < destroy,
        'releasePostMedia must run BEFORE the posts are deleted — scheduled_post_assets cascades away with them, taking the only record of which assets to reclaim');

    assert.ok(read('netlify/functions/reject-post.ts').includes('releasePostMedia'),
        'reject-post no longer releases the rejected post\'s media');
});

// ── 5. Shared media must survive ────────────────────────────────────────────────────────────────
// reject-post creates a revised clone carrying the SAME contentAssetIds, and cross-post siblings
// share one picture across platforms. Releasing on a per-post basis without checking for surviving
// references would pull media out from under work the user still has.
check('release skips assets a surviving post still references', () => {
    const src = read('src/utils/release-post-media.ts');
    assert.ok(/stillUsed/.test(src),
        'releasePostMedia must exclude assets other posts still reference (the revised clone and cross-post siblings share media)');
    assert.ok(/scheduledPostAssets/.test(src) && /content_asset_ids/.test(src),
        'the surviving-reference check must consult BOTH scheduled_post_assets and the deprecated content_asset_ids column, or the oldest assets leak');
    assert.ok(/isNull\(contentAssets\.purgedAt\)/.test(src),
        'already-purged assets must not have their retention clock restarted');
});

console.log(`\n${passed} passed${total - passed ? `, ${total - passed} failed` : ''}\n`);
