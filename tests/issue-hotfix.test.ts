// tests/issue-hotfix.test.ts
// "Open hotfix PR" replaces "Push to prod" (which promoted ALL of staging to main via the laptop
// runner). Pins: the GitHub calls, the state machine that follows the PR, the live check asking
// about the hotfix's own merge commit, and the workflow's safety (inputs only through env vars,
// cherry-pick of one commit onto main, never a push to main).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    dispatchHotfix, findHotfixPr, nextHotfixState, hotfixPrFromResult, hotfixBranch, hotfixRunTitle, HOTFIX_STUCK_MINS,
} from '../src/utils/issue-hotfix';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const res = (status: number, body: any = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

async function main() {
    console.log('issue-hotfix');

    await check('dispatch: 204 is success; posts ref main + both inputs as strings', async () => {
        let seen: any = null;
        const err = await dispatchHotfix({ issueId: 42, fixPr: 600, token: 't', fetchImpl: async (url, init) => { seen = { url, init }; return res(204); } });
        assert.strictEqual(err, null);
        assert.ok(seen.url.endsWith('/actions/workflows/hotfix-pr.yml/dispatches'));
        assert.strictEqual(seen.init.method, 'POST');
        assert.deepStrictEqual(JSON.parse(seen.init.body), { ref: 'main', inputs: { issue_id: '42', fix_pr: '600' } });
    });

    await check('dispatch: no token, 404 and 403 each explain themselves', async () => {
        const prev = process.env.GITHUB_HOTFIX_TOKEN; delete process.env.GITHUB_HOTFIX_TOKEN;
        assert.match(String(await dispatchHotfix({ issueId: 1, fixPr: 2 })), /GITHUB_HOTFIX_TOKEN is not set/);
        if (prev !== undefined) process.env.GITHUB_HOTFIX_TOKEN = prev;
        assert.match(String(await dispatchHotfix({ issueId: 1, fixPr: 2, token: 't', fetchImpl: async () => res(404) })), /could not find the hotfix workflow/);
        assert.match(String(await dispatchHotfix({ issueId: 1, fixPr: 2, token: 't', fetchImpl: async () => res(403) })), /Actions read\/write/);
    });

    await check('findHotfixPr looks up the issue’s own branch and reads merged state', async () => {
        let url = '';
        const pr = await findHotfixPr({ issueId: 42, token: 't', fetchImpl: async (u) => { url = u; return res(200, [
            { number: 700, html_url: 'https://github.com/mefenemer/Be-More-Swan/pull/700', state: 'closed', merged_at: '2026-11-12T10:00:00Z', merge_commit_sha: 'a'.repeat(40) },
        ]); } });
        assert.ok(url.includes(encodeURIComponent(`mefenemer:${hotfixBranch(42)}`)) && url.includes('base=main'), url);
        assert.deepStrictEqual(pr, { url: 'https://github.com/mefenemer/Be-More-Swan/pull/700', number: 700, state: 'closed', merged: true, mergeSha: 'a'.repeat(40) });
    });

    const pr = (state: 'open' | 'closed', merged: boolean) => ({ url: 'https://github.com/mefenemer/Be-More-Swan/pull/700', number: 700, state, merged, mergeSha: null });

    await check('state machine: open PR → hotfix_open, merged → promoted, closed unmerged → failed', () => {
        assert.strictEqual(nextHotfixState({ current: 'hotfix_requested', requestedAt: new Date(), pr: pr('open', false), run: null })?.status, 'hotfix_open');
        const merged = nextHotfixState({ current: 'hotfix_open', requestedAt: new Date(), pr: pr('closed', true), run: null });
        assert.strictEqual(merged?.status, 'promoted');
        assert.strictEqual(hotfixPrFromResult(merged?.result), 700, 'the stored result names the hotfix PR for the live check');
        assert.strictEqual(nextHotfixState({ current: 'hotfix_open', requestedAt: new Date(), pr: pr('closed', false), run: null })?.status, 'failed');
    });

    await check('state machine: a failed run fails; a run still going waits; no run for too long fails', () => {
        const run = (status: string, conclusion: string | null) => ({ status, conclusion, url: 'https://github.com/x/actions/runs/1' });
        assert.strictEqual(nextHotfixState({ current: 'hotfix_requested', requestedAt: new Date(), pr: null, run: run('completed', 'failure') })?.status, 'failed');
        assert.strictEqual(nextHotfixState({ current: 'hotfix_requested', requestedAt: new Date(), pr: null, run: run('in_progress', null) }), null);
        const old = new Date(Date.now() - (HOTFIX_STUCK_MINS + 1) * 60_000);
        assert.strictEqual(nextHotfixState({ current: 'hotfix_requested', requestedAt: old, pr: null, run: null })?.status, 'failed');
        assert.strictEqual(nextHotfixState({ current: 'hotfix_requested', requestedAt: new Date(), pr: null, run: null }), null);
    });

    await check('state machine ignores rows that are not a hotfix in flight (incl. the old runner states)', () => {
        for (const current of [null, 'queued', 'promoting', 'promoted', 'failed']) {
            assert.strictEqual(nextHotfixState({ current, requestedAt: null, pr: pr('closed', true), run: null }), null, String(current));
        }
    });

    await check('the run-name the app matches is the one the workflow sets', () => {
        assert.strictEqual(hotfixRunTitle(42), 'Hotfix PR for issue #42');
        assert.ok(read('.github/workflows/hotfix-pr.yml').includes('run-name: Hotfix PR for issue #${{ inputs.issue_id }}'));
    });

    const wf = read('.github/workflows/hotfix-pr.yml');

    await check('workflow: inputs reach scripts only through env, and are checked as numbers', () => {
        const runBlocks = wf.split(/\n\s+run: \|/).slice(1).map((b) => b.split(/\n\s{6}- /)[0]);
        assert.ok(runBlocks.length >= 4);
        for (const b of runBlocks) assert.ok(!b.includes('${{'), `no expression inside a script:\n${b.slice(0, 120)}`);
        assert.ok(wf.includes('ISSUE_ID: ${{ inputs.issue_id }}') && wf.includes('FIX_PR: ${{ inputs.fix_pr }}'));
        assert.ok(wf.includes('[[ "$ISSUE_ID" =~ ^[0-9]{1,9}$ && "$FIX_PR" =~ ^[0-9]{1,9}$ ]]'));
    });

    await check('workflow: one commit cherry-picked onto a branch from main, PR into main, never a push to main', () => {
        assert.ok(wf.includes('git checkout -B "hotfix/issue-$ISSUE_ID" origin/main'));
        assert.ok(wf.includes('git cherry-pick -x "${args[@]}" "$SHA"'));
        assert.ok(wf.includes('if [[ "$base" != "staging" ]]'));
        assert.ok(wf.includes('gh pr create --base main --head "$branch"'));
        assert.ok(!/git push[^\n]*(:main|refs\/heads\/main)\b/.test(wf), 'no push to main');
    });

    await check('endpoint: dispatches the workflow, claims first, and no longer queues the laptop runner', () => {
        const api = read('netlify/functions/admin-issue-reports.ts');
        const block = api.slice(api.indexOf("action === 'request-prod-promote'"), api.indexOf("action === 'request-conflict-fix'"));
        assert.ok(block.includes("devProdStatus: 'hotfix_requested'"));
        assert.ok(block.includes('await dispatchHotfix({ issueId: id, fixPr })'));
        assert.ok(block.indexOf(".returning({ id: issueReports.id })") < block.indexOf('await dispatchHotfix'), 'claim before dispatch');
        assert.ok(!block.includes("devProdStatus: 'queued'"), 'the runner claims queued; never set it');
        assert.ok(api.includes('if (await syncHotfix(db, issue))'), 'opening the issue follows the PR');
    });

    await check('live check: a promoted hotfix is checked by its own merge commit', () => {
        const live = read('src/utils/issue-fix-live.ts');
        assert.ok(live.includes("if (state !== 'live' && row.dev_prod_status === 'promoted')"));
        assert.ok(live.includes('hotfixPrFromResult(row.dev_prod_result, o.repo)'));
        assert.ok(live.includes('result.hotfixesSynced = await syncOpenHotfixes('));
    });

    await check('card and confirm describe a hotfix PR, not a staging → main push', () => {
        const html = read('admin.html');
        assert.ok(html.includes("'Open hotfix PR'"));
        assert.ok(html.includes("title: 'Open a hotfix PR for this fix?'"));
        assert.ok(!html.includes('The developer runner will push staging → main'));
    });

    await check('SQL allows the two new statuses and keeps the old ones', () => {
        const q = read('db/z-issue-hotfix-pr.sql');
        assert.ok(q.includes("IN ('queued', 'promoting', 'promoted', 'failed', 'hotfix_requested', 'hotfix_open')"));
    });

    console.log(`\n${passed} passed`);
}

main();
