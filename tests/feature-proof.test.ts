// tests/feature-proof.test.ts
// Feature requests get the Fix pipeline's checks (owner, 2026-11-13; src/utils/feature-proof.ts).
// Pins: the "Ready for production?" checklist (proof test, SQL safety, SQL on staging/prod, staging CI and
// deploy, live on prod), the merge gate per database, the prod SQL needing the same text that passed on
// staging, and go-live: Released only once the deploy contains the PR, silently, never twice.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { featureChecklist, featureMergeBlocker, runFeatureLiveCheck, runFeatureProdSql, resetFeatureProofCache, type FeatureProofRow } from '../src/utils/feature-proof';
import { sqlHash } from '../src/utils/issue-sql';

const dialect = new PgDialect();
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SQL = 'ALTER TABLE x ADD COLUMN IF NOT EXISTS y TEXT;';
const PR = 'https://github.com/mefenemer/Be-More-Swan/pull/600';
const SHA = 'a'.repeat(40);
const base: FeatureProofRow = {
    id: 7, status: 'in_progress', devPrUrl: PR, prodPrUrl: null, devRepro: null, devSql: null, devSqlSafety: null,
    devStagingSqlStatus: null, devStagingSqlResult: null, devStagingSqlHash: null, devMergedAt: null,
    devStagingCiStatus: null, devStagingCiUrl: null, devStagingLiveAt: null, devProdSqlStatus: null,
    devProdSqlResult: null, devProdMergedAt: null, liveAt: null,
};
const state = (r: FeatureProofRow, key: string) => featureChecklist(r).items.find((i) => i.key === key)?.state;

/** A db answering by SQL text; `row` is the feature's proof row (snake_case). */
function fakeDb(o: { row?: Record<string, unknown> | null; live?: Array<Record<string, unknown>>; claim?: boolean } = {}) {
    const ran: Array<{ q: string; params: unknown[] }> = [];
    return {
        ran,
        execute: async (s: any) => {
            const { sql: q, params } = dialect.sqlToQuery(s);
            ran.push({ q, params });
            if (/information_schema\.columns/.test(q)) return o.row === null ? [] : [{ '?column?': 1 }];
            if (/FROM feature_requests WHERE id = /.test(q)) return o.row ? [{ id: 7, status: 'in_progress', ...o.row }] : [];
            if (/WHERE dev_merged_at > now\(\)/.test(q)) return [];
            if (/WHERE live_at IS NULL AND status NOT IN/.test(q) && /^select/i.test(q.trim())) return o.live || [];
            if (/SET status = 'released'/.test(q)) return o.claim === false ? [] : [{ id: 7 }];
            return [];
        },
    } as any;
}
/** GitHub: the PR is merged; compare answers `cmp` (ahead = deploy contains it). */
function fakeGh(cmp: string | number) {
    return async (url: string) => {
        const res = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
        if (/\/compare\//.test(url)) return typeof cmp === 'number' ? res(cmp, {}) : res(200, { status: cmp });
        return res(200, { merged: true, merge_commit_sha: 'b'.repeat(40) });
    };
}

(async () => {
    await check('checklist: nothing merged → not ready; proof missing is a warning, not a blocker', () => {
        const c = featureChecklist(base);
        assert.strictEqual(c.ready, false);
        assert.strictEqual(state(base, 'proof'), 'warn');
        assert.strictEqual(state(base, 'sql_safety'), 'ok');
        assert.ok(!c.items.some((i) => i.key === 'sql_prod'), 'no prod SQL row without SQL');
    });
    await check('checklist: proof counts only when it failed on the old code and passes with the feature', () => {
        assert.strictEqual(state({ ...base, devRepro: { test: 't.ts', kind: 'node', before: { exit: 1 }, after: { exit: 0 } } }, 'proof'), 'ok');
        assert.strictEqual(state({ ...base, devRepro: { test: 't.ts', kind: 'node', before: { exit: 0 }, after: { exit: 0 } } }, 'proof'), 'warn');
    });
    await check('checklist: merged, CI passed, live on staging, no SQL → ready', () => {
        const r = { ...base, devMergedAt: '2026-11-13 10:00', devStagingCiStatus: 'passed', devStagingLiveAt: '2026-11-13 10:20' };
        assert.strictEqual(featureChecklist(r).ready, true);
    });
    await check('checklist: "including the proof test" only when there is one', () => {
        const r = { ...base, devMergedAt: 'x', devStagingCiStatus: 'passed' };
        const detail = (x: FeatureProofRow) => featureChecklist(x).items.find((i) => i.key === 'tests_staging')!.detail;
        assert.strictEqual(detail(r), 'CI passed on the merge commit.');
        assert.match(detail({ ...r, devRepro: { test: 't.ts', kind: 'node', before: { exit: 1 }, after: { exit: 0 } } }), /including the proof test/);
    });
    await check('checklist: SQL not on staging (or changed since) blocks; not-additive SQL is a fail', () => {
        const merged = { ...base, devMergedAt: 'x', devStagingCiStatus: 'passed', devStagingLiveAt: 'y', devSql: SQL };
        assert.strictEqual(featureChecklist(merged).ready, false);
        assert.strictEqual(featureChecklist({ ...merged, devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash(SQL) }).ready, true);
        assert.strictEqual(featureChecklist({ ...merged, devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash('other') }).ready, false);
        assert.strictEqual(state({ ...base, devSql: 'DROP TABLE x;' }, 'sql_safety'), 'fail');
    });
    await check('checklist: CI failed on staging → fail, not ready', () => {
        const r = { ...base, devMergedAt: 'x', devStagingCiStatus: 'failed', devStagingLiveAt: 'y' };
        assert.strictEqual(state(r, 'tests_staging'), 'fail');
        assert.strictEqual(featureChecklist(r).ready, false);
    });
    await check('merge gate: staging needs the SQL on staging; main needs it on production; no SQL → free', async () => {
        resetFeatureProofCache();
        assert.match(String(await featureMergeBlocker(fakeDb({ row: { dev_sql: SQL } }), 7, 'staging')), /not on the staging database/);
        resetFeatureProofCache();
        assert.strictEqual(await featureMergeBlocker(fakeDb({ row: { dev_sql: SQL, dev_staging_sql_status: 'applied', dev_staging_sql_hash: sqlHash(SQL) } }), 7, 'staging'), null);
        resetFeatureProofCache();
        assert.match(String(await featureMergeBlocker(fakeDb({ row: { dev_sql: SQL, dev_staging_sql_status: 'applied', dev_staging_sql_hash: sqlHash(SQL) } }), 7, 'main')), /not on the production database/);
        resetFeatureProofCache();
        assert.strictEqual(await featureMergeBlocker(fakeDb({ row: { dev_sql: SQL, dev_prod_sql_status: 'applied' } }), 7, 'main'), null);
        resetFeatureProofCache();
        assert.strictEqual(await featureMergeBlocker(fakeDb({ row: {} }), 7, 'main'), null);
    });
    await check('prod SQL: refused until the same SQL passed on staging; never run twice', async () => {
        resetFeatureProofCache();
        const n = { runs: 0 };
        const run = async () => { n.runs++; return { ok: true, outcome: '✓ ran' }; };
        const no = await runFeatureProdSql(fakeDb({ row: { dev_sql: SQL } }), 7, 'postgres://prod', { run });
        assert.ok(!no.ok);
        assert.strictEqual(n.runs, 0);
        resetFeatureProofCache();
        const db = fakeDb({ row: { dev_sql: SQL, dev_staging_sql_status: 'applied', dev_staging_sql_hash: sqlHash(SQL) } });
        const yes = await runFeatureProdSql(db, 7, 'postgres://prod', { run });
        assert.ok(yes.ok);
        assert.strictEqual(n.runs, 1);
        assert.ok(db.ran.some((x: any) => /dev_prod_sql_status = \$1/.test(x.q) && x.params[0] === 'applied'));
        resetFeatureProofCache();
        await runFeatureProdSql(fakeDb({ row: { dev_sql: SQL, dev_staging_sql_status: 'applied', dev_staging_sql_hash: sqlHash(SQL), dev_prod_sql_status: 'applied' } }), 7, 'postgres://prod', { run });
        assert.strictEqual(n.runs, 1, 'already applied → not run again');
    });
    await check('go-live: deploy contains the PR → Released, silently, with a note', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [{ id: 7, dev_pr_url: PR, prod_pr_url: null }] });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh('ahead') as any });
        assert.strictEqual(r.released, 1);
        assert.ok(db.ran.some((x: any) => /SET status = 'released'.*live_at = now\(\)/s.test(x.q)));
        assert.ok(db.ran.some((x: any) => /dev_notes = concat_ws/.test(x.q)));
        assert.ok(!db.ran.some((x: any) => /notifications|feature_request_votes/.test(x.q)), 'no one notified');
    });
    await check('go-live: not in the deploy yet → stays; GitHub error → counted, untouched', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [{ id: 7, dev_pr_url: PR, prod_pr_url: null }] });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh('behind') as any });
        assert.strictEqual(r.released, 0);
        assert.ok(!db.ran.some((x: any) => /SET status = 'released'/.test(x.q)));
        resetFeatureProofCache();
        const r2 = await runFeatureLiveCheck(fakeDb({ live: [{ id: 7, dev_pr_url: PR, prod_pr_url: null }] }), { deployedSha: SHA, token: 't', fetchImpl: fakeGh(500) as any });
        assert.strictEqual(r2.errors, 1);
    });
    await check('go-live: a second run that loses the claim releases nothing', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [{ id: 7, dev_pr_url: PR, prod_pr_url: null }], claim: false });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh('ahead') as any });
        assert.strictEqual(r.released, 0);
        assert.ok(!db.ran.some((x: any) => /dev_notes = concat_ws/.test(x.q)));
    });
    await check('go-live: skips cleanly before the SQL, with no token, or with no baked commit', async () => {
        resetFeatureProofCache();
        assert.strictEqual((await runFeatureLiveCheck(fakeDb({ row: null }), { deployedSha: SHA, token: 't' })).skipped, 'sql');
        resetFeatureProofCache();
        assert.strictEqual((await runFeatureLiveCheck(fakeDb(), { deployedSha: SHA, token: '' })).skipped, 'no_token');
        resetFeatureProofCache();
        assert.strictEqual((await runFeatureLiveCheck(fakeDb(), { deployedSha: 'dev', token: 't' })).skipped, 'no_commit');
    });
    await check('hold: the live check never releases a held (switched-off) feature', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [] });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh('ahead') as any });
        assert.strictEqual(r.released, 0);
        const pick = db.ran.find((x: any) => /^select id, dev_pr_url, prod_pr_url/i.test(x.q.trim()));
        assert.ok(pick && /go_live_hold IS NULL/.test(pick.q), 'selection skips held rows');
    });
    await check('hold: the release claim also refuses a row held meanwhile', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [{ id: 7, dev_pr_url: PR, prod_pr_url: null }] });
        await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh('ahead') as any });
        const claim = db.ran.find((x: any) => /SET status = 'released'/.test(x.q));
        assert.ok(claim && /go_live_hold IS NULL/.test(claim.q));
    });
    await check('hold: checklist says it is switched off and why', () => {
        const r = { ...base, devMergedAt: 'x', devProdMergedAt: 'y', goLiveHold: 'Waiting for LinkedIn to approve.' };
        const live = featureChecklist(r).items.find((i) => i.key === 'live_prod')!;
        assert.strictEqual(live.state, 'wait');
        assert.match(live.detail, /switched off.*Waiting for LinkedIn/);
    });
    await check('wiring: live-check tick, board API, panel and script all use it', () => {
        assert.ok(readFileSync('netlify/functions/check-fixes-live.ts', 'utf8').includes('runFeatureLiveCheck(db'));
        const api = readFileSync('netlify/functions/admin-feature-requests.ts', 'utf8');
        assert.ok(api.includes('loadFeatureProofs(db') && api.includes('featureChecklist('));
        const html = readFileSync('admin.html', 'utf8');
        assert.ok(html.includes('${_frProofCard(it.proof)}') && html.includes('function _frProofCard(proof)'));
        assert.ok(html.includes("proof.goLiveHold ? ['bg-amber-100 text-amber-800', '⏸️ Switched off (held)']"));
        const script = readFileSync('scripts/feature-requests.ts', 'utf8');
        for (const cmd of ["cmd === 'hold'", "cmd === 'unhold'", "cmd === 'shipped'", "cmd === 'proof'", "cmd === 'staging-sql'", "cmd === 'merged'", "cmd === 'sync'", "cmd === 'prod-sql'", "cmd === 'sql-done'", "cmd === 'inspect'"]) assert.ok(script.includes(cmd), cmd);
        assert.ok(readFileSync('src/utils/pr-approval.ts', 'utf8').includes('featureMergeBlocker(db, id, base)'));
    });
    console.log(`\n${passed} passed.`);
})();
