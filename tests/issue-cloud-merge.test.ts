// tests/issue-cloud-merge.test.ts
// "Merge to staging" runs in GitHub Actions instead of on a developer's laptop. Pins: the dispatch
// call, the state machine that follows the PR and run, the DB writes (compare-and-swap on the cloud
// claim, thread message, advance + rebuild only for the winner), the endpoint (claim before
// dispatch, release on refusal), the stale-merge reclaim leaving cloud merges alone, and the
// workflow's safety (inputs only through env, no checkout, only this issue's fix PR into staging).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CLOUD_RUNNER_ID, type AiFixRun } from '../src/utils/issue-ai-fix';
import {
    dispatchCloudMerge, getMergePr, nextMergeState, syncCloudMerge, mergeRunTitle, MERGE_NO_RUN_MINS, MERGE_STUCK_MINS, type MergePr,
} from '../src/utils/issue-cloud-merge';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const res = (status: number, body: any = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const PR_URL = 'https://github.com/mefenemer/Be-More-Swan/pull/801';
const RUN_URL = 'https://github.com/mefenemer/Be-More-Swan/actions/runs/9';

/** A fake db: raw statements are recorded; drizzle selects (maybeAdvanceToReadyToTest) find nothing. */
function fakeDb(returns: (q: string) => unknown[] = () => [{ id: 1 }]) {
    const dialect = new PgDialect();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const chain: any = { from: () => chain, where: () => chain, limit: async () => [], then: (r: any) => r([]) };
    return {
        calls,
        db: {
            execute: async (q: any) => { const r = dialect.sqlToQuery(q); calls.push({ sql: r.sql, params: r.params }); return returns(r.sql); },
            select: () => chain,
        } as any,
    };
}

async function main() {
    console.log('issue-cloud-merge');
    delete process.env.NETLIFY_STAGING_BUILD_HOOK; // the rebuild is a no-op here

    await check('dispatch: 204 is success; posts ref staging with the issue and PR as strings', async () => {
        let seen: any = null;
        assert.strictEqual(await dispatchCloudMerge({ issueId: 42, pr: 801, token: 't', fetchImpl: async (url, init) => { seen = { url, init }; return res(204); } }), null);
        assert.ok(seen.url.endsWith('/actions/workflows/merge-to-staging.yml/dispatches'));
        assert.deepStrictEqual(JSON.parse(seen.init.body), { ref: 'staging', inputs: { issue_id: '42', pr: '801' } });
        assert.match(String(await dispatchCloudMerge({ issueId: 1, pr: 2, token: 't', fetchImpl: async () => res(404) })), /could not find the merge workflow/);
        assert.match(String(await dispatchCloudMerge({ issueId: 1, pr: 2, token: 't', fetchImpl: async () => res(403) })), /Actions read\/write/);
    });

    await check('getMergePr reads merged state; 404 is "no PR"', async () => {
        assert.deepStrictEqual(await getMergePr({ pr: 801, token: 't', fetchImpl: async () => res(200, { html_url: PR_URL, state: 'closed', merged_at: '2026-11-12T10:00:00Z' }) }), { url: PR_URL, state: 'closed', merged: true });
        assert.strictEqual(await getMergePr({ pr: 801, token: 't', fetchImpl: async () => res(404) }), null);
        assert.strictEqual(await getMergePr({ pr: 801, token: 't', fetchImpl: async () => res(500) }), 'error');
    });

    const now = Date.parse('2026-11-12T12:00:00Z');
    const mins = (m: number) => new Date(now - m * 60_000);
    const pr = (merged: boolean, state: 'open' | 'closed' = merged ? 'closed' : 'open'): MergePr => ({ url: PR_URL, state, merged });
    const run = (status: string, conclusion: string | null): AiFixRun => ({ id: 9, status, conclusion, url: RUN_URL });
    const base = { mergeStatus: 'merging', runnerId: CLOUD_RUNNER_ID, startedAt: mins(2), pr: pr(false), run: null, now };

    await check('state machine: a merged PR is merged, whatever the run says', () => {
        assert.strictEqual(nextMergeState({ ...base, pr: pr(true) })?.kind, 'merged');
        assert.strictEqual(nextMergeState({ ...base, pr: pr(true), run: run('completed', 'failure') })?.kind, 'merged');
    });

    await check('state machine: a failed run fails with its reason; running waits; stuck or missing fails', () => {
        const f = nextMergeState({ ...base, run: run('completed', 'failure'), failureReason: 'GitHub refused the merge: required checks pending' });
        assert.strictEqual(f?.kind, 'failed');
        assert.ok(f!.result.includes('required checks pending') && f!.result.includes(RUN_URL));
        assert.match(nextMergeState({ ...base, run: run('completed', 'success') })!.result, /not merged/);
        assert.strictEqual(nextMergeState({ ...base, run: run('in_progress', null) }), null);
        assert.strictEqual(nextMergeState({ ...base, startedAt: mins(MERGE_STUCK_MINS + 1), run: run('in_progress', null) })?.kind, 'failed');
        assert.strictEqual(nextMergeState(base), null, 'just started, no run yet: wait');
        assert.strictEqual(nextMergeState({ ...base, startedAt: mins(MERGE_NO_RUN_MINS + 1) })?.kind, 'failed');
    });

    await check('state machine: only merges the cloud holds (not the laptop runner’s, not other states)', () => {
        for (const [mergeStatus, runnerId] of [['merging', 'mac:1'], ['queued', null], ['ready', null], ['merged', CLOUD_RUNNER_ID], ['conflict_resolving', CLOUD_RUNNER_ID]] as const) {
            assert.strictEqual(nextMergeState({ ...base, mergeStatus, runnerId, pr: pr(true) }), null, `${mergeStatus}/${runnerId}`);
        }
    });

    const row = { id: 42, devMergeStatus: 'merging', devRunnerId: CLOUD_RUNNER_ID, devRunnerHeartbeat: mins(2), devPrUrl: PR_URL };

    await check('sync: a merged PR is recorded with compare-and-swap on the cloud claim, then threaded', async () => {
        const { db, calls } = fakeDb();
        let urls: string[] = [];
        const changed = await syncCloudMerge(db, row, { token: 't', now, fetchImpl: async (u) => { urls.push(u); return res(200, { html_url: PR_URL, state: 'closed', merged_at: 'x' }); } });
        assert.strictEqual(changed, true);
        assert.deepStrictEqual(urls, ['https://api.github.com/repos/mefenemer/Be-More-Swan/pulls/801'], 'merged: no need to look up the run');
        assert.match(calls[0].sql, /SET dev_merge_status = 'merged', dev_merged_at = now\(\)[\s\S]*WHERE id = \$\d+ AND dev_merge_status = 'merging' AND dev_runner_id = \$\d+/);
        assert.ok(calls[0].params.includes(CLOUD_RUNNER_ID));
        assert.match(calls[1].sql, /INSERT INTO issue_report_messages/);
        assert.ok(String(calls[1].params.find((p) => typeof p === 'string' && p.startsWith('🔀'))).includes('merged to staging'));
    });

    await check('sync: a failed run records GitHub’s reason; a lost compare-and-swap writes nothing else', async () => {
        const fetchImpl = async (u: string) => {
            if (u.endsWith('/pulls/801')) return res(200, { html_url: PR_URL, state: 'open', merged_at: null });
            if (u.includes('/workflows/merge-to-staging.yml/runs')) return res(200, { workflow_runs: [{ id: 9, display_title: mergeRunTitle(42), status: 'completed', conclusion: 'failure', html_url: RUN_URL, created_at: mins(1).toISOString() }] });
            if (u.includes('/runs/9/jobs')) return res(200, { jobs: [{ id: 5, check_run_url: 'https://api.github.com/repos/x/y/check-runs/55' }] });
            if (u.includes('/check-runs/55/annotations')) return res(200, [{ title: 'Merge to staging', message: 'GitHub refused the merge:\nPull request is not mergeable' }]);
            return res(404);
        };
        const { db, calls } = fakeDb();
        assert.strictEqual(await syncCloudMerge(db, row, { token: 't', now, fetchImpl }), true);
        assert.match(calls[0].sql, /dev_merge_status = 'failed'/);
        assert.ok(String(calls[0].params.find((p) => typeof p === 'string' && p.includes('not mergeable'))).includes(RUN_URL));
        assert.match(calls[1].sql, /INSERT INTO issue_report_messages/);

        const lost = fakeDb(() => []);
        assert.strictEqual(await syncCloudMerge(lost.db, row, { token: 't', now, fetchImpl }), false);
        assert.strictEqual(lost.calls.length, 1);
    });

    await check('sync: never calls GitHub for a merge the cloud does not hold', async () => {
        let fetched = 0;
        const { db, calls } = fakeDb();
        assert.strictEqual(await syncCloudMerge(db, { ...row, devRunnerId: 'mac:1' }, { token: 't', fetchImpl: async () => { fetched++; return res(200); } }), false);
        assert.strictEqual(fetched + calls.length, 0);
    });

    // ── The workflow ────────────────────────────────────────────────────────────────────────────
    const wf = read('.github/workflows/merge-to-staging.yml');

    await check('workflow: run-name matches; inputs reach scripts only through env and are numbers', () => {
        assert.strictEqual(mergeRunTitle(42), 'Merge to staging for issue #42');
        assert.ok(wf.includes('run-name: "Merge to staging for issue #${{ inputs.issue_id }}"'));
        const runBlocks = wf.split(/\n\s+run: \|/).slice(1).map((b) => b.split(/\n\s{6}- /)[0]);
        assert.ok(runBlocks.length >= 5, String(runBlocks.length));
        for (const b of runBlocks) assert.ok(!b.includes('${{'), `no expression inside a script:\n${b.slice(0, 120)}`);
        assert.ok(wf.includes('[[ "$ISSUE_ID" =~ ^[0-9]{1,9}$ && "$PR" =~ ^[0-9]{1,9}$ ]]'));
    });

    await check('workflow: no checkout and no repo code; merges only this issue’s fix PR into staging', () => {
        assert.ok(!/actions\/checkout|npm |node /.test(wf), 'nothing from the repo runs');
        assert.ok(wf.includes('if [[ "$base" != "staging" ]]'));
        assert.ok(wf.includes('"$head" == "ai-fix/issue-$ISSUE_ID" || "$head" =~ ^fix/issue-$ISSUE_ID(-[0-9]+)?$'));
        assert.ok(wf.includes('gh pr merge "$PR" --repo "$GITHUB_REPOSITORY" --merge --delete-branch'));
        const scripts = wf.split(/\n\s+run: \|/).slice(1).map((b) => b.split(/\n\s{6}- /)[0]).join('\n');
        assert.ok(!/git push/.test(wf) && !/\bmain\b/.test(scripts), 'never touches main');
        assert.ok(wf.includes('if [[ "$state" != "MERGED" ]]'), 'confirms the merge landed');
    });

    await check('workflow: per-issue concurrency, so "Merge all" doesn’t cancel pending runs', () => {
        assert.ok(wf.includes('group: merge-to-staging-${{ inputs.issue_id }}'));
    });

    await check('workflow: the failure reason is one escaped line titled for the app', () => {
        assert.ok(wf.includes("reason=${reason//$'\\n'/'%0A'}") && wf.includes('echo "::error title=Merge to staging::$reason"'));
    });

    // ── The app ─────────────────────────────────────────────────────────────────────────────────
    const api = read('netlify/functions/admin-issue-reports.ts');

    await check('endpoint: Merge to staging claims (compare-and-swap) before dispatch and releases on refusal', () => {
        const block = api.slice(api.indexOf("action === 'request-merge' && id"), api.indexOf("action === 'request-prod-promote'"));
        assert.ok(block.includes("devMergeStatus: 'merging'") && block.includes('devRunnerId: CLOUD_RUNNER_ID'));
        assert.ok(block.indexOf('.returning({ id: issueReports.id })') < block.indexOf('await dispatchCloudMerge'));
        assert.ok(block.includes("eq(issueReports.devMergeStatus, 'merging'), eq(issueReports.devRunnerId, CLOUD_RUNNER_ID)"), 'release only our own claim');
        assert.ok(!block.includes("devMergeStatus: 'queued'"), 'nothing queues the laptop runner');
    });

    await check('endpoint: Merge all is capped, claims before dispatch, still skips pending SQL', () => {
        const block = api.slice(api.indexOf("action === 'request-merge-all'"), api.indexOf('// Staging is now rebuilt automatically'));
        assert.ok(block.includes('.limit(MERGE_BULK_MAX + 1)'));
        assert.ok(block.includes("ne(issueReports.devSqlStatus, 'pending')"));
        assert.ok(block.indexOf('.returning(') < block.indexOf('await dispatchCloudMerge'));
        assert.ok(!block.includes("devMergeStatus: 'queued'"));
    });

    await check('the issue, the list and the hourly check follow cloud merges', () => {
        assert.ok(api.includes('if (await syncCloudMerge(db, issue, { headers: event.headers }))'));
        assert.ok(api.includes('await syncOpenCloudMerges(db, { limit: 5 })'));
        assert.ok(read('netlify/functions/check-fixes-live.ts').includes('const mergesSynced = await syncOpenCloudMerges(db);'));
    });

    await check('no laptop-era reclaim is left to undo a cloud merge', () => {
        assert.ok(!read('src/utils/issue-reports.ts').includes('reclaimStaleMerges'));
        assert.ok(!api.includes('reclaimStaleMerges'));
        assert.strictEqual(CLOUD_RUNNER_ID, 'GitHub Actions');
    });

    await check('panel: a cloud merge says GitHub Actions, and the confirm no longer mentions the runner', () => {
        const html = read('admin.html');
        assert.ok(html.includes("const cloudMerge = i.devRunnerId === 'GitHub Actions';"));
        assert.ok(html.includes('GitHub Actions will merge the pull request into staging.'));
        assert.ok(!html.includes('The developer runner will merge the pull request'));
    });

    console.log(`\n${passed} passed`);
}

main();
