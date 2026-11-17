// tests/pr-approvals.test.ts
// Review tiers Phase 3 (owner, 2026-11-17; docs/review-tiers-plan.md): the approval record, the merge sweep,
// pinning EVERY approval request to a commit, the honest note on PRs into main, and the "Merge to staging"
// buttons running the same review gate (fail closed). From review round 4 on #682 (f452fb3).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { formatReviewComment, pinnedShaFromNote, reviewGate } from '../src/utils/pr-review';
import { addedLinesFromPatch, cloudMergeCheck, cloudMergeReviewBlocker, loadRemotePr } from '../src/utils/pr-review-remote';
import { dispatchCloudMerge } from '../src/utils/issue-cloud-merge';
import { approvalFlag, approvalFromRemote, resetPrApprovalsCache, sweepMergedPrs, REVIEWS_BEGAN_AT } from '../src/utils/pr-approvals';

const dialect = new PgDialect();
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const res = (status: number, body: any = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const review = (sha: string, verdict: 'pass' | 'notes' | 'changes', assoc = 'OWNER', at = '2026-11-17T13:00:00Z') =>
    ({ body: formatReviewComment({ sha, verdict, tier: 'medium', findings: verdict === 'pass' ? '' : '1. something real' }), created_at: at, html_url: `https://github.com/o/r/pull/9#c${at}`, author_association: assoc });

/** GitHub with one PR (#9) and a list of merged PRs per base. */
function fakeGitHub(o: { files?: any[]; comments?: any[]; head?: string; base?: string; merged?: boolean; prStatus?: number; filesStatus?: number; lists?: Record<string, any[]> } = {}) {
    const calls: string[] = [];
    const f = async (url: string) => {
        calls.push(url);
        const u = new URL(url);
        if (/\/pulls$/.test(u.pathname)) return res(200, o.lists?.[u.searchParams.get('base') || ''] || []);
        if (/\/pulls\/\d+\/files$/.test(u.pathname)) return o.filesStatus ? res(o.filesStatus) : res(200, Number(u.searchParams.get('page')) > 1 ? [] : (o.files ?? [{ filename: 'src/utils/foo.ts', patch: '@@\n+x' }]));
        if (/\/issues\/\d+\/comments$/.test(u.pathname)) return res(200, Number(u.searchParams.get('page')) > 1 ? [] : (o.comments ?? []));
        if (/\/pulls\/\d+$/.test(u.pathname)) return o.prStatus ? res(o.prStatus) : res(200, { number: Number(u.pathname.split('/').pop()), title: 'T', html_url: 'https://github.com/o/r/pull/9', base: { ref: o.base ?? 'staging' }, head: { sha: o.head ?? A }, merged_at: o.merged ? '2026-11-18T09:00:00Z' : null, merge_commit_sha: 'c'.repeat(40) });
        return res(404);
    };
    return { f, calls };
}

(async () => {
    await check('EVERY request is pinned: low tier and PRs into main carry "approved commit <head>"', () => {
        const low = reviewGate({ tier: 'low', base: 'staging', headSha: A, reviews: [] });
        assert.strictEqual(low.pinSha, A);
        assert.strictEqual(pinnedShaFromNote(low.summary), A);
        const main = reviewGate({ tier: 'high', base: 'main', headSha: B, reviews: [] });
        assert.strictEqual(pinnedShaFromNote(main.summary), B);
        assert.match(main.summary, /Admin → Systems → Approvals flags any merged without one/);
        assert.doesNotMatch(main.summary, /each change was reviewed/, 'must not claim every staging PR was reviewed');
    });

    await check('a GitHub patch gives the lines it adds; no patch = unknown', () => {
        assert.strictEqual(addedLinesFromPatch('@@ -1 +1 @@\n-old\n+new\n context'), 'new');
        assert.strictEqual(addedLinesFromPatch(undefined), null);
    });

    await check('remote PR: tier from files (renames by both paths, SQL by added lines), only trusted verdicts', async () => {
        const gh = fakeGitHub({
            files: [
                { filename: 'src/utils/money.ts', previous_filename: 'src/utils/stripe.ts', patch: '' },
                { filename: 'db/z-x.sql', patch: '@@\n+ALTER TABLE foo ADD COLUMN IF NOT EXISTS bar text;' },
            ],
            comments: [review(A, 'changes'), review(A, 'pass', 'NONE', '2026-11-17T14:00:00Z')],
        });
        const pr = await loadRemotePr(9, { token: 't', repo: 'o/r', fetchImpl: gh.f });
        assert.ok(!('error' in pr));
        if ('error' in pr) return;
        assert.strictEqual(pr.tier.tier, 'high', 'stripe.ts renamed away is still high');
        assert.deepStrictEqual(pr.reviews.map((r) => r.verdict), ['changes'], "an outsider's Pass is ignored");
        const sqlOnly = await loadRemotePr(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ files: [{ filename: 'db/z-x.sql', patch: '@@\n+DROP TABLE foo;' }] }).f });
        assert.strictEqual(!('error' in sqlOnly) && sqlOnly.tier.tier, 'high');
    });

    await check('Merge to staging: medium PR with no review is refused; a passing review for head lets it go', async () => {
        const none = await cloudMergeReviewBlocker(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub().f });
        assert.match(String(none), /^Not merged: A medium tier PR needs a second-opinion review/);
        assert.strictEqual(await cloudMergeReviewBlocker(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ comments: [review(A, 'pass')] }).f }), null);
        const stale = await cloudMergeReviewBlocker(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ head: B, comments: [review(A, 'pass')] }).f });
        assert.match(String(stale), /changed after its review/);
        assert.strictEqual(await cloudMergeReviewBlocker(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ files: [{ filename: 'docs/a.md', patch: '+x' }] }).f }), null, 'low tier needs none');
    });

    await check('Merge to staging fails CLOSED: no token or GitHub trouble = not merged, with the reason', async () => {
        const saved = { ...process.env };
        for (const k of ['GITHUB_FIX_CHECK_TOKEN', 'GITHUB_AI_FIX_TOKEN', 'GITHUB_HOTFIX_TOKEN', 'GITHUB_PR_APPROVE_TOKEN', 'MERGE_PR_TOKEN']) delete process.env[k];
        try {
            assert.match(String(await cloudMergeReviewBlocker(9, { fetchImpl: fakeGitHub().f })), /could not be checked/);
        } finally { Object.assign(process.env, saved); }
        assert.match(String(await cloudMergeReviewBlocker(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ prStatus: 500 }).f })), /could not be checked.*HTTP 500/);
        assert.match(String(await cloudMergeReviewBlocker(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ filesStatus: 403 }).f })), /could not be checked.*files/);
    });

    await check('Merge to staging passes the gated commit to the workflow, which merges only that commit', async () => {
        const ok = await cloudMergeCheck(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ comments: [review(A, 'pass')] }).f });
        assert.deepStrictEqual(ok, { blocked: null, headSha: A });
        const no = await cloudMergeCheck(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub().f });
        assert.strictEqual(no.headSha, null);
        let body: any = null;
        assert.strictEqual(await dispatchCloudMerge({ issueId: 4, pr: 9, headSha: A, token: 't', fetchImpl: async (_u, init) => { body = JSON.parse(String(init?.body)); return res(204); } }), null);
        assert.deepStrictEqual(body.inputs, { issue_id: '4', pr: '9', head_sha: A });
        const wf = readFileSync('.github/workflows/merge-to-staging.yml', 'utf8');
        assert.ok(/head_sha:\n\s+description: .*\n\s+required: false/.test(wf), 'optional input, so older dispatches still work');
        assert.ok(wf.includes('HEAD_SHA: ${{ inputs.head_sha }}'), 'input via env, never ${{ }} inside the script');
        assert.ok(wf.includes('! "$HEAD_SHA" =~ ^[0-9a-f]{40}$'), 'validated');
        assert.ok(wf.includes('match=(--match-head-commit "$HEAD_SHA")') && wf.includes('--delete-branch ${match[@]+"${match[@]}"}'));
    });

    await check('approval flag: only medium/high into staging after reviews began can be flagged', () => {
        const base = { base: 'staging', tier: 'medium' as const, headSha: A, reviewerVerdict: 'pass' as const, reviewerSha: A, mergedAt: '2026-11-18T09:00:00.000Z' };
        assert.strictEqual(approvalFlag(base), 'ok');
        assert.strictEqual(approvalFlag({ ...base, reviewerVerdict: 'notes' }), 'ok');
        assert.strictEqual(approvalFlag({ ...base, reviewerVerdict: null, reviewerSha: null }), 'no-review');
        assert.strictEqual(approvalFlag({ ...base, reviewerSha: B }), 'stale-review');
        assert.strictEqual(approvalFlag({ ...base, reviewerVerdict: 'changes' }), 'changes-needed');
        assert.strictEqual(approvalFlag({ ...base, reviewerVerdict: null, mergedAt: '2026-11-10T09:00:00.000Z' }), 'before-reviews');
        assert.ok('2026-11-10T09:00:00.000Z' < REVIEWS_BEGAN_AT);
        assert.strictEqual(approvalFlag({ ...base, tier: 'low', reviewerVerdict: null }), 'not-needed');
        assert.strictEqual(approvalFlag({ ...base, base: 'main', reviewerVerdict: null }), 'not-needed');
        assert.strictEqual(approvalFlag({ ...base, tier: null, reviewerVerdict: null }), 'pending', 'a button row before the sweep is not "no review"');
    });

    await check('a merged PR\'s row shows the verdict for its head, else the latest (read as stale)', async () => {
        const pr = await loadRemotePr(9, { token: 't', repo: 'o/r', fetchImpl: fakeGitHub({ merged: true, head: B, comments: [review(A, 'pass')] }).f });
        if ('error' in pr) throw new Error(pr.error);
        const row = approvalFromRemote(pr);
        assert.strictEqual(row.reviewerSha, A);
        assert.strictEqual(row.mergedSha, 'c'.repeat(40));
        assert.strictEqual(approvalFlag(row), 'stale-review');
    });

    await check('sweep: records merged PRs with no complete row, skips the rest, never throws', async () => {
        resetPrApprovalsCache();
        const queries: string[] = [];
        const db = {
            execute: async (q: any) => {
                const text = dialect.sqlToQuery(q).sql;
                queries.push(text);
                if (text.includes('to_regclass')) return [{ ok: true }];
                if (text.startsWith('\n            SELECT pr_number FROM pr_approvals') || text.includes('SELECT pr_number FROM pr_approvals')) return [{ pr_number: 11 }];
                return [];
            },
        } as any;
        const gh = fakeGitHub({ merged: true, lists: { staging: [{ number: 9, merged_at: 'x' }, { number: 10, merged_at: null }, { number: 11, merged_at: 'x' }], main: [] } });
        const r = await sweepMergedPrs(db, { token: 't', repo: 'o/r', fetchImpl: gh.f });
        assert.deepStrictEqual(r, { recorded: 1 });
        assert.ok(gh.calls.some((u) => u.includes('/pulls/9')), 'loads #9');
        assert.ok(!gh.calls.some((u) => /\/pulls\/1[01](\/|$|\?)/.test(u)), 'skips unmerged #10 and recorded #11');
        assert.ok(queries.some((q) => q.includes('INSERT INTO pr_approvals') && q.includes('ON CONFLICT (repo, pr_number) DO UPDATE')));
        resetPrApprovalsCache();
        const broken = { execute: async (q: any) => { if (dialect.sqlToQuery(q).sql.includes('to_regclass')) return [{ ok: true }]; throw new Error('db down'); } } as any;
        const r2 = await sweepMergedPrs(broken, { token: 't', repo: 'o/r', fetchImpl: gh.f });
        assert.strictEqual(r2.recorded, 0);
        assert.match(String(r2.skipped), /db down/);
        resetPrApprovalsCache();
    });

    await check('wiring: both Merge-to-staging paths gate, the tick sweeps, the button records, Systems lists', () => {
        const api = readFileSync('netlify/functions/admin-issue-reports.ts', 'utf8');
        assert.ok(api.includes('const err = gate.blocked || await dispatchCloudMerge({ issueId: id, pr: prNum, headSha: gate.headSha });'), 'single merge: gate, then dispatch pinned');
        assert.ok(api.includes('await Promise.all(claimed.map(async (c) =>') && api.includes('n ? await cloudMergeCheck(n) : null'), 'Merge all: gates in parallel');
        assert.ok(api.includes(': await dispatchCloudMerge({ issueId: c.id, pr: prNum, headSha: gate?.headSha });'), 'Merge all: dispatch pinned');
        assert.ok(api.includes('return json(gate.blocked ? 409 : 502, { error: err });'), 'a review refusal is 409, not a GitHub outage');
        const tick = readFileSync('netlify/functions/check-fixes-live.ts', 'utf8');
        assert.ok(tick.includes('await sweepMergedPrs(db)'));
        const approve = readFileSync('src/utils/pr-approval.ts', 'utf8');
        const i = approve.indexOf('const { pr, merged, autoMerge } = res;');
        assert.ok(i !== -1 && approve.indexOf('await recordButtonApproval(db,', i) !== -1, 'the click writes the record after a successful merge');
        assert.ok(approve.includes('expectedHeadSha: pinnedShaFromNote(row.approval_note)'));
        const status = readFileSync('netlify/functions/admin-system-status.ts', 'utf8');
        assert.ok(status.indexOf("view === 'approvals'") > status.indexOf('requireSuperAdmin(event)'), 'the list sits behind the permission check');
        const html = readFileSync('admin.html', 'utf8');
        assert.ok(html.includes('id="approvals-panel"'));
        assert.ok(html.includes("api('/.netlify/functions/admin-system-status?view=approvals')"));
        assert.ok(html.includes('data-approval-flag'));
        const sqlFile = readFileSync('db/z-pr-approvals.sql', 'utf8');
        assert.ok(/CREATE TABLE IF NOT EXISTS pr_approvals/.test(sqlFile) && /CREATE UNIQUE INDEX IF NOT EXISTS pr_approvals_repo_pr/.test(sqlFile));
    });

    console.log(`\npr-approvals: ${passed} passed`);
})();
