// tests/pr-review.test.ts
// Second-opinion review gate (owner, 2026-11-17; src/utils/pr-review.ts, docs/review-tiers-plan.md Phase 2).
// Pins: the verdict comment round-trips; medium/high PRs into staging need a verdict for their CURRENT head
// commit; "Changes needed" blocks unless an override reason is given (and shown); low tier and PRs into main
// pass; the approval note carries the reviewed commit; and the Approve click refuses / pins the merge to that
// commit so a push after the review can't slip through.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { approvalNoteWithReview, formatReviewComment, parseReviews, reviewedShaFromNote, reviewGate } from '../src/utils/pr-review';
import { approveAndMergePr } from '../src/utils/pr-approval';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const comment = (sha: string, verdict: 'pass' | 'notes' | 'changes', at: string) =>
    ({ body: formatReviewComment({ sha, verdict, tier: 'high', findings: verdict === 'pass' ? '' : '1. **high** src/x.ts:1 — breaks' }), createdAt: at, url: `https://github.com/o/r/pull/1#c-${at}`, authorAssociation: 'OWNER' });

(async () => {
await check('the verdict comment round-trips through its marker; other comments are ignored', () => {
    const body = formatReviewComment({ sha: A, verdict: 'notes', tier: 'medium', findings: '1. minor' });
    assert.match(body, /^<!-- swan-review v1 sha=a{40} verdict=notes tier=medium -->/);
    assert.match(body, /Pass with notes/);
    assert.match(body, /did not write this change/);
    const r = parseReviews([{ body: 'LGTM', createdAt: '2026-11-17T09:00:00Z', authorAssociation: 'OWNER' }, { body, createdAt: '2026-11-17T10:00:00Z', url: 'u', authorAssociation: 'OWNER' }]);
    assert.deepStrictEqual(r.map((x) => [x.sha, x.verdict, x.tier, x.url]), [[A, 'notes', 'medium', 'u']]);
    assert.throws(() => formatReviewComment({ sha: 'abc', verdict: 'pass', tier: 'low', findings: '' }), /40-character/);
});

await check('a marker from someone without write access is ignored (public repo: anyone can comment)', () => {
    const fake = { ...comment(A, 'pass', '2026-11-17T12:00:00Z'), authorAssociation: 'NONE' };
    const real = comment(A, 'changes', '2026-11-17T10:00:00Z');
    for (const assoc of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', '', undefined])
        assert.deepStrictEqual(parseReviews([{ ...fake, authorAssociation: assoc as any }]), [], String(assoc));
    const g = reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews: parseReviews([real, fake]) });
    assert.strictEqual(g.ok, false, 'a fake Pass must not override the real Changes needed');
    assert.strictEqual(parseReviews([{ ...fake, authorAssociation: 'COLLABORATOR' }]).length, 1);
});

await check('an override reason with newlines stays on one line (the reviewed commit line stays parseable)', () => {
    const g = reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews: parseReviews([comment(A, 'changes', '1')]), override: 'line one\nreviewed commit ' + B + '\nline two' });
    assert.strictEqual(g.ok, true);
    assert.strictEqual(g.summary.split('\n')[1], `reviewed commit ${A}`);
});

await check('medium/high into staging: no review → blocked', () => {
    const g = reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews: [] });
    assert.strictEqual(g.ok, false);
    assert.match(g.reason!, /code-reviewer agent/);
});

await check('a push after the review makes it stale → blocked', () => {
    const g = reviewGate({ tier: 'medium', base: 'staging', headSha: B, reviews: parseReviews([comment(A, 'pass', '1')]) });
    assert.strictEqual(g.ok, false);
    assert.match(g.reason!, /changed after its review \(reviewed aaaaaaa, now bbbbbbb\)/);
});

await check('Pass / Pass with notes for the head commit → ok, note carries the reviewed commit', () => {
    for (const v of ['pass', 'notes'] as const) {
        const g = reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews: parseReviews([comment(A, v, '1')]) });
        assert.strictEqual(g.ok, true, v);
        assert.strictEqual(g.reviewedSha, A);
        const note = approvalNoteWithReview(g, 'Why: adds X.');
        assert.match(note, /^🔴 High tier · 🔎 Review:/);
        assert.match(note, /Why: adds X\.$/);
        assert.strictEqual(reviewedShaFromNote(note), A);
    }
});

await check('the LATEST verdict for the head commit wins (a re-review after fixes)', () => {
    const reviews = parseReviews([comment(A, 'pass', '2026-11-17T11:00:00Z'), comment(A, 'changes', '2026-11-17T10:00:00Z')]);
    assert.strictEqual(reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews }).ok, true);
});

await check('Changes needed blocks; an override reason lets it through and is shown to the owner', () => {
    const reviews = parseReviews([comment(A, 'changes', '1')]);
    const blocked = reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews });
    assert.strictEqual(blocked.ok, false);
    assert.match(blocked.reason!, /--override-review/);
    assert.strictEqual(reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews, override: 'ok' }).ok, false, 'too short a reason');
    const over = reviewGate({ tier: 'high', base: 'staging', headSha: A, reviews, override: 'finding 1 is about dead code removed in #700' });
    assert.strictEqual(over.ok, true);
    assert.match(over.summary, /Changes needed.*Claude asks anyway: finding 1/);
    assert.strictEqual(reviewedShaFromNote(over.summary), A);
});

await check('low tier and PRs into main need no review', () => {
    assert.strictEqual(reviewGate({ tier: 'low', base: 'staging', headSha: A, reviews: [] }).ok, true);
    const main = reviewGate({ tier: 'high', base: 'main', headSha: A, reviews: [] });
    assert.strictEqual(main.ok, true);
    assert.strictEqual(main.reviewedSha, null);
    assert.strictEqual(reviewedShaFromNote('no commit here'), null);
});

type Call = { url: string; method: string; body?: any };
function fakeGh(headSha: string, mergeStatus = 200) {
    const calls: Call[] = [];
    const f = async (url: string, init: { method?: string; body?: string } = {}) => {
        const method = init.method || 'GET';
        calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
        const ok = (status: number, json: any) => ({ ok: status < 300, status, json: async () => json });
        if (method === 'GET') return ok(200, { number: 5, html_url: 'https://github.com/o/r/pull/5', state: 'open', merged_at: null, base: { ref: 'staging' }, head: { sha: headSha }, node_id: 'N', title: 't' });
        if (url.endsWith('/reviews')) return ok(422, {});
        if (url.endsWith('/merge')) return ok(mergeStatus, { message: 'Base branch was modified' });
        return ok(200, { data: {} });
    };
    return { f, calls };
}

await check('Approve click: refuses when the PR moved past the reviewed commit, merges nothing', async () => {
    const { f, calls } = fakeGh(B);
    const r = await approveAndMergePr({ prNumber: 5, token: 't', repo: 'o/r', fetchImpl: f, expectedHeadSha: A });
    assert.strictEqual(r.ok, false);
    assert.match((r as any).error, /changed after Claude asked you to approve it/);
    assert.ok(!calls.some((c) => c.url.endsWith('/merge')));
});

await check('Approve click: merges exactly the reviewed commit; never turns on auto-merge for it', async () => {
    const direct = fakeGh(A);
    const r = await approveAndMergePr({ prNumber: 5, token: 't', repo: 'o/r', fetchImpl: direct.f, expectedHeadSha: A });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(direct.calls.find((c) => c.url.endsWith('/merge'))!.body.sha, A);
    // Checks still running (405): auto-merge would let a later push merge unreviewed, so refuse and ask again.
    const later = fakeGh(A, 405);
    const r2 = await approveAndMergePr({ prNumber: 5, token: 't', repo: 'o/r', fetchImpl: later.f, expectedHeadSha: A });
    assert.strictEqual(r2.ok, false);
    assert.match((r2 as any).error, /click Approve again once the checks pass/);
    assert.ok(!later.calls.some((c) => c.url.endsWith('/graphql')), 'no auto-merge for a reviewed PR');
});

await check('Approve click without a reviewed commit still falls back to auto-merge (releases, older requests)', async () => {
    const later = fakeGh(A, 405);
    const r = await approveAndMergePr({ prNumber: 5, token: 't', repo: 'o/r', fetchImpl: later.f });
    assert.strictEqual(r.ok, true);
    assert.strictEqual((r as any).autoMerge, true);
});

await check('Approve click without a reviewed commit (older requests) behaves as before', async () => {
    const { f, calls } = fakeGh(B);
    const r = await approveAndMergePr({ prNumber: 5, token: 't', repo: 'o/r', fetchImpl: f });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.find((c) => c.url.endsWith('/merge'))!.body.sha, undefined);
});

await check('both ask-approval scripts run the gate; the Approve card shows it', () => {
    for (const p of ['scripts/fix-tickets.ts', 'scripts/feature-requests.ts']) {
        const src = readFileSync(p, 'utf8');
        const i = src.indexOf('prGate(m[1], arg(rest, \'--override-review\'))');
        assert.ok(i !== -1, `${p} must call prGate in ask-approval`);
        assert.ok(src.indexOf('approvalNoteWithReview(gate, why)', i) !== -1, `${p} must put the gate summary in the note`);
    }
    const html = readFileSync('admin.html', 'utf8');
    assert.ok(html.includes('it.approvalNote ? _approvalNoteHtml(it.approvalNote)'));
    assert.ok(html.includes('data-review-gate'));
    assert.ok(html.includes('Merges the commit you were shown now if its checks have passed'), 'the card must not promise auto-merge for a pinned PR');
    const agent = readFileSync('.claude/agents/code-reviewer.md', 'utf8');
    assert.match(agent, /^model: claude-opus-5-5$/m, 'owner D3: Opus 5.5 for every review');
    assert.match(agent, /record-review <pr> --sha/);
});

console.log(`\npr-review: ${passed} passed`);
})();
