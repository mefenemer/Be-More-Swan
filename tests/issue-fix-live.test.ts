// tests/issue-fix-live.test.ts
// Issues: the reporter hears "fixed" only when the fix is LIVE on the site they use, and an issue
// nobody replies to closes itself 7 days later. Pins the GitHub inclusion check, the PR-URL parser,
// the skip reasons, and the wiring (schedule, staging poke, build stamp, staging merge no longer
// notifying, a reply reopening a closed issue).

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parsePrNumber, isFullSha, checkFixDeployed, runFixLiveCheck, resetFixLiveColumnsCache, AUTO_CLOSE_DAYS,
} from '../src/utils/issue-fix-live';
import { BUILD_COMMIT } from '../src/generated/build-commit';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const MERGE = 'a'.repeat(40);
const DEPLOYED = 'b'.repeat(40);

/** A fake GitHub: the PR answer and the compare answer, recording the URLs asked for. */
function fakeGitHub(pr: { ok?: boolean; merged?: boolean; sha?: string | null }, cmp: { ok?: boolean; status?: number; body?: any }) {
    const urls: string[] = [];
    const fetchImpl = async (url: string) => {
        urls.push(url);
        if (url.includes('/pulls/')) {
            return { ok: pr.ok !== false, status: pr.ok === false ? 500 : 200, json: async () => ({ merged: pr.merged ?? true, merge_commit_sha: pr.sha === undefined ? MERGE : pr.sha }) };
        }
        return { ok: cmp.ok !== false, status: cmp.status ?? (cmp.ok === false ? 500 : 200), json: async () => cmp.body };
    };
    return { fetchImpl, urls };
}

async function main() {
    console.log('issue-fix-live');

    await check('parsePrNumber accepts this repo’s PR URLs only', () => {
        assert.strictEqual(parsePrNumber('https://github.com/mefenemer/Be-More-Swan/pull/553'), 553);
        assert.strictEqual(parsePrNumber('https://github.com/mefenemer/be-more-swan/pull/12/files'), 12);
        assert.strictEqual(parsePrNumber('https://github.com/someone-else/Be-More-Swan/pull/553'), null);
        assert.strictEqual(parsePrNumber('https://github.com/mefenemer/Be-More-Swan/issues/553'), null);
        assert.strictEqual(parsePrNumber('http://github.com/mefenemer/Be-More-Swan/pull/553'), null);
        assert.strictEqual(parsePrNumber(null), null);
    });

    await check('isFullSha rejects the dev placeholder and short SHAs', () => {
        assert.ok(isFullSha(MERGE));
        assert.ok(!isFullSha('dev'));
        assert.ok(!isFullSha('7b51c659'));
    });

    await check('committed BUILD_COMMIT is the dev placeholder (the build stamps the real one)', () => {
        assert.strictEqual(BUILD_COMMIT, 'dev');
    });

    await check('live when the deployed commit contains the merge commit (ahead / identical)', async () => {
        for (const status of ['ahead', 'identical']) {
            const gh = fakeGitHub({}, { body: { status } });
            assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: gh.fetchImpl }), 'live');
            assert.ok(gh.urls[1].endsWith(`/compare/${MERGE}...${DEPLOYED}`), gh.urls[1]);
        }
    });

    await check('not yet when the deploy is behind or diverged, or GitHub 404s the compare', async () => {
        for (const status of ['behind', 'diverged']) {
            const gh = fakeGitHub({}, { body: { status } });
            assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: gh.fetchImpl }), 'not_yet');
        }
        const gh = fakeGitHub({}, { ok: false, status: 404 });
        assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: gh.fetchImpl }), 'not_yet');
    });

    await check('an unmerged PR is never live, and the compare is not asked', async () => {
        const gh = fakeGitHub({ merged: false, sha: null }, { body: { status: 'ahead' } });
        assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: gh.fetchImpl }), 'not_merged');
        assert.strictEqual(gh.urls.length, 1);
    });

    await check('GitHub errors and throws are "error", never "live"', async () => {
        const down = fakeGitHub({ ok: false }, {});
        assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: down.fetchImpl }), 'error');
        const cmp500 = fakeGitHub({}, { ok: false, status: 500 });
        assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: cmp500.fetchImpl }), 'error');
        const throws = async () => { throw new Error('network'); };
        assert.strictEqual(await checkFixDeployed({ prNumber: 5, deployedSha: DEPLOYED, token: 't', fetchImpl: throws as any }), 'error');
    });

    // A db stand-in: answers the column check, records every other statement.
    function fakeDb(columnsReady: boolean) {
        const statements: string[] = [];
        const db: any = {
            execute: async (q: any) => {
                const text = JSON.stringify(q);
                if (text.includes('information_schema')) return columnsReady ? [{ '?column?': 1 }] : [];
                statements.push(text);
                return [];
            },
            insert: () => ({ values: async () => undefined }),
        };
        return { db, statements };
    }

    await check('does nothing before the SQL is applied', async () => {
        resetFixLiveColumnsCache();
        const { db, statements } = fakeDb(false);
        const r = await runFixLiveCheck(db, { token: 't', deployedSha: DEPLOYED });
        assert.strictEqual(r.skipped, 'sql');
        assert.strictEqual(statements.length, 0);
    });

    await check('no token or no baked commit skips the live check but still runs auto-close', async () => {
        resetFixLiveColumnsCache();
        const a = fakeDb(true);
        const noToken = await runFixLiveCheck(a.db, { token: '', deployedSha: DEPLOYED });
        assert.strictEqual(noToken.skipped, 'no_token');
        assert.ok(a.statements.some((s) => s.includes("status = 'closed'")), 'auto-close ran');
        assert.ok(!a.statements.some((s) => s.includes('live_pr_url IS DISTINCT FROM dev_pr_url')), 'live query not run');

        const b = fakeDb(true);
        const noCommit = await runFixLiveCheck(b.db, { token: 't', deployedSha: 'dev' });
        assert.strictEqual(noCommit.skipped, 'no_commit');
    });

    // Ticket #95 (2026-11-26): fix PR #891 merged into staging, then a fixes-only release (#896) COPIED it
    // into main. #891's own merge commit never reaches main, so the ticket sat "not live" for ever. The
    // prod PR recorded on the ticket (prod_pr_url, fix-tickets.ts prod-pr) counts once it is merged into
    // main and inside the deploy.
    const FIX_PR = 'https://github.com/mefenemer/Be-More-Swan/pull/891';
    const PROD_PR = 'https://github.com/mefenemer/Be-More-Swan/pull/896';
    const RELEASE = 'c'.repeat(40);
    function releaseDb(prodPrUrl: string | null) {
        const statements: string[] = [];
        const db: any = {
            execute: async (q: any) => {
                const text = JSON.stringify(q);
                if (text.includes('information_schema')) return [{ '?column?': 1 }];
                statements.push(text);
                if (text.includes('live_pr_url IS DISTINCT FROM dev_pr_url')) {
                    return [{ id: 95, user_id: null, dev_pr_url: FIX_PR, prod_pr_url: prodPrUrl, dev_prod_status: 'failed', dev_prod_result: 'The hotfix workflow failed (failure).' }];
                }
                if (text.includes("SET status = 'closed', fixed_at = now(), live_at = now()")) return [{ id: 95 }];
                return [];
            },
            insert: () => ({ values: async () => undefined }),
        };
        return { db, statements };
    }
    /** #891 diverged from the deploy; the release PR's answer is given per test. */
    function releaseGitHub(release: { base: string; merged?: boolean; mergedAt?: string }) {
        const urls: string[] = [];
        const fetchImpl = async (url: string) => {
            urls.push(url);
            if (url.endsWith('/pulls/891')) return { ok: true, status: 200, json: async () => ({ merged: true, merge_commit_sha: MERGE, merged_at: '2026-11-26T05:41:00Z', base: { ref: 'staging' } }) };
            if (url.endsWith('/pulls/896')) return { ok: true, status: 200, json: async () => ({ merged: release.merged ?? true, merge_commit_sha: RELEASE, merged_at: release.mergedAt ?? '2026-11-26T06:21:12Z', base: { ref: release.base } }) };
            if (url.includes(`/compare/${MERGE}...`)) return { ok: true, status: 200, json: async () => ({ status: 'diverged' }) };
            if (url.includes(`/compare/${RELEASE}...`)) return { ok: true, status: 200, json: async () => ({ status: 'ahead' }) };
            return { ok: true, status: 200, json: async () => [] };
        };
        return { fetchImpl, urls };
    }

    await check('a fix copied into main by a recorded release PR goes live (#95)', async () => {
        resetFixLiveColumnsCache();
        const { db, statements } = releaseDb(PROD_PR);
        const gh = releaseGitHub({ base: 'main' });
        const r = await runFixLiveCheck(db, { token: 't', deployedSha: DEPLOYED, fetchImpl: gh.fetchImpl as any });
        assert.strictEqual(r.live, 1, `live=${r.live} notYet=${r.notYet} errors=${r.errors}`);
        assert.ok(statements.some((s) => s.includes("SET status = 'closed', fixed_at = now(), live_at = now()")));
    });

    await check('a recorded prod PR that went into staging, or is unmerged, does not count', async () => {
        for (const release of [{ base: 'staging' }, { base: 'main', merged: false }]) {
            resetFixLiveColumnsCache();
            const { db } = releaseDb(PROD_PR);
            const r = await runFixLiveCheck(db, { token: 't', deployedSha: DEPLOYED, fetchImpl: releaseGitHub(release).fetchImpl as any });
            assert.strictEqual(r.live, 0, JSON.stringify(release));
            assert.strictEqual(r.notYet, 1, JSON.stringify(release));
        }
    });

    await check('a reopened ticket keeps its old release: a prod PR merged BEFORE the current fix does not count', async () => {
        resetFixLiveColumnsCache();
        const { db } = releaseDb(PROD_PR);
        const r = await runFixLiveCheck(db, { token: 't', deployedSha: DEPLOYED, fetchImpl: releaseGitHub({ base: 'main', mergedAt: '2026-11-20T10:00:00Z' }).fetchImpl as any });
        assert.strictEqual(r.live, 0);
        assert.strictEqual(r.notYet, 1);
    });

    await check('recording a new fix PR clears the old prod PR and hotfix result', () => {
        const ft = read('scripts/fix-tickets.ts');
        const pr = ft.slice(ft.indexOf("} else if (cmd === 'pr') {"), ft.indexOf("} else if (cmd === 'staging-sql') {"));
        assert.ok(pr.includes('prod_pr_url = NULL, dev_prod_status = NULL, dev_prod_result = NULL'));
    });

    await check('no prod PR recorded: still not live (nothing guessed)', async () => {
        resetFixLiveColumnsCache();
        const { db } = releaseDb(null);
        const gh = releaseGitHub({ base: 'main' });
        const r = await runFixLiveCheck(db, { token: 't', deployedSha: DEPLOYED, fetchImpl: gh.fetchImpl as any });
        assert.strictEqual(r.live, 0);
        assert.ok(!gh.urls.some((u) => u.endsWith('/pulls/896')));
    });

    const src = read('src/utils/issue-fix-live.ts');

    await check('auto-close: 7 days, no reporter reply since, compare-and-swap on status', () => {
        assert.strictEqual(AUTO_CLOSE_DAYS, 7);
        assert.ok(src.includes("m.author_type = 'user' AND m.created_at > r.fixed_at"));
        assert.ok(src.includes("AND i.status = 'fixed_ready_to_test'\n        RETURNING"));
    });

    await check('live: compare-and-swap on the PR checked, so overlapping runs notify once', () => {
        assert.ok(src.includes('AND dev_pr_url = ${row.dev_pr_url}'));
        assert.ok(src.includes('AND live_pr_url IS DISTINCT FROM ${row.dev_pr_url}'));
    });

    await check('staging merge no longer tells the reporter once the SQL is in', () => {
        const ir = read('src/utils/issue-reports.ts');
        const fn = ir.slice(ir.indexOf('export async function maybeAdvanceToReadyToTest'));
        const gate = fn.indexOf('if (await fixLiveColumnsReady(db))');
        const notify = fn.indexOf('notifyIssueUser(');
        assert.ok(gate > 0 && notify > gate, 'live-check gate comes before the old notify');
        assert.ok(fn.slice(gate, notify).includes('return false;'));
    });

    await check('admin setting "Fixed" by hand starts the 7-day clock', () => {
        assert.ok(read('netlify/functions/admin-issue-reports.ts').includes("if (newStatus === 'fixed_ready_to_test') await stampFixedAt(db, id);"));
    });

    await check('a reply reopens a closed issue, and the card offers it', () => {
        assert.ok(read('netlify/functions/issue-reports.ts').includes("issue.status === 'fixed_ready_to_test' || issue.status === 'closed')"));
        assert.ok(read('help.js').includes('Still broken? Reply to reopen'));
    });

    await check('scheduled on prod, poked on staging, commit stamped at build', () => {
        assert.ok(read('netlify.toml').includes('[functions.check-fixes-live]\n  schedule = "*/30 * * * *"'));
        assert.ok(/run-fix-live-check\s+1800\s+120/.test(read('.github/workflows/staging-crons.yml')));
        const stamp = read('scripts/stamp-view-version.mjs');
        assert.ok(stamp.includes("src/generated/build-commit.ts") && stamp.includes('process.env.COMMIT_REF'));
    });

    await check('both automatic messages have catalog copy', () => {
        const cat = read('src/utils/notification-templates-catalog.ts');
        assert.ok(cat.includes("templateKey: 'issue_fixed_live'"));
        assert.ok(cat.includes("templateKey: 'issue_auto_closed'"));
    });

    console.log(`\n${passed} passed`);
}

main();
