// tests/feature-reopen-on-pr.test.ts
// A Released feature request that gets another PR (its next phase) goes back to In progress, and the live
// check releases it again only once the deploy contains the NEW work.
//
// What went wrong (FR#43 Phase 2, 2026-11-16): `feature-requests.ts pr` cleared live_at but left the
// request Released, and runFeatureLiveCheck only looks at requests that are NOT Released — so "Live on
// production" said "Not in main yet" for ever. The first fix (PR #704, reviewer: Changes needed) reopened it
// but kept prod_pr_url: the live check tries that FIRST, and the previous phase's release PR is already in
// main, so the request would have been released the moment the new PR reached staging.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resetFeatureForNewPr, resetFeatureProofCache, runFeatureLiveCheck } from '../src/utils/feature-proof';

const dialect = new PgDialect();
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const OLD_RELEASE = 'https://github.com/mefenemer/Be-More-Swan/pull/628';   // previous phase, already in main
const NEW_PR = 'https://github.com/mefenemer/Be-More-Swan/pull/635';        // next phase, only on staging
const SHA = 'a'.repeat(40);

/** A db answering by SQL text. `was` = the request's status before the reset (null = no such request). */
function fakeDb(o: { was?: string | null; live?: Array<Record<string, unknown>> } = {}) {
    const ran: Array<{ q: string; params: unknown[] }> = [];
    return {
        ran,
        execute: async (s: any) => {
            const { sql: q, params } = dialect.sqlToQuery(s);
            ran.push({ q, params });
            if (/RETURNING old\.status AS was/.test(q)) return o.was ? [{ was: o.was }] : [];
            if (/information_schema\.columns/.test(q)) return [{ '?column?': 1 }];
            if (/WHERE dev_merged_at > now\(\)/.test(q)) return [];
            if (/WHERE live_at IS NULL AND status NOT IN/.test(q) && /^select/i.test(q.trim())) return o.live || [];
            if (/SET status = 'released'/.test(q)) return [{ id: 43 }];
            return [];
        },
    } as any;
}
/** GitHub: every PR is merged; the deploy contains a PR only if it is in `inDeploy`. */
function fakeGh(inDeploy: string[]) {
    return async (url: string) => {
        const res = (status: number, body: any) => ({ ok: true, status, json: async () => body });
        const pr = /\/pulls\/(\d+)/.exec(url)?.[1];
        if (pr) return res(200, { merged: true, merge_commit_sha: (inDeploy.some((u) => u.endsWith(`/${pr}`)) ? 'c' : 'd').repeat(40) });
        if (/\/compare\//.test(url)) return res(200, { status: /c{40}/.test(url) ? 'ahead' : 'behind' });
        return res(404, {});
    };
}

(async () => {
    await check('a Released request is reopened, in ONE statement that also clears live_at and the old prod PR', async () => {
        const db = fakeDb({ was: 'released' });
        const r = await resetFeatureForNewPr(db, 43, { sqlText: null, safety: 'none' as any });
        assert.deepStrictEqual(r, { found: true, reopened: true });
        assert.strictEqual(db.ran.length, 1, 'read-and-update is one statement — no race between them');
        const q = db.ran[0].q;
        assert.ok(/FOR UPDATE/.test(q));
        assert.ok(/prod_pr_url = NULL/.test(q) && /live_at = NULL/.test(q) && /dev_prod_merged_at = NULL/.test(q));
        assert.ok(q.includes("status = CASE WHEN old.status = 'released' THEN 'in_progress' ELSE f.status END"));
    });

    await check('in progress, declined and duplicate keep their status; a missing request is reported', async () => {
        for (const was of ['in_progress', 'declined', 'duplicate']) {
            assert.deepStrictEqual(await resetFeatureForNewPr(fakeDb({ was }), 43, { sqlText: null, safety: 'none' as any }), { found: true, reopened: false });
        }
        assert.deepStrictEqual(await resetFeatureForNewPr(fakeDb({ was: null }), 43, { sqlText: null, safety: 'none' as any }), { found: false, reopened: false });
    });

    await check('the reviewer\'s case: after the reset, the new PR on staging only is NOT released — the old release PR no longer counts', async () => {
        resetFeatureProofCache();
        // The row as the reset leaves it: prod_pr_url cleared, the new PR merged to staging.
        const db = fakeDb({ live: [{ id: 43, dev_pr_url: NEW_PR, prod_pr_url: null }] });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh([OLD_RELEASE]) as any });
        assert.strictEqual(r.released, 0);
        assert.ok(!db.ran.some((x: any) => /SET status = 'released'/.test(x.q)));
    });

    await check('…and it IS released once the deploy contains the new work', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [{ id: 43, dev_pr_url: NEW_PR, prod_pr_url: null }] });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh([OLD_RELEASE, NEW_PR]) as any });
        assert.strictEqual(r.released, 1);
    });

    await check('why prod_pr_url must go: kept, the old release PR alone would have released it too early', async () => {
        resetFeatureProofCache();
        const db = fakeDb({ live: [{ id: 43, dev_pr_url: NEW_PR, prod_pr_url: OLD_RELEASE }] });
        const r = await runFeatureLiveCheck(db, { deployedSha: SHA, token: 't', fetchImpl: fakeGh([OLD_RELEASE]) as any });
        assert.strictEqual(r.released, 1, 'this is the bug the reset prevents');
    });

    await check('the pr command uses the reset and notes a reopen (no one notified)', () => {
        const s = readFileSync('scripts/feature-requests.ts', 'utf8');
        const block = s.slice(s.indexOf("} else if (cmd === 'pr') {"), s.indexOf("} else if (cmd === 'staging-sql') {"));
        assert.ok(block.includes('await resetFeatureForNewPr(db, id, { sqlText, safety })'));
        assert.ok(/if \(reopened\) \{\s*await note\('Reopened:[^']*No one was notified\.'\)/.test(block));
        assert.ok(!/UPDATE feature_requests SET dev_sql/.test(block), 'the reset lives in one place');
    });

    console.log(`\n${passed} checks passed.`);
})();
