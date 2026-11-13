// tests/pr-approval.test.ts
// Staging / prod PR pills and the owner's Approve button (owner, 2026-11-13; src/utils/pr-approval.ts).
// Pins: approve-then-merge on GitHub (own-PR review refusal never blocks; checks running → auto-merge; closed /
// conflict / bad token are errors), the click claims the request (button hidden) and restores it on failure, a
// fix's SQL must be on the target DB first, and each kind of ticket moves on WITHOUT telling a customer.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { approveAndMergePr, approveTicketPr, hotfixUrlFromResult, loadPrFields, resetPrApprovalCache } from '../src/utils/pr-approval';
import { resetProofColumnsCache } from '../src/utils/issue-fix-proof';

const dialect = new PgDialect();
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const PR = 'https://github.com/mefenemer/Be-More-Swan/pull/570';
type Call = { url: string; method: string; body?: any };
/** GitHub: the PR (open into `base` unless told), then review / merge / graphql answers. */
function fakeGh(o: { base?: string; state?: string; merged?: boolean; review?: number; merge?: number; graphqlErr?: string; prStatus?: number } = {}) {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: any = {}) => {
        const method = init.method || 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
        const res = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
        if (url.endsWith('/graphql')) return res(200, o.graphqlErr ? { errors: [{ message: o.graphqlErr }] } : { data: { enablePullRequestAutoMerge: { pullRequest: { number: 570 } } } });
        if (url.endsWith('/reviews')) return res(o.review ?? 422, { message: 'Can not approve your own pull request' });
        if (url.endsWith('/merge')) return res(o.merge ?? 200, { merged: (o.merge ?? 200) === 200, message: o.merge === 405 ? 'Required status check is expected.' : '' });
        if (o.prStatus) return res(o.prStatus, {});
        return res(200, { number: 570, html_url: PR, state: o.state || 'open', merged_at: o.merged ? '2026-11-13T10:00:00Z' : null, base: { ref: o.base || 'main' }, node_id: 'PR_node', title: 't' });
    };
    return { calls, fetchImpl };
}

/** A db that answers by SQL text and records every statement. */
function fakeDb(opts: { approval?: string | null; ready?: boolean; claim?: boolean; proof?: Record<string, unknown> | null } = {}) {
    const ran: Array<{ q: string; params: unknown[] }> = [];
    return {
        ran,
        execute: async (s: any) => {
            const { sql: q, params } = dialect.sqlToQuery(s);
            ran.push({ q, params });
            if (/information_schema\.columns/.test(q)) {
                if (/approval_pr_url/.test(q)) return [{ n: opts.ready === false ? 0 : 2 }];
                return opts.proof === null ? [] : [{ '?column?': 1 }];
            }
            if (/SELECT approval_pr_url, approval_note FROM/.test(q)) return [{ approval_pr_url: opts.approval === undefined ? PR : opts.approval, approval_note: null }];
            if (/SET approval_pr_url = NULL WHERE/.test(q)) return opts.claim === false ? [] : [{ id: 7 }];
            if (/FROM issue_reports WHERE id/.test(q) && /dev_sql/.test(q)) return opts.proof ? [{ id: 7, ...opts.proof }] : [];
            return [];
        },
    } as any;
}
const reset = () => { resetPrApprovalCache(); resetProofColumnsCache(); };

(async () => {
    await check('GitHub: own-PR review refused (422) still merges', async () => {
        const gh = fakeGh();
        const r = await approveAndMergePr({ prNumber: 570, token: 't', fetchImpl: gh.fetchImpl as any });
        assert.ok(r.ok && r.merged && !r.autoMerge && !r.reviewed);
        assert.deepStrictEqual(gh.calls.map((c) => c.method), ['GET', 'POST', 'PUT']);
        assert.strictEqual(gh.calls[1].body.event, 'APPROVE');
        assert.strictEqual(gh.calls[2].body.merge_method, 'merge');
    });
    await check('GitHub: checks still running (405) → auto-merge on', async () => {
        const gh = fakeGh({ merge: 405, review: 200 });
        const r = await approveAndMergePr({ prNumber: 570, token: 't', fetchImpl: gh.fetchImpl as any });
        assert.ok(r.ok && !r.merged && r.autoMerge && r.reviewed);
        assert.match(gh.calls[3].body.query, /enablePullRequestAutoMerge/);
        assert.strictEqual(gh.calls[3].body.variables.id, 'PR_node');
    });
    await check('GitHub: already merged = success with no writes', async () => {
        const gh = fakeGh({ merged: true, state: 'closed' });
        const r = await approveAndMergePr({ prNumber: 570, token: 't', fetchImpl: gh.fetchImpl as any });
        assert.ok(r.ok && r.merged);
        assert.strictEqual(gh.calls.length, 1);
    });
    await check('GitHub: closed, conflict, bad token, auto-merge refused → errors', async () => {
        for (const [o, re] of [[{ state: 'closed' }, /closed without merging/], [{ merge: 409 }, /merge conflict/], [{ merge: 403 }, /Contents and Pull requests/],
            [{ prStatus: 404 }, /GITHUB_PR_APPROVE_TOKEN/], [{ merge: 405, graphqlErr: 'Auto merge is not allowed' }, /Auto merge is not allowed/]] as const) {
            const r = await approveAndMergePr({ prNumber: 570, token: 't', fetchImpl: fakeGh(o as any).fetchImpl as any });
            assert.ok(!r.ok); assert.match(r.error, re);
        }
    });

    await check('hotfix PR url from dev_prod_result', () => {
        assert.strictEqual(hotfixUrlFromResult(`Hotfix PR: ${PR}\nOpen — review`), PR);
        assert.strictEqual(hotfixUrlFromResult('nothing'), null);
    });

    await check('nothing asked → refused, no GitHub call', async () => {
        reset();
        const gh = fakeGh();
        const r = await approveTicketPr(fakeDb({ approval: null }), 'feature', 7, { token: 't', fetchImpl: gh.fetchImpl as any });
        assert.ok(!r.ok && r.status === 409);
        assert.strictEqual(gh.calls.length, 0);
    });
    await check('before the SQL → asks for db/z-pr-approval.sql', async () => {
        reset();
        const r = await approveTicketPr(fakeDb({ ready: false }), 'issue', 7, { token: 't', fetchImpl: fakeGh().fetchImpl as any });
        assert.ok(!r.ok); assert.match(r.error, /z-pr-approval\.sql/);
    });
    await check('double click: second claim loses, no merge', async () => {
        reset();
        const gh = fakeGh();
        const r = await approveTicketPr(fakeDb({ claim: false }), 'feature', 7, { token: 't', fetchImpl: gh.fetchImpl as any });
        assert.ok(!r.ok && r.status === 409);
        assert.strictEqual(gh.calls.length, 0);
    });

    await check('feature, prod PR: merged → Released, prod_pr_url set, request cleared, NO broadcast', async () => {
        reset();
        const db = fakeDb();
        const r = await approveTicketPr(db, 'feature', 7, { token: 't', fetchImpl: fakeGh({ base: 'main' }).fetchImpl as any });
        assert.ok(r.ok && r.merged && r.base === 'main');
        const upd = db.ran.find((x: any) => /status = 'released'/.test(x.q));
        assert.ok(upd, 'moved to released');
        assert.match(upd.q, /prod_pr_url = \$1/);
        assert.match(upd.q, /approval_requested_at = NULL/);
        assert.ok(db.ran.some((x: any) => /dev_notes = concat_ws/.test(x.q)));
        assert.ok(!db.ran.some((x: any) => /notifications|feature_request_votes/.test(x.q)));
    });
    await check('feature, GitHub fails → the request is put back (button returns)', async () => {
        reset();
        const db = fakeDb();
        const r = await approveTicketPr(db, 'feature', 7, { token: 't', fetchImpl: fakeGh({ merge: 409 }).fetchImpl as any });
        assert.ok(!r.ok);
        assert.ok(db.ran.some((x: any) => /SET approval_pr_url = \$1 WHERE id = \$2 AND approval_pr_url IS NULL/.test(x.q)));
        assert.ok(!db.ran.some((x: any) => /status = 'released'/.test(x.q)));
    });

    await check('issue, staging PR: SQL not on staging → blocked before any merge', async () => {
        reset();
        const db = fakeDb({ proof: { dev_sql: 'ALTER TABLE x ADD COLUMN IF NOT EXISTS y int', dev_staging_sql_status: null } });
        const gh = fakeGh({ base: 'staging' });
        const r = await approveTicketPr(db, 'issue', 7, { token: 't', fetchImpl: gh.fetchImpl as any });
        assert.ok(!r.ok); assert.match(r.error, /staging database/);
        assert.ok(!gh.calls.some((c) => c.method === 'PUT'));
    });
    await check('issue, prod PR: prod SQL not run → blocked', async () => {
        reset();
        const db = fakeDb({ proof: { dev_sql: 'ALTER TABLE x ADD COLUMN IF NOT EXISTS y int', dev_prod_sql_status: null } });
        const r = await approveTicketPr(db, 'issue', 7, { token: 't', fetchImpl: fakeGh({ base: 'main' }).fetchImpl as any });
        assert.ok(!r.ok); assert.match(r.error, /production database/);
    });
    await check('issue, staging PR, no SQL → merged to staging, internal note only', async () => {
        reset();
        const db = fakeDb({ proof: { dev_sql: null } });
        const r = await approveTicketPr(db, 'issue', 7, { token: 't', fetchImpl: fakeGh({ base: 'staging' }).fetchImpl as any });
        assert.ok(r.ok && r.base === 'staging');
        assert.ok(db.ran.some((x: any) => /dev_merge_status = 'merged'/.test(x.q)));
        const msg = db.ran.find((x: any) => /INSERT INTO issue_report_messages/.test(x.q));
        assert.match(msg.q, /'admin', NULL,/, 'author_id NULL: the reporter never sees it');
    });
    await check('issue, prod PR, no SQL → promoted with prod_pr_url', async () => {
        reset();
        const db = fakeDb({ proof: { dev_sql: null } });
        const r = await approveTicketPr(db, 'issue', 7, { token: 't', fetchImpl: fakeGh({ base: 'main' }).fetchImpl as any });
        assert.ok(r.ok);
        const upd = db.ran.find((x: any) => /dev_prod_status = 'promoted'/.test(x.q));
        assert.ok(upd); assert.match(upd.q, /prod_pr_url = \$1/);
    });

    await check('loadPrFields: hotfix PR counts as the prod PR', async () => {
        reset();
        const db = {
            execute: async (s: any) => {
                const { sql: q } = dialect.sqlToQuery(s);
                if (/information_schema/.test(q)) return [{ n: 2 }];
                return [{ id: 3, prod_pr_url: null, dev_prod_result: `Hotfix PR: ${PR}\nOpen`, approval_pr_url: PR, approval_note: 'n', approval_requested_at: 'x' }];
            },
        } as any;
        const m = await loadPrFields(db, 'issue', [3]);
        assert.deepStrictEqual(m.get(3), { prodPrUrl: PR, approvalPrUrl: PR, approvalNote: 'n', approvalRequestedAt: 'x' });
    });

    await check('admin.html: pills + Approve on both boards and panels; endpoints wired', () => {
        const html = readFileSync('admin.html', 'utf8');
        assert.ok(html.includes("prPills(i.devPrUrl, i.prodPrUrl)"), 'fix board card pills');
        assert.ok(html.includes("prApproveButton('issue', i, false)"), 'fix board card approve');
        assert.ok(html.includes("${prBlock('issue', i)}"), 'fix panel block');
        assert.ok(html.includes("prPills(it.devPrUrl, it.prodPrUrl)"), 'feature card pills');
        assert.ok(html.includes("prApproveButton('feature', it, false)"), 'feature card approve');
        assert.ok(html.includes("const pr = prBlock('feature', it);"), 'feature panel block');
        assert.ok(html.includes('action=approve-pr'));
        for (const f of ['netlify/functions/admin-issue-reports.ts', 'netlify/functions/admin-feature-requests.ts']) {
            const src = readFileSync(f, 'utf8');
            assert.ok(src.includes("action === 'approve-pr'"), f);
            assert.ok(src.includes('loadPrFields('), f);
        }
    });

    console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}.`);
})();
