// tests/issue-merge-restart.test.ts
// "Merge to staging" runs in GitHub Actions (src/utils/issue-cloud-merge.ts). The claim stamps
// dev_runner_heartbeat with its start time. A merge nothing has confirmed for STALE_MERGE_MINS can
// be force-restarted by a super-admin instead of the issue being 409'd forever; the workflow treats
// an already-merged PR as success, so a restart is harmless. (Was issue-merge-reclaim.test.ts,
// which covered the laptop runner's handshake; the runner was retired 2026-11-12.)

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMergeClaimStale, STALE_MERGE_MINS } from '../src/utils/issue-reports';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    const MIN = 60_000;
    const now = Date.now();

    await check('no start time counts as stale', () => {
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

    const reports = read('netlify/functions/admin-issue-reports.ts');
    const reqStart = reports.indexOf("action === 'request-merge' && id");
    const reqBlock = reports.slice(reqStart, reports.indexOf("action === 'request-prod-promote'"));
    await check('request-merge offers a force only for a stale merging claim', () => {
        assert.ok(reqStart > -1, 'request-merge handler not found');
        assert.ok(/isMergeClaimStale\(issue\.devRunnerHeartbeat\)/.test(reqBlock));
        assert.ok(/canForce: true/.test(reqBlock) && /canForce: false/.test(reqBlock));
    });
    await check('request-merge (and a forced restart) takes a fresh cloud claim, compare-and-swapped', () => {
        const upd = reqBlock.slice(reqBlock.indexOf("devMergeStatus: 'merging'"));
        assert.ok(/devRunnerId: CLOUD_RUNNER_ID/.test(upd) && /devRunnerHeartbeat: new Date\(\)/.test(upd));
        assert.ok(/eq\(issueReports\.devMergeStatus, issue\.devMergeStatus\)/.test(reqBlock));
    });
    await check('a merge left "queued" by the retired laptop runner is simply started, not 409d', () => {
        assert.ok(!reqBlock.includes("issue.devMergeStatus === 'queued'"));
    });

    const admin = read('admin.html');
    await check('admin merge card offers a forced restart on a stalled merge', () => {
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
