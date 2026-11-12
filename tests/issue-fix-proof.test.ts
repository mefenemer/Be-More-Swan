// tests/issue-fix-proof.test.ts
// Fix pipeline: proof before production (docs/fix-pipeline-proof-plan.md, owner decisions 2026-11-12).
// Pins: the proof block, "confirmed" only on fail-then-pass (and never for a source-scan or missing-code
// "repro"), the checklist, SQL on staging before a merge, and Approve for production (server-side
// re-check, same SQL hash, prod SQL before the merge, nothing merges when a step fails).
import assert from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
    parseProof, rootCauseStatus, productionChecklist, ensureStagingSql, approveForProduction, unzip,
    stagingCiState, resetProofColumnsCache, PROOF_START, PROOF_END, type ProofRow,
} from '../src/utils/issue-fix-proof';
import { sqlHash } from '../src/utils/issue-sql';

const dialect = new PgDialect();
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const body = (p: unknown) => `## What changed\nstuff\n${PROOF_START}\n${JSON.stringify(p)}\n${PROOF_END}\n`;
const proofOf = (before: number | null, after: number | null, extra: Record<string, unknown> = {}) => ({
    claimed: 'identified', rootCause: 'blog-studio-modal.js:1530 swallowed the error',
    repro: { test: 'tests/repro-issue-42.test.ts', kind: 'node', before: before == null ? null : { exit: before, tail: 'x' }, after: after == null ? null : { exit: after, tail: 'y' }, flags: [], ...extra },
    runId: 123,
});

/** A db whose execute() answers by the SQL text, and records every statement. */
function fakeDb(answer: (q: string, params: unknown[]) => unknown[] = () => []) {
    const ran: Array<{ q: string; params: unknown[] }> = [];
    return {
        ran,
        execute: async (s: any) => {
            const { sql: q, params } = dialect.sqlToQuery(s);
            ran.push({ q, params });
            if (/information_schema\.columns/.test(q)) return [{ '?column?': 1 }];
            return answer(q, params);
        },
    } as any;
}

const baseRow = (over: Partial<ProofRow> = {}): ProofRow => ({
    id: 42, devPrUrl: 'https://github.com/mefenemer/Be-More-Swan/pull/562', devSql: null, devSqlStatus: null,
    devMergeStatus: 'merged', devProdStatus: null, devRootCauseStatus: 'confirmed', devRootCause: 'x',
    devRepro: { test: 't', kind: 'node', before: { exit: 1 }, after: { exit: 0 }, flags: [] },
    devSqlSafety: 'none', devSqlHash: null, devStagingSqlStatus: null, devStagingSqlResult: null, devStagingSqlHash: null,
    devStagingCiStatus: 'passed', devStagingCiUrl: null, devStagingLiveAt: '2026-11-12 16:00:00', devProdSqlStatus: null,
    devProdSqlResult: null, devProdApprovedAt: null, devProofRunId: null, devProofImagesAt: null, ...over,
});
const rowAnswer = (r: ProofRow) => (q: string) => (/FROM issue_reports WHERE id/.test(q) ? [{
    id: r.id, dev_pr_url: r.devPrUrl, dev_sql: r.devSql, dev_sql_status: r.devSqlStatus, dev_merge_status: r.devMergeStatus,
    dev_prod_status: r.devProdStatus, dev_root_cause_status: r.devRootCauseStatus, dev_root_cause: r.devRootCause,
    dev_repro: r.devRepro, dev_sql_safety: r.devSqlSafety, dev_sql_hash: r.devSqlHash, dev_staging_sql_status: r.devStagingSqlStatus,
    dev_staging_sql_result: r.devStagingSqlResult, dev_staging_sql_hash: r.devStagingSqlHash, dev_staging_ci_status: r.devStagingCiStatus,
    dev_staging_ci_url: r.devStagingCiUrl, dev_staging_live_at: r.devStagingLiveAt, dev_prod_sql_status: r.devProdSqlStatus,
    dev_prod_sql_result: r.devProdSqlResult, dev_prod_approved_at: r.devProdApprovedAt, dev_proof_run_id: r.devProofRunId, dev_proof_images_at: r.devProofImagesAt,
}] : /RETURNING id/.test(q) ? [{ id: r.id }] : []);
const prodUrls = { staging: 'stg', production: 'prod', onProdSite: true };

(async () => {
    await check('parseProof reads the block; garbage or no block → null', () => {
        const p = parseProof(body(proofOf(1, 0)));
        assert.strictEqual(p?.repro.test, 'tests/repro-issue-42.test.ts');
        assert.strictEqual(p?.runId, 123);
        assert.strictEqual(parseProof('no block'), null);
        assert.strictEqual(parseProof(`${PROOF_START}{not json${PROOF_END}`), null);
    });

    await check('confirmed ONLY when the repro failed before and passes after, with no flags', () => {
        assert.strictEqual(rootCauseStatus(parseProof(body(proofOf(1, 0)))), 'confirmed');
        assert.strictEqual(rootCauseStatus(parseProof(body(proofOf(0, 0)))), 'guessed');            // never reproduced
        assert.strictEqual(rootCauseStatus(parseProof(body(proofOf(1, 0, { flags: ['source_scan'] })))), 'guessed');
        assert.strictEqual(rootCauseStatus(parseProof(body(proofOf(1, 0, { flags: ['missing_code'] })))), 'guessed');
        assert.strictEqual(rootCauseStatus(parseProof(body({ ...proofOf(null, null, { test: null }), claimed: 'unsure' }))), 'not_found');
        assert.strictEqual(rootCauseStatus(null), 'not_found');
    });

    await check('checklist: all green → ready, no warnings', () => {
        const c = productionChecklist(baseRow());
        assert.strictEqual(c.ready, true);
        assert.strictEqual(c.warnings, false);
        assert.deepStrictEqual(c.items.map((i) => i.key), ['root_cause', 'repro', 'sql_safety', 'sql_staging', 'tests_staging', 'live_staging']);
    });

    await check('checklist: a guessed cause is a warning, not a block; staging gaps block', () => {
        const g = productionChecklist(baseRow({ devRootCauseStatus: 'guessed', devRepro: { test: null, kind: null, before: null, after: null } }));
        assert.strictEqual(g.ready, true);
        assert.strictEqual(g.warnings, true);
        assert.strictEqual(productionChecklist(baseRow({ devStagingCiStatus: 'failed' })).ready, false);
        assert.strictEqual(productionChecklist(baseRow({ devStagingLiveAt: null })).ready, false);
        assert.strictEqual(productionChecklist(baseRow({ devMergeStatus: 'ready' })).ready, false);
        assert.strictEqual(productionChecklist(baseRow({ devSql: 'UPDATE t SET a = 1', devSqlSafety: 'manual' })).ready, false);
        const sqlText = 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text';
        assert.strictEqual(productionChecklist(baseRow({ devSql: sqlText, devSqlSafety: 'additive' })).ready, false);
        assert.strictEqual(productionChecklist(baseRow({ devSql: sqlText, devSqlSafety: 'additive', devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash(sqlText) })).ready, true);
    });

    await check('ensureStagingSql: additive SQL runs on STAGING once; manual SQL waits for Run SQL', async () => {
        resetProofColumnsCache();
        const sqlText = 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text';
        const ranOn: string[] = [];
        const run = async (url: any, _s: string, where: any) => { ranOn.push(`${where}:${url}`); return { ok: true, outcome: '✓ Applied on staging.' }; };
        const db = fakeDb(rowAnswer(baseRow({ devMergeStatus: 'ready', devSql: sqlText, devSqlStatus: 'pending' })));
        assert.strictEqual(await ensureStagingSql(db, 42, { run, urls: prodUrls }), null);
        assert.deepStrictEqual(ranOn, ['staging:stg']);
        assert.ok(db.ran.some((r: any) => /dev_staging_sql_status/.test(r.q) && r.params.includes(sqlHash(sqlText))));

        const done = fakeDb(rowAnswer(baseRow({ devSql: sqlText, devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash(sqlText) })));
        assert.strictEqual(await ensureStagingSql(done, 42, { run, urls: prodUrls }), null);
        assert.strictEqual(ranOn.length, 1, 'not run twice');

        const manual = fakeDb(rowAnswer(baseRow({ devSql: 'UPDATE t SET a = 1', devSqlStatus: 'pending' })));
        assert.match(String(await ensureStagingSql(manual, 42, { run, urls: prodUrls })), /not additive/);
        const failing = fakeDb(rowAnswer(baseRow({ devSql: sqlText, devSqlStatus: 'pending' })));
        assert.match(String(await ensureStagingSql(failing, 42, { run: async () => ({ ok: false, outcome: '✗ boom' }), urls: prodUrls })), /nothing was merged/);
    });

    await check('approve: only on the prod site, only when ready, asks twice on warnings', async () => {
        const dispatch = async () => null;
        const db = fakeDb(rowAnswer(baseRow()));
        const off = await approveForProduction(db, 42, 1, { dispatch, urls: { staging: 'own', production: undefined, onProdSite: false } });
        assert.strictEqual(off.ok, false);
        const notReady = await approveForProduction(fakeDb(rowAnswer(baseRow({ devStagingCiStatus: 'pending' }))), 42, 1, { dispatch, urls: prodUrls });
        assert.match((notReady as any).error, /Not ready/);
        const warn = await approveForProduction(fakeDb(rowAnswer(baseRow({ devRootCauseStatus: 'guessed' }))), 42, 1, { dispatch, urls: prodUrls });
        assert.strictEqual((warn as any).needsConfirm, true);
    });

    await check('approve: prod SQL (same hash) runs BEFORE the hotfix starts, with auto-merge', async () => {
        const sqlText = 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text';
        const order: string[] = [];
        const db = fakeDb(rowAnswer(baseRow({ devSql: sqlText, devSqlSafety: 'additive', devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash(sqlText) })));
        const r = await approveForProduction(db, 42, 7, {
            urls: prodUrls,
            run: async (url: any, _s: string, where: any) => { order.push(`sql:${where}:${url}`); return { ok: true, outcome: '✓ Applied on production.' }; },
            dispatch: async (o) => { order.push(`hotfix:${o.fixPr}:${o.autoMerge}`); return null; },
        });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(order, ['sql:production:prod', 'hotfix:562:true']);
    });

    await check('approve: a failed prod SQL or a changed SQL text merges nothing', async () => {
        const sqlText = 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text';
        let dispatched = 0;
        const dispatch = async () => { dispatched++; return null; };
        const failing = fakeDb(rowAnswer(baseRow({ devSql: sqlText, devSqlSafety: 'additive', devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash(sqlText) })));
        const r1 = await approveForProduction(failing, 42, 7, { urls: prodUrls, dispatch, run: async () => ({ ok: false, outcome: '✗ Failed on production: boom' }) });
        assert.strictEqual(r1.ok, false);
        assert.ok(failing.ran.some((x: any) => /dev_prod_status = 'failed'/.test(x.q)), 'marked failed and released');
        const changed = fakeDb(rowAnswer(baseRow({ devSql: sqlText + ', ADD COLUMN IF NOT EXISTS b text', devSqlSafety: 'additive', devStagingSqlStatus: 'applied', devStagingSqlHash: sqlHash(sqlText) })));
        const r2 = await approveForProduction(changed, 42, 7, { urls: prodUrls, dispatch, run: async () => ({ ok: true, outcome: 'x' }) });
        assert.strictEqual(r2.ok, false);
        assert.strictEqual(dispatched, 0);
    });

    await check('approve: a second click while one is on its way is refused (claim)', async () => {
        const db = fakeDb((q) => (/RETURNING id/.test(q) ? [] : rowAnswer(baseRow())(q)));
        const r = await approveForProduction(db, 42, 7, { urls: prodUrls, dispatch: async () => null });
        assert.match((r as any).error, /already approved/);
    });

    await check('unzip reads stored and deflated entries (an Actions artifact)', () => {
        const entries = [{ name: 'shots/before-1.png', data: Buffer.from('PNGDATA-before'), deflate: true }, { name: 'repro.json', data: Buffer.from('{}'), deflate: false }];
        const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
        for (const e of entries) {
            const comp = e.deflate ? deflateRawSync(e.data) : e.data;
            const name = Buffer.from(e.name);
            const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(e.deflate ? 8 : 0, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
            const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.deflate ? 8 : 0, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
            locals.push(lh, name, comp); centrals.push(ch, name); offset += 30 + name.length + comp.length;
        }
        const cd = Buffer.concat(centrals);
        const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
        const files = unzip(Buffer.concat([...locals, cd, eocd]));
        assert.strictEqual(files.get('shots/before-1.png')?.toString(), 'PNGDATA-before');
        assert.strictEqual(files.get('repro.json')?.toString(), '{}');
    });

    await check('staging CI: both required checks green → passed; newest run wins; any red → failed', async () => {
        const answer = (runs: unknown[]) => async () => ({ ok: true, status: 200, json: async () => ({ check_runs: runs }) });
        const ok = await stagingCiState({ sha: 'a'.repeat(40), token: 't', fetchImpl: answer([
            { name: 'Typecheck + tests', status: 'completed', conclusion: 'failure', started_at: '2026-11-12T10:00:00Z', html_url: 'u1' },
            { name: 'Typecheck + tests', status: 'completed', conclusion: 'success', started_at: '2026-11-12T11:00:00Z', html_url: 'u2' },
            { name: 'RLS tenant-isolation (Postgres)', status: 'completed', conclusion: 'success', started_at: '2026-11-12T11:00:00Z' },
        ]) as any });
        assert.deepStrictEqual(ok, { state: 'passed', url: 'u2' });
        const pending = await stagingCiState({ sha: 'a'.repeat(40), token: 't', fetchImpl: answer([{ name: 'Typecheck + tests', status: 'in_progress', started_at: 'x' }]) as any });
        assert.strictEqual((pending as any).state, 'pending');
        const red = await stagingCiState({ sha: 'a'.repeat(40), token: 't', fetchImpl: answer([
            { name: 'Typecheck + tests', status: 'completed', conclusion: 'success', started_at: 'x' },
            { name: 'RLS tenant-isolation (Postgres)', status: 'completed', conclusion: 'failure', started_at: 'x', html_url: 'bad' },
        ]) as any });
        assert.deepStrictEqual(red, { state: 'failed', url: 'bad' });
    });

    console.log(`\nissue-fix-proof: ${passed} passed`);
})();
