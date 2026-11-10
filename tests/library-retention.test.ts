// tests/library-retention.test.ts
// My Content (owner, 2026-11-10): back in the side menu; a storage bar; Keep on any file, which no
// deletion clock overrides; and a week's notice before anything is deleted, with a list to review.
// src/utils/library-retention.ts holds the rules; content-assets.ts, content-retention.ts and
// release-post-media.ts read them.
//
// Run:  npx tsx tests/library-retention.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DELETION_NOTICE_DAYS, canKeep, deletesAt, isSafetyRejected, warnExpiringFiles } from '../src/utils/library-retention';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-10T04:00:00Z');

async function main() {
    console.log('\nThe deletion date');
    await check('never sooner than a week after the notice, or after now when not yet told', () => {
        const overdue = new Date(NOW.getTime() - 3 * DAY);
        assert.strictEqual(deletesAt({ status: 'posted' }, overdue, NOW)!.toISOString(), new Date(NOW.getTime() + 7 * DAY).toISOString());
        const told = new Date(NOW.getTime() - 2 * DAY);
        assert.strictEqual(deletesAt({ status: 'posted', deletionWarnedAt: told }, overdue, NOW)!.toISOString(), new Date(told.getTime() + 7 * DAY).toISOString());
        const later = new Date(NOW.getTime() + 20 * DAY);
        assert.strictEqual(deletesAt({ status: 'posted' }, later, NOW)!.toISOString(), later.toISOString());
        assert.strictEqual(DELETION_NOTICE_DAYS, 7);
    });
    await check('kept, purged or on no clock → never deleted', () => {
        assert.strictEqual(deletesAt({ status: 'posted', libraryKeptAt: NOW }, NOW, NOW), null);
        assert.strictEqual(deletesAt({ status: 'posted', purgedAt: NOW }, NOW, NOW), null);
        assert.strictEqual(deletesAt({ status: 'pending' }, null, NOW), null);
    });
    await check('a safety-refused upload keeps its own date, gets no Keep and no notice', () => {
        const r = { status: 'rejected', rejectionReason: 'Violates Safety Guidelines.' };
        assert.ok(isSafetyRejected(r) && !canKeep(r));
        assert.strictEqual(deletesAt(r, NOW, NOW)!.toISOString(), NOW.toISOString());
        assert.ok(canKeep({ status: 'rejected' }), 'a rejected POST’s media can still be kept');
        assert.ok(canKeep({ status: 'posted' }) && !canKeep({ status: 'posted', libraryKeptAt: NOW }));
    });

    console.log('\nThe notice');
    await check('one notice per owner, files stamped, safety-refused left out', async () => {
        const rows = [
            { id: 1, userId: 7, status: 'posted', rejectionReason: null, retentionDeleteAfter: new Date(NOW.getTime() + 2 * DAY) },
            { id: 2, userId: 7, status: 'posted', rejectionReason: null, retentionDeleteAfter: new Date(NOW.getTime() + 5 * DAY) },
            { id: 3, userId: 8, status: 'rejected', rejectionReason: 'Violates Safety Guidelines.', retentionDeleteAfter: NOW },
        ];
        const updates: unknown[] = [];
        const inserts: Array<Record<string, any>> = [];
        const db: any = {
            select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
            update: () => ({ set: (v: unknown) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
            insert: () => ({ values: (v: Record<string, any>) => { inserts.push(v); return Promise.resolve(); } }),
        };
        const n = await warnExpiringFiles(db, NOW);
        assert.strictEqual(n, 2);
        assert.strictEqual(updates.length, 1, 'one stamp for user 7 only');
        assert.strictEqual(inserts.length, 1);
        assert.strictEqual(inserts[0].userId, 7);
        assert.match(inserts[0].title, /^2 files in My Content will be deleted on 17 November 2026$/);
        assert.deepStrictEqual(inserts[0].metadata.assetIds, [1, 2]);
        assert.strictEqual(inserts[0].category, 'suggested_action');
    });
    await check('the notice is registered everywhere a notification type must be', () => {
        assert.match(read('src/utils/notification-templates-catalog.ts'), /templateKey: 'library_files_expiring'/);
        assert.match(read('src/utils/notification-actions.ts'), /library_files_expiring: 'suggested_action'/);
        assert.match(read('src/utils/notification-prefs.ts'), /'library_files_expiring'/);
        assert.match(read('notifications.js'), /library_files_expiring[\s\S]{0,200}loadView\?\.\('my-content', \{ expiring: true \}\)/);
    });

    console.log('\nThe purge and the clocks');
    await check('the purge tells first and never takes a kept or untold file', () => {
        const r = read('netlify/functions/content-retention.ts');
        assert.ok(r.indexOf('await warnExpiringFiles(db, now)') > -1 && r.indexOf('await warnExpiringFiles(db, now)') < r.indexOf('purgeGuard(now)'));
        const lib = read('src/utils/library-retention.ts');
        assert.match(lib, /isNull\(contentAssets\.libraryKeptAt\),\s*sql`\(\$\{contentAssets\.deletionWarnedAt\} <= \$\{toldBefore\.toISOString\(\)\}::timestamp/);
    });
    await check('posting or rejecting never puts a kept file back on a clock', () => {
        const p = read('src/utils/release-post-media.ts');
        assert.strictEqual((p.match(/isNull\(contentAssets\.libraryKeptAt\)/g) || []).length, 2);
    });
    await check('the column is in the schema and its SQL file', () => {
        assert.match(read('db/schema.ts'), /deletionWarnedAt: timestamp\("deletion_warned_at"\)/);
        assert.match(read('db/z-content-deletion-warning.sql'), /ADD COLUMN IF NOT EXISTS deletion_warned_at timestamp/);
    });

    console.log('\nThe page');
    await check('My Content is in the side menu, after Calendar and before Audience', () => {
        const s = read('components/sidebar.html');
        const at = (id: string) => s.indexOf(`id="${id}"`);
        assert.ok(at('nav-calendar') > -1 && at('nav-calendar') < at('nav-my-content') && at('nav-my-content') < at('nav-audience'));
    });
    await check('API: deletion date and Keep on any file, Keep several, storage', () => {
        const c = read('netlify/functions/content-assets.ts');
        assert.ok(c.includes('deletesAt(r, r.retentionDeleteAfter ?? brandCardExpiresAt(') && c.includes('canKeep: canKeep(r)'));
        assert.ok(c.includes("JSON.stringify({ assets: grouped, storage })"));
        assert.ok(c.includes("body.action !== 'keep' || !ids.length") && c.includes('rows.filter(r => canKeep(r))'));
    });
    await check('page: storage bar, Due to be deleted with Keep all, Keep on rows', () => {
        const j = read('my-content.js');
        assert.ok(read('my-content.html').includes('id="mc-storage"') && j.includes('function _mcRenderStorage()'));
        assert.ok(j.includes('role="progressbar"') && j.includes('no limit on your plan'));
        assert.ok(j.includes('Due to be deleted (${expiring.length})') && j.includes('Keep all ${keepable.length}'));
        assert.ok(j.includes('${viewBtn}${keepBtn}${actions}'));
        assert.ok(j.includes("_onlyExpiring = !!(param && typeof param === 'object' && param.expiring)"));
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
