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
import { mayRun } from '../netlify/functions/content-retention';

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

// ── 1b. …and it has to actually run ─────────────────────────────────────────────────────────────
// The original file's header said "every 6 hours". netlify.toml listed no schedule for it, so it had
// never run once — which is the real reason no asset had ever been purged, and why its other bugs
// stayed invisible. A docstring is not a cron.
check('content-retention is actually scheduled', () => {
    const toml = read('netlify.toml');
    assert.ok(/\[functions\.content-retention\]/.test(toml),
        'netlify.toml has no [functions.content-retention] block — the reclaimer will never run and post media will never be reclaimed, however correct the code is');

    // It must run after archive-cleanup, which is what releases the media it reclaims.
    const scheduleAfter = (fn: string) => {
        const m = toml.match(new RegExp(`\\[functions\\.${fn}\\]\\s*\\n\\s*schedule = "([^"]+)"`));
        assert.ok(m, `expected a schedule for ${fn}`);
        const hour = m![1].split(' ')[1];
        assert.ok(/^\d+$/.test(hour), `${fn} schedule "${m![1]}" is not a plain daily hour — re-check the ordering by hand`);
        return Number(hour);
    };
    assert.ok(scheduleAfter('content-retention') > scheduleAfter('archive-cleanup'),
        'content-retention must run after archive-cleanup on the same day: archive-cleanup releases a departing post\'s media, and content-retention reclaims the bytes');
});

// ── 1c. …and not by just anyone ─────────────────────────────────────────────────────────────────
// The job deletes R2 objects, and every Netlify function is routable by name — a scheduled one
// included — so publishing the schedule publishes the URL. The guard therefore has an unusual shape:
// fail-OPEN for the scheduler, fail-CLOSED for everyone else. Refusing an unauthenticated manual
// call costs an attacker some time; refusing the SCHEDULER would silently switch off the only thing
// that reclaims post media, which is the bug this file exists to have fixed.
check('the retention job refuses manual callers but never blocks its own schedule', () => {
    const src = readCode('netlify/functions/content-retention.ts');
    assert.match(src, /function mayRun\(/, 'the destructive entry point needs a guard');
    assert.match(src, /CRON_TRIGGER_SECRET/, 'manual runs must present the shared cron secret');

    // The scheduler must still get through even with no secret configured — otherwise adding this
    // guard would quietly disable retention on any deploy that has not set the variable yet.
    assert.match(src, /if \(raw == null \|\| raw === ''\) scheduled = true/,
        'an empty body must count as a scheduled tick, or the guard can disable the cron it protects');
    assert.match(src, /next_run/, "Netlify's scheduled invocation marker is what identifies the cron");

    // And the pass has to stay callable from the guarded HTTP trigger.
    assert.match(src, /export const runContentRetention/,
        'the logic must be exported so run-content-retention can drive it on staging');
});

// Run the guard, don't just read it. The assertions above prove the code says the right words; these
// prove it behaves. A guard is the one place where the difference matters.
check('the guard admits the scheduler and turns everyone else away', () => {
    const saved = process.env.CRON_TRIGGER_SECRET;
    try {
        const sched = (body: unknown) => ({ headers: {}, body });
        const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` }, body: '{}' });

        process.env.CRON_TRIGGER_SECRET = 's3cret';

        // The scheduler, in both shapes the runtime has used.
        assert.equal(mayRun(sched(JSON.stringify({ next_run: '2026-08-01T05:00:00Z' }))).ok, true,
            "Netlify's scheduled tick must always be allowed");
        assert.equal(mayRun(sched(null)).ok, true, 'an empty body is a scheduled tick too');
        assert.equal(mayRun(sched('')).ok, true, 'an empty string body is a scheduled tick too');

        // A human with the secret.
        assert.equal(mayRun(bearer('s3cret')).ok, true, 'the right token runs the job');

        // Everyone else.
        const bad = mayRun(bearer('wrong')) as { ok: false; status: number };
        assert.equal(bad.ok, false, 'a wrong token must not run a destructive job');
        assert.equal(bad.status, 401);

        const anon = mayRun({ headers: {}, body: '{"hello":"world"}' }) as { ok: false; status: number };
        assert.equal(anon.ok, false, 'a POST with a body that is not a scheduled tick is not the scheduler');
        assert.equal(anon.status, 401);

        // With no secret configured the scheduler must STILL run — this is the property that stops
        // the guard disabling retention on a deploy that has not set the variable.
        delete process.env.CRON_TRIGGER_SECRET;
        assert.equal(mayRun(sched(null)).ok, true, 'no secret configured must never stop the cron');
        const manual = mayRun({ headers: {}, body: '{"hello":"world"}' }) as { ok: false; status: number };
        assert.equal(manual.ok, false, 'manual runs stay closed when no secret is configured');
        assert.equal(manual.status, 403, '403 distinguishes "not configured" from "wrong token"');
        assert.equal((mayRun(bearer('anything')) as { ok: false }).ok, false,
            'a token cannot authorise anything while no secret is configured');
    } finally {
        if (saved === undefined) delete process.env.CRON_TRIGGER_SECRET;
        else process.env.CRON_TRIGGER_SECRET = saved;
    }
});

check('the manual trigger is closed by default', () => {
    const src = readCode('netlify/functions/run-content-retention.ts');
    // Fail closed: an unconfigured deploy must refuse, not run. 503 (not 401) so a probe can tell
    // "not configured" from "wrong token" — see the deploy-probe note in the project memory.
    assert.match(src, /if \(!secret\)[\s\S]{0,200}statusCode: 503/,
        'without CRON_TRIGGER_SECRET this endpoint must disable itself rather than run open');
    assert.match(src, /token !== secret[\s\S]{0,80}401/, 'a bad token is a 401');
    assert.match(src, /httpMethod !== 'POST'/, 'a destructive trigger should not be reachable by GET');
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

// The two assertions above name their files by hand, which is how set-post-platforms.ts went unnoticed:
// it deletes cross-post siblings when the user unticks a platform, and released nothing. Shared media
// survived (the other siblings still reference it), but save-post-overlays bakes its flattened image
// as a NEW asset attached to that ONE post, so those bytes leaked. Enumerate the paths instead.
check('EVERY function that deletes scheduled_posts releases media', () => {
    const dir = path.join(ROOT, 'netlify/functions');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ts'))) {
        const code = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!/db\s*\.\s*delete\s*\(\s*scheduledPosts\s*\)|DELETE\s+FROM\s+scheduled_posts/i.test(code)) continue;
        // Either helper is acceptable: releasePostMedia for a post that is simply going away,
        // collectPostAssetIds + releaseAssets when replacement rows carry the same media.
        if (!/releasePostMedia|releaseAssets/.test(code)) offenders.push(`netlify/functions/${f}`);
    }
    assert.deepStrictEqual(offenders, [],
        `these delete posts without releasing their media — every R2 object held only by a deleted post leaks permanently: ${offenders.join(', ')}`);
});

// The ordering trap that makes the asset-scoped variant necessary at all. set-post-platforms deletes
// some siblings and CREATES others copying the anchor's contentAssetIds; a release taken before those
// additions exist would see shared assets as unreferenced and start a 7-day purge clock on media a
// live post is about to use. Collect before the delete, release after the adds.
check('set-post-platforms releases after it re-attaches, not before', () => {
    const src = stripComments(read('netlify/functions/set-post-platforms.ts'));
    const collect = src.indexOf('collectPostAssetIds');
    const destroy = src.search(/db\s*\.\s*delete\s*\(\s*scheduledPosts\s*\)/);
    const reattach = src.lastIndexOf('scheduledPostAssets)\n');
    const release = src.indexOf('releaseAssets(db');
    assert.ok(collect !== -1 && destroy !== -1 && release !== -1,
        'expected a collect, a post delete and a release in set-post-platforms');
    assert.ok(collect < destroy,
        'collectPostAssetIds must run BEFORE the delete — scheduled_post_assets goes with the post, taking the only record of its media');
    assert.ok(release > destroy && (reattach === -1 || release > reattach),
        'releaseAssets must run AFTER the new siblings are inserted, or shared media gets a purge clock while a live post still uses it');
});

// releaseAssets takes an exclusion list that is empty at the set-post-platforms call site. Empty must
// mean "exclude nothing", not `NOT IN ()` — which is a syntax error that would fail the release.
check('an empty exclusion list does not become NOT IN ()', () => {
    const src = stripComments(read('src/utils/release-post-media.ts'));
    const notInUses = src.match(/NOT IN \(\$\{idList/g)?.length ?? 0;
    const guards = src.match(/excludePostIds\.length/g)?.length ?? 0;
    assert.ok(notInUses > 0 && guards >= notInUses,
        `every NOT IN (${'${idList…}'}) fragment must be guarded by an excludePostIds.length check — found ${notInUses} fragment(s) and ${guards} guard(s)`);
    assert.ok(/excludePostIds:\s*number\[\]\s*=\s*\[\]/.test(src),
        'releaseAssets should default its exclusion list to empty for post-delete callers');
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
