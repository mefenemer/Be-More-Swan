// tests/issue-merge-reclaim.test.ts
// "Merge to staging" is a handshake: the runner claims the merge (queued → merging) and later
// POSTs the result. A runner that dies in between used to strand the issue in 'merging' forever,
// with request-merge 409ing every retry. These pin the self-heal: stale claims are reclaimed to
// 'ready', a super-admin can force a re-queue, and the runner confirms an already-merged PR
// instead of failing it.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMergeClaimStale, reclaimStaleMerges, STALE_MERGE_MINS } from '../src/utils/issue-reports';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// Minimal stand-in for the drizzle chains reclaimStaleMerges uses.
function fakeDb(reclaimedIds: number[]) {
    const calls = { set: null as any, inserted: null as any, updates: 0 };
    const db: any = {
        update: () => ({
            set: (v: any) => { calls.set = v; calls.updates++; return {
                where: () => ({ returning: async () => reclaimedIds.map((id) => ({ id })) }),
            }; },
        }),
        insert: () => ({ values: async (v: any) => { calls.inserted = v; } }),
        select: () => ({ from: () => ({ where: async () => [{ n: 0 }] }) }),
    };
    return { db, calls };
}

(async () => {
    const MIN = 60_000;
    const now = Date.now();

    await check('no heartbeat counts as stale', () => {
        assert.strictEqual(isMergeClaimStale(null, now), true);
        assert.strictEqual(isMergeClaimStale(undefined, now), true);
    });
    await check('a fresh claim is not stale', () => {
        assert.strictEqual(isMergeClaimStale(new Date(now - 2 * MIN), now), false);
    });
    await check(`a claim older than ${STALE_MERGE_MINS} min is stale (Date or ISO string)`, () => {
        assert.strictEqual(isMergeClaimStale(new Date(now - (STALE_MERGE_MINS + 1) * MIN), now), true);
        assert.strictEqual(isMergeClaimStale(new Date(now - (STALE_MERGE_MINS + 1) * MIN).toISOString(), now), true);
    });

    await check('reclaim resets stranded merges to ready and clears the runner claim', async () => {
        const { db, calls } = fakeDb([7, 9]);
        const n = await reclaimStaleMerges(db);
        assert.strictEqual(n, 2);
        assert.strictEqual(calls.set.devMergeStatus, 'ready');
        assert.strictEqual(calls.set.devRunnerId, null);
        assert.strictEqual(calls.set.devRunnerHeartbeat, null);
        assert.deepStrictEqual(calls.inserted.map((m: any) => m.issueId), [7, 9]);
        assert.ok(calls.inserted.every((m: any) => /Merge reclaimed/.test(m.body)));
    });
    await check('reclaim with nothing stranded writes no thread messages', async () => {
        const { db, calls } = fakeDb([]);
        assert.strictEqual(await reclaimStaleMerges(db), 0);
        assert.strictEqual(calls.inserted, null);
    });

    const util = read('src/utils/issue-reports.ts');
    const reclaimFn = util.slice(util.indexOf('export async function reclaimStaleMerges'));
    await check('reclaim only touches merging rows, in one UPDATE … RETURNING', () => {
        assert.ok(reclaimFn.length > 0, 'reclaimStaleMerges not found');
        assert.ok(/eq\(issueReports\.devMergeStatus, 'merging'\)/.test(reclaimFn));
        assert.ok(/\.returning\(/.test(reclaimFn));
        assert.ok(!/db\s*\.select\(/.test(reclaimFn.slice(0, reclaimFn.indexOf('triggerStagingDeployIfDrained'))),
            'reclaim must not select-then-update (two callers would both announce the reclaim)');
    });

    const handoff = read('netlify/functions/admin-issue-handoff.ts');
    await check('claim-merge reclaims stale merges before claiming new work', () => {
        const start = handoff.indexOf("action === 'claim-merge'");
        assert.ok(start > -1, 'claim-merge handler not found');
        const block = handoff.slice(start, handoff.indexOf("action === 'merge-result'"));
        assert.ok(block.indexOf('reclaimStaleMerges(db)') > -1, 'claim-merge does not reclaim');
        assert.ok(block.indexOf('reclaimStaleMerges(db)') < block.indexOf("eq(issueReports.devMergeStatus, 'queued')"));
    });

    const reports = read('netlify/functions/admin-issue-reports.ts');
    const reqStart = reports.indexOf("action === 'request-merge' && id");
    const reqBlock = reports.slice(reqStart, reports.indexOf("action === 'request-prod-promote'"));
    await check('request-merge offers a force only for a stale merging claim', () => {
        assert.ok(reqStart > -1, 'request-merge handler not found');
        assert.ok(/isMergeClaimStale\(issue\.devRunnerHeartbeat\)/.test(reqBlock));
        assert.ok(/canForce: true/.test(reqBlock));
        // 'queued' is not forceable: no runner has it, so re-queuing changes nothing.
        const queuedBranch = reqBlock.slice(reqBlock.indexOf("issue.devMergeStatus === 'queued'"));
        assert.ok(/canForce: false/.test(queuedBranch.slice(0, queuedBranch.indexOf('}'))));
    });
    await check('request-merge re-queue clears the old claim and is compare-and-swapped', () => {
        const upd = reqBlock.slice(reqBlock.indexOf("devMergeStatus: 'queued'"));
        assert.ok(/devRunnerId: null/.test(upd) && /devRunnerHeartbeat: null/.test(upd));
        assert.ok(/eq\(issueReports\.devMergeStatus, issue\.devMergeStatus\)/.test(reqBlock));
    });
    await check('the issue list self-heals stranded merges', () => {
        const list = reports.slice(reports.indexOf('// ── GET list'));
        assert.ok(list.indexOf('reclaimStaleMerges(db)') > -1 && list.indexOf('reclaimStaleMerges(db)') < list.indexOf('db\n            .select('));
    });

    const runner = read('scripts/dev-issue-fixer.mjs');
    const merge = runner.slice(runner.indexOf('async function processMerge'), runner.indexOf('async function processPromote'));
    await check('runner confirms an already-merged PR instead of re-merging it', () => {
        assert.ok(merge.length > 0, 'processMerge not found');
        assert.ok(merge.indexOf('prIsMerged(target)') > -1);
        assert.ok(merge.indexOf('prIsMerged(target)') < merge.indexOf("'pr', 'merge'"));
    });
    await check('runner verifies the merge landed before reporting success', () => {
        const after = merge.slice(merge.indexOf("'pr', 'merge'"));
        assert.ok(/if \(!prIsMerged\(target\)\)/.test(after));
    });
    await check('a failed success-report is not recorded as a failed merge', () => {
        const tail = merge.slice(merge.lastIndexOf('reportMerge(id, { ok: true'));
        assert.ok(!/ok: false/.test(tail), 'reporting failure after a landed merge must not report ok:false');
    });

    const admin = read('admin.html');
    await check('admin merge card offers a force re-queue on a stalled merge', () => {
        const card = admin.slice(admin.indexOf('function _irMergeCard'), admin.indexOf('function _irProdCard'));
        assert.ok(/requestMerge\(\$\{i\.id\}, true\)/.test(card));
        assert.ok(/Merging — stalled\?/.test(card));
    });
    await check('requestMerge sends force and follows canForce from the server', () => {
        const fn = admin.slice(admin.indexOf('async function requestMerge('), admin.indexOf('async function requestProdPromote('));
        assert.ok(/force \? \{ force: true \} : \{\}/.test(fn));
        assert.ok(/e\?\.data\?\.canForce/.test(fn));
        assert.ok(!/\bconfirm\(|\balert\(/.test(fn), 'use confirmModal / showToast, not native dialogs');
    });

    console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
